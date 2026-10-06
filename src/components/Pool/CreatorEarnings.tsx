import { useEffect, useMemo, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getConnection, isDevnet } from '@/lib/solana';
import { fetchJson } from './usePoolData';
import {
  claimCreatorFeesFlow,
  formatFeeRaw,
  getCreatorMigrationFeeWithdrawn,
  hasNoAccruedFees,
  shouldShowCreatorEarnings,
  withdrawCreatorMigrationFeeFlow,
} from '@/lib/claim-creator-fees';
import { claimAndSplitFlow, planBuyback, planBounty, planDistribution, planDuelForfeit } from '@/lib/fee-split-claim';
import type { DuelForfeitPlan } from '@/lib/fee-split-claim';
import { formatRawAmount } from '@/components/Bounty/amounts';
import { shortWallet, type Duel } from '../Duel/duel';
import type { EffectiveFeeSplitRecipient, FeeSplitBinding } from '@/lib/fee-split-terms';
import type { PoolStateResponse } from './types';
import type { TrackedPool } from '@/lib/pool-registry';

interface FeeSplitsResponse {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  configAddress: string;
  creator: string;
  recipients: EffectiveFeeSplitRecipient[];
  bindings: FeeSplitBinding[];
  creatorRemainderBps: number;
}

type Status = 'idle' | 'signing' | 'sending' | 'confirming' | 'confirmed' | 'failed';

type MigrationStatus = 'checking' | 'ready' | 'claimed' | 'unknown';

function agoText(sampledAt: number | null, now: number): string {
  if (sampledAt === null) return 'updated at an unknown time';
  const s = Math.max(0, Math.round((now - sampledAt) / 1000));
  if (s < 60) return `updated ${s}s ago`;
  const m = Math.round(s / 60);
  return `updated ${m}m ago`;
}

/**
 * Creator earnings panel, rendered ONLY when the connected wallet is the
 * pool's creator. Everyone else sees nothing (not an error).
 *
 * Shows the 0.3% trading fees accrued on-chain in base + quote tokens and
 * a Claim button that puts the SDK's claimCreatorTradingFee transaction
 * through the same wallet-signing flow as swaps.
 */
export default function CreatorEarnings({
  poolAddress,
  state,
}: {
  poolAddress: string;
  state: PoolStateResponse;
}) {
  const { publicKey, signTransaction, signAllTransactions, connected } = useWallet();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('idle');
  const [copiedLink, setCopiedLink] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const runningRef = useRef(false);

  // Migration fee (2% at graduation): live on-chain withdraw status, only
  // relevant once the pool graduated.
  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus>('checking');
  const [migrationClaim, setMigrationClaim] = useState<Status>('idle');
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationTxSig, setMigrationTxSig] = useState<string | null>(null);
  const migrationRunningRef = useRef(false);

  const walletAddress = publicKey?.toBase58() ?? null;
  const isCreator = shouldShowCreatorEarnings({
    connected,
    walletAddress,
    creator: state.creator,
  });
  const showMigration = state.graduated;

  useEffect(() => {
    if (!isCreator || !showMigration) return;
    let cancelled = false;
    setMigrationStatus('checking');
    getCreatorMigrationFeeWithdrawn(poolAddress)
      .then((withdrawn) => {
        if (!cancelled) setMigrationStatus(withdrawn ? 'claimed' : 'ready');
      })
      .catch(() => {
        // Status unknown (RPC hiccup): still offer the claim; the chain is
        // the source of truth and rejects a double claim.
        if (!cancelled) setMigrationStatus('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, [isCreator, showMigration, poolAddress]);

  // Fee split terms for this pool (public, fixed at launch). Only the
  // creator claims; the claim transaction pays every recipient in the
  // same atomic transaction.
  const splitsQuery = useQuery<FeeSplitsResponse>({
    queryKey: ['pool-fee-splits', poolAddress],
    queryFn: () => fetchJson<FeeSplitsResponse>(`/api/pools/${poolAddress}/fee-splits`),
    enabled: isCreator,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const splits = splitsQuery.data?.recipients ?? [];
  const bindings = splitsQuery.data?.bindings ?? [];
  const hasSplits = splits.length > 0;
  const distribution = hasSplits
    ? planDistribution(state.creatorBaseFeeRaw, state.creatorQuoteFeeRaw, splits)
    : [];

  // Duel forfeit preview: if this pool lost a settled duel and the forfeit
  // window is open, the creator remainder of this claim is redirected to
  // the duel winner. The claim builder is authoritative; this mirrors its
  // math so the loser sees exactly where the money goes before signing.
  const duelListQuery = useQuery<{ duels: Duel[] }>({
    queryKey: ['duels', 'list', 50],
    queryFn: () => fetchJson<{ duels: Duel[] }>('/api/duels?limit=50'),
    enabled: isCreator,
    staleTime: 60_000,
    retry: 1,
  });
  const lostDuel = useMemo(() => {
    const duels = duelListQuery.data?.duels ?? [];
    const now = Date.now();
    return (
      duels.find(
        (d) =>
          d.status === 'settled' &&
          d.loserPool === poolAddress &&
          (d.forfeitEndsAt ?? 0) > now,
      ) ?? null
    );
  }, [duelListQuery.data, poolAddress]);
  const trustQuery = useQuery<{ buybackBps?: number; bountyBps?: number }>({
    queryKey: ['pool-trust', poolAddress],
    queryFn: () =>
      fetchJson<{ buybackBps?: number; bountyBps?: number }>(
        `/api/pools/${poolAddress}/trust`,
      ),
    enabled: isCreator && lostDuel != null,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const forfeitPreview = useMemo<{
    plan: DuelForfeitPlan;
    winner: string;
    duelId: number;
  } | null>(() => {
    if (!lostDuel || lostDuel.forfeitEndsAt == null) return null;
    const winner =
      lostDuel.winnerPool === lostDuel.poolA
        ? lostDuel.challengerWallet
        : lostDuel.challengedWallet;
    const buybackBps = Math.max(
      0,
      Math.min(10000, Math.floor(Number(trustQuery.data?.buybackBps) || 0)),
    );
    const bountyBps = Math.max(
      0,
      Math.min(10000, Math.floor(Number(trustQuery.data?.bountyBps) || 0)),
    );
    const totalRecipientBps = splits.reduce((s, r) => s + (r.bps || 0), 0);
    const creatorBps = 10000 - totalRecipientBps;
    if (creatorBps <= 0) return null;
    const buyback = planBuyback(
      state.creatorBaseFeeRaw,
      state.creatorQuoteFeeRaw,
      creatorBps,
      buybackBps,
      'preview',
    );
    const bounty = planBounty(
      state.creatorBaseFeeRaw,
      state.creatorQuoteFeeRaw,
      creatorBps,
      bountyBps,
      'preview',
    );
    const plan = planDuelForfeit(
      state.creatorBaseFeeRaw,
      state.creatorQuoteFeeRaw,
      creatorBps,
      buyback,
      bounty,
      lostDuel.id,
      winner,
      lostDuel.forfeitEndsAt,
    );
    return plan ? { plan, winner, duelId: lostDuel.id } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    lostDuel,
    trustQuery.data,
    splits,
    state.creatorBaseFeeRaw,
    state.creatorQuoteFeeRaw,
    poolAddress,
  ]);

  if (!isCreator) {
    return null;
  }

  const baseFee = formatFeeRaw(state.creatorBaseFeeRaw, state.baseDecimals ?? 9);
  const quoteFee = formatFeeRaw(state.creatorQuoteFeeRaw, state.quoteDecimals ?? 9);
  const empty = hasNoAccruedFees(state.creatorBaseFeeRaw, state.creatorQuoteFeeRaw);
  const unknown = baseFee === null || quoteFee === null;

  const claim = async () => {
    if (!publicKey || !signTransaction || runningRef.current) return;
    runningRef.current = true;
    setError(null);
    setTxSig(null);
    try {
      if (hasSplits && splitsQuery.data) {
        // One atomic claim: the transaction claims the fees and pays
        // every split recipient their published share.
        setStatus('signing');
        // Fee commitments (buyback/bounty bps) live on the pool registry;
        // the trust endpoint carries them. Without these the claim
        // builder cannot divert the slices to the vaults.
        let buybackBps = 0;
        let bountyBps = 0;
        try {
          const tr = await fetch(`/api/pools/${poolAddress}/trust`);
          if (tr.ok) {
            const tj = (await tr.json()) as { buybackBps?: number; bountyBps?: number };
            buybackBps = Math.max(0, Math.min(10000, Math.floor(Number(tj.buybackBps) || 0)));
            bountyBps = Math.max(0, Math.min(10000, Math.floor(Number(tj.bountyBps) || 0)));
          }
        } catch {
          // Trust data unavailable: claim proceeds without diversions;
          // the slices stay accrued until the next claim.
        }
        const tracked = {
          poolAddress,
          configAddress: splitsQuery.data.configAddress,
          baseMint: splitsQuery.data.baseMint,
          quoteMint: splitsQuery.data.quoteMint,
          creator: publicKey.toBase58(),
          buybackBps,
          bountyBps,
        } as TrackedPool;
        // Trader-reward winners, if decided: fetched lazily, paid
        // atomically in the same claim transaction.
        let traderRewardWinners: Array<{ wallet: string; rank: number }> | undefined;
        let traderRewardBps: number | undefined;
        try {
          const rr = await fetch(`/api/pools/${poolAddress}/trader-rewards`);
          if (rr.ok) {
            const rj = (await rr.json()) as {
              traderReward: { bps: number } | null;
              winners: Array<{ wallet: string; rank: number }> | null;
            };
            if (rj.traderReward && rj.winners && rj.winners.length > 0) {
              traderRewardWinners = rj.winners;
              traderRewardBps = rj.traderReward.bps;
            }
          }
        } catch {
          // Winners unavailable: claim proceeds without them; their
          // share stays accrued until the next claim.
        }
        const { signatures, buyback, bounty, forfeit } = await claimAndSplitFlow({
          connection: getConnection(),
          signTransaction,
          signAllTransactions: signAllTransactions ?? undefined,
          tracked,
          recipients: splits,
          bindings,
          traderRewardWinners,
          traderRewardBps,
        });
        setTxSig(signatures[0] ?? null);
        setStatus('confirmed');
        queryClient.invalidateQueries({ queryKey: ['pool-state', poolAddress] });
        queryClient.invalidateQueries({ queryKey: ['duels'] });
        queryClient.invalidateQueries({ queryKey: ['duel'] });
        // Record the buyback deposit in the per-pool ledger so the
        // keeper can attribute vault funds to this pool. The server
        // verifies the transfer on-chain; best effort, like the
        // notification below.
        try {
          if (buyback && signatures[0]) {
            await fetch(`/api/pools/${poolAddress}/buyback-deposits`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ txSignature: signatures[0] }),
            });
          }
        } catch {
          // Deposit recording failure never fails the claim.
        }
        // Record the bounty deposit the same way: the server verifies
        // the transfer on-chain from the claim transaction.
        try {
          if (bounty && signatures[0]) {
            await fetch(`/api/pools/${poolAddress}/bounty-deposits`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ txSignature: signatures[0] }),
            });
          }
        } catch {
          // Deposit recording failure never fails the claim.
        }
        // Record the duel forfeit payout the same way: the server verifies
        // the transfer to the duel winner on-chain, and the duel page
        // renders the forfeit ledger from these rows.
        try {
          if (forfeit && signatures[0]) {
            await fetch(`/api/pools/${poolAddress}/duel-forfeit-deposits`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ duelId: forfeit.duelId, txSignature: signatures[0] }),
            });
          }
        } catch {
          // Deposit recording failure never fails the claim.
        }
        // Tell each paid recipient: their share landed. Best effort,
        // idempotent per event id; the chain is the source of truth.
        try {
          await fetch('/api/notifications/emit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              kind: 'split_paid',
              poolAddress,
              signature: signatures[0] ?? '',
              payouts: splits
                .filter((r) => r.effectiveWallet)
                .map((r) => ({
                  wallet: r.effectiveWallet,
                  handle: r.handle ?? undefined,
                  bps: r.bps,
                })),
            }),
          });
        } catch {
          // Notification failure never fails the claim.
        }
        return;
      }
      const sig = await claimCreatorFeesFlow({
        connection: getConnection(),
        signTransaction,
        poolAddress,
        creator: publicKey.toBase58(),
        onStatus: (s) => setStatus(s),
      });
      setTxSig(sig);
      setStatus('confirmed');
      // The next indexer sample zeroes the accrued fees; refresh promptly.
      queryClient.invalidateQueries({ queryKey: ['pool-state', poolAddress] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claim failed');
      setStatus('failed');
    } finally {
      runningRef.current = false;
    }
  };

  const busy = status === 'signing' || status === 'sending' || status === 'confirming';
  const statusText =
    status === 'signing'
      ? 'Waiting for wallet signature…'
      : status === 'sending'
        ? 'Sending transaction…'
        : status === 'confirming'
          ? 'Confirming on-chain…'
          : null;

  const claimMigrationFee = async () => {
    if (!publicKey || !signTransaction || migrationRunningRef.current) return;
    migrationRunningRef.current = true;
    setMigrationError(null);
    setMigrationTxSig(null);
    try {
      const sig = await withdrawCreatorMigrationFeeFlow({
        connection: getConnection(),
        signTransaction,
        poolAddress,
        creator: publicKey.toBase58(),
        onStatus: (s) => setMigrationClaim(s),
      });
      setMigrationTxSig(sig);
      setMigrationClaim('confirmed');
      setMigrationStatus('claimed');
    } catch (e) {
      setMigrationError(e instanceof Error ? e.message : 'Claim failed');
      setMigrationClaim('failed');
    } finally {
      migrationRunningRef.current = false;
    }
  };

  const migrationBusy =
    migrationClaim === 'signing' ||
    migrationClaim === 'sending' ||
    migrationClaim === 'confirming';
  const migrationStatusText =
    migrationClaim === 'signing'
      ? 'Waiting for wallet signature…'
      : migrationClaim === 'sending'
        ? 'Sending transaction…'
        : migrationClaim === 'confirming'
          ? 'Confirming on-chain…'
          : null;

  return (
    <section className="sc-creator-earnings-panel" aria-labelledby="sc-creator-earnings-title">
      <div className="sc-creator-earnings-head">
        <h2 id="sc-creator-earnings-title">Creator earnings</h2>
        <span>Creator-only</span>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 12, color: '#778179' }}>
        Your 0.3% of every trade on this pool
      </p>

      {unknown ? (
        <p style={{ margin: '14px 0 0', fontSize: 10, lineHeight: 1.6, color: '#8c968d' }}>
          Earnings data has not been indexed for this pool yet. It appears after the next
          indexer sample.
        </p>
      ) : empty ? (
        <p style={{ margin: '14px 0 0', fontSize: 10, lineHeight: 1.6, color: '#8c968d' }}>
          No fees accrued yet. You earn 0.3% of every trade once trading starts.
        </p>
      ) : (
        <dl className="sc-creator-earnings-balances">
          <div>
            <dt>Base token</dt>
            <dd>
              {baseFee} {state.baseSymbol}
            </dd>
          </div>
          <div>
            <dt>Quote token</dt>
            <dd>
              {quoteFee} {state.quoteSymbol}
            </dd>
          </div>
        </dl>
      )}

      {hasSplits && distribution.length > 0 && (
        <div className="sc-split-plan" aria-label="Fee split distribution">
          <div className="sc-trade-card-label">Pays out with this claim</div>
          {distribution.map((p) => {
            const b = formatFeeRaw(p.baseRaw, state.baseDecimals ?? 9);
            const q = formatFeeRaw(p.quoteRaw, state.quoteDecimals ?? 9);
            return (
              <div key={p.wallet} className="sc-split-row">
                <span className="sc-split-who">
                  {p.handle ? `@${p.handle}` : `${p.wallet.slice(0, 4)}…${p.wallet.slice(-4)}`}
                </span>
                <span className="sc-split-share">
                  {(p.bps / 100).toFixed(2)}% ·{' '}
                  {[b ? `${b} ${state.baseSymbol}` : null, q ? `${q} ${state.quoteSymbol}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {hasSplits &&
        (() => {
          const waiting = splits.filter((r) => r.handle && !r.wallet && !r.effectiveWallet);
          if (waiting.length === 0) return null;
          return (
            <div
              role="status"
              style={{
                border: '1px solid #d08a5f55',
                background: '#d08a5f11',
                borderRadius: 10,
                padding: '10px 12px',
                marginTop: 12,
                fontSize: 12,
                lineHeight: 1.5,
                color: '#e8c9a8',
              }}
            >
              <strong style={{ color: '#d08a5f' }}>
                {waiting.length === 1
                  ? `${waiting[0].handle ? `@${waiting[0].handle}` : 'A collaborator'} hasn't bound a wallet yet`
                  : `${waiting.length} collaborators haven't bound wallets yet`}
              </strong>
              <br />
              Their shares stay in the pool until they open their invite
              link and complete verification. Share their invite
              links below so they can claim.
            </div>
          );
        })()}

      {hasSplits && (
        <div className="sc-split-plan" aria-label="Invite collaborators">
          <div className="sc-trade-card-label">Invite collaborators to claim their shares</div>
          <p className="sc-fee-split-note">
            Share each link with the right person. If they gave a wallet at launch it is already
            locked in. With just an X handle, they post a tweet with their claim code and wallet
            address, and we bind the wallet named in the tweet. A binding cannot be changed later.
          </p>
          {splits.map((r, i) => {
            const link = `${typeof window !== 'undefined' ? window.location.origin : ''}/claim/onboard/${poolAddress}/${i}`;
            const label = r.handle ? `@${r.handle}` : r.wallet ? `${r.wallet.slice(0, 4)}…${r.wallet.slice(-4)}` : `Entry ${i + 1}`;
            return (
              <div key={i} className="sc-split-row">
                <span className="sc-split-who">
                  {label} · {(r.bps / 100).toFixed(2)}%
                  {r.bound || r.wallet ? ' · bound' : ' · waiting for wallet'}
                </span>
                <button
                  type="button"
                  className="sc-button sc-button-ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(link).then(() => {
                      setCopiedLink(i);
                      setTimeout(() => setCopiedLink((cur) => (cur === i ? null : cur)), 2000);
                    });
                  }}
                >
                  {copiedLink === i ? 'Copied' : 'Copy invite link'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {forfeitPreview && hasSplits && !empty && !unknown && (
        <div
          role="alert"
          aria-label="Duel forfeit warning"
          style={{
            border: '2px solid #fa6d74',
            background: '#fa6d7414',
            borderRadius: 12,
            padding: '12px 14px',
            marginTop: 12,
          }}
        >
          <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: '#fa6d74', letterSpacing: '0.08em' }}>
            DUEL FORFEIT
          </p>
          <p style={{ margin: '6px 0 0', fontSize: 14, fontWeight: 700, color: '#f3d9db' }}>
            {formatRawAmount(
              forfeitPreview.plan.quoteRaw,
              state.quoteDecimals ?? 9,
              state.quoteSymbol,
            )}{' '}
            goes to the duel winner, not you
          </p>
          <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.6, color: '#c9a3a6' }}>
            You lost duel #{forfeitPreview.duelId}. Your creator remainder from this
            claim goes to {shortWallet(forfeitPreview.winner)} instead of your wallet.
            Fee splits, buyback and bounty are paid first and are untouched.
          </p>
        </div>
      )}

      {!unknown && !empty && (
        <div className="sc-creator-earnings-actions">
          <span>
            {agoText(state.sampledAt, Date.now())}
            {state.stale ? ' · showing last known values' : ''}
          </span>
          <button
            type="button"
            onClick={claim}
            disabled={busy}
            className="sc-button sc-button-primary"
          >
            {busy ? statusText : hasSplits ? 'Claim and distribute' : 'Claim earnings'}
          </button>
        </div>
      )}

      {status === 'confirmed' && txSig && (
        <p className="sc-creator-claim-message">
          {hasSplits ? 'Claimed and distributed.' : 'Claimed.'}{' '}
          <a
            href={`https://solscan.io/tx/${txSig}${isDevnet() ? '?cluster=devnet' : ''}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: '#c4f0c8', textDecoration: 'underline' }}
          >
            View transaction
          </a>
        </p>
      )}
      {status === 'failed' && error && <p className="sc-trade-message">{error}</p>}

      {showMigration && (
        <div className="sc-creator-migration" style={{ marginTop: 18 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 11, color: '#c4f0c8' }}>
            Migration fee
          </h3>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: '#778179' }}>
            Your 2% of the migration fee from this pool&apos;s graduation
          </p>

          {migrationStatus === 'checking' ? (
            <p style={{ margin: 0, fontSize: 10, color: '#8c968d' }}>
              Checking migration fee…
            </p>
          ) : migrationStatus !== 'claimed' ? (
            <div className="sc-creator-earnings-actions">
              <span>
                {migrationStatus === 'unknown'
                  ? 'Status unavailable, claimable on-chain'
                  : 'Ready to claim'}
              </span>
              <button
                type="button"
                onClick={claimMigrationFee}
                disabled={migrationBusy}
                className="sc-button sc-button-primary"
              >
                {migrationBusy ? migrationStatusText : 'Claim migration fee'}
              </button>
            </div>
          ) : migrationClaim !== 'confirmed' ? (
            <p style={{ margin: 0, fontSize: 10, color: '#8c968d' }}>
              Migration fee claimed.
            </p>
          ) : null}

          {migrationClaim === 'confirmed' && migrationTxSig && (
            <p className="sc-creator-claim-message">
              Claimed.{' '}
              <a
                href={`https://solscan.io/tx/${migrationTxSig}${isDevnet() ? '?cluster=devnet' : ''}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#c4f0c8', textDecoration: 'underline' }}
              >
                View transaction
              </a>
            </p>
          )}
          {migrationClaim === 'failed' && migrationError && (
            <p className="sc-trade-message">{migrationError}</p>
          )}
        </div>
      )}

      <p
        style={{
          margin: '10px 0 0',
          fontSize: 10,
          lineHeight: 1.6,
          color: '#5f6a60',
        }}
      >
        Claiming sends a transaction you sign in your wallet. Trading fees land in your
        wallet in the tokens they accrued in. The migration fee lands in your wallet in
        quote tokens.
      </p>
    </section>
  );
}
