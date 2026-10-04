import { useQuery } from '@tanstack/react-query';
import { BN } from '@coral-xyz/anchor';
import { fetchJson } from './usePoolData';
import { formatFeeRaw } from '@/lib/claim-creator-fees';
import { rawToUi } from '@/lib/swap-math';

/**
 * Trust panel: checkable facts about this pool, no scores and no
 * labels. Every row is backed by the registry, the indexer, or a
 * direct chain read served by /api/pools/[address]/trust. A fact the
 * API could not establish comes back null and the row is omitted,
 * never guessed. The panel renders nothing until facts arrive, so a
 * failed lookup never shows a half empty box of claims.
 */

interface TrustResponse {
  verified: boolean;
  creator: string;
  createdAt: number;
  baseSymbol: string;
  quoteSymbol: string;
  graduated: boolean;
  mintAuthority: 'none' | 'held' | null;
  freezeAuthority: 'none' | 'held' | null;
  /** Optional dev buy in quote lamports, disclosed by the creator at launch. */
  devBuyLamports: number | null;
  /** Buyback and burn commitment in bps (0-10000). 0 = off. */
  buybackBps: number;
  /** Quote decimals for rendering the dev buy amount. Null when unknown. */
  quoteDecimals: number | null;
  lock: { allLocked: boolean; positionCount: number } | null;
  creatorFeesUnclaimed: {
    baseRaw: string | null;
    quoteRaw: string | null;
    baseDecimals: number;
    quoteDecimals: number;
  } | null;
  activity24h: { buys: number; sells: number } | null;
  feeSplits: {
    recipients: Array<{ wallet?: string; bps: number; handle?: string }>;
    creatorRemainderBps: number;
  } | null;
}

function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

/**
 * Dev buy display amount (quote UI units) for the trust panel banner.
 * Null when there is no dev buy to show: missing amount, zero, or
 * unknown quote decimals. Pure so it is unit-testable without a DOM.
 */
export function devBuyDisplay(
  devBuyLamports: number | null | undefined,
  quoteDecimals: number | null | undefined,
): string | null {
  if (devBuyLamports == null || devBuyLamports <= 0 || quoteDecimals == null) return null;
  return rawToUi(new BN(String(devBuyLamports)), quoteDecimals);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

interface BurnStats {
  totalBurns: number;
  lastBurnAt: number | null;
}

function BurnStatsDisplay({ poolAddress }: { poolAddress: string }) {
  const query = useQuery<{ stats: BurnStats }>({
    queryKey: ['pool-burns', poolAddress],
    queryFn: () => fetchJson<{ stats: BurnStats }>(`/api/pools/${poolAddress}/burns`),
    enabled: !!poolAddress,
    staleTime: 60_000,
    retry: 1,
  });
  const stats = query.data?.stats;
  if (!stats || stats.totalBurns === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-white/[2%] p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Burns so far
      </p>
      <p className="mt-1 text-lg font-bold text-neutral-100">
        {stats.totalBurns} {stats.totalBurns === 1 ? 'burn' : 'burns'}
      </p>
      {stats.lastBurnAt && (
        <p className="mt-1 text-xs text-neutral-500">
          Last burn {new Date(stats.lastBurnAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </p>
      )}
    </div>
  );
}

export default function TrustPanel({ poolAddress }: { poolAddress: string }) {
  const query = useQuery<TrustResponse>({
    queryKey: ['pool-trust', poolAddress],
    queryFn: () => fetchJson<TrustResponse>(`/api/pools/${poolAddress}/trust`),
    enabled: !!poolAddress,
    staleTime: 60_000,
    retry: 1,
  });

  const t = query.data;
  if (!t) return null;

  const fees = t.creatorFeesUnclaimed;
  const baseFee = fees ? formatFeeRaw(fees.baseRaw, fees.baseDecimals) : null;
  const quoteFee = fees ? formatFeeRaw(fees.quoteRaw, fees.quoteDecimals) : null;
  const launched = new Date(t.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const devBuy = devBuyDisplay(t.devBuyLamports, t.quoteDecimals);

  return (
    <section className="sc-pool-info-card sc-trust-panel" aria-label="Pool facts">
      <div className="sc-trade-card-label">Facts, checked</div>
      {devBuy !== null && (
        <div className="mb-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
          <div className="flex items-center gap-2">
            <span className="sc-section-glyph" aria-hidden="true">
              ✦
            </span>
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Dev buy
            </span>
          </div>
          <p className="mt-2 text-xl font-bold text-primary">
            {devBuy} {t.quoteSymbol}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            The creator bought this in the launch flow. It is public from
            block one.
          </p>
        </div>
      )}
      {t.buybackBps > 0 && (
        <div className="mb-3 rounded-lg border border-[#32f27b]/40 bg-[#32f27b]/5 p-4">
          <div className="flex items-center gap-2">
            <span className="sc-section-glyph" aria-hidden="true">
              ♻
            </span>
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Buyback and burn
            </span>
          </div>
          <p className="mt-2 text-xl font-bold text-[#32f27b]">
            {(t.buybackBps / 100).toFixed(0)}% of creator fees
          </p>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            Automatically buys back and burns the token. Locked at launch,
            every trade makes the supply scarcer.
          </p>
          <BurnStatsDisplay poolAddress={poolAddress} />
        </div>
      )}
      <Row label="Launch record">
        {t.verified ? 'Matched the chain at launch' : 'Not verified at launch'}
      </Row>
      <Row label="Creator">
        <span className="sc-mono">{shortAddress(t.creator)}</span>
      </Row>
      <Row label="Launched">{launched}</Row>
      <Row label="Pair">
        {t.baseSymbol} / {t.quoteSymbol}
        {t.graduated ? ' · DAMM v2' : ' · bonding curve'}
      </Row>
      {t.mintAuthority !== null && (
        <Row label="Mint authority">
          {t.mintAuthority === 'none' ? 'None, supply is fixed' : 'Held, supply can grow'}
        </Row>
      )}
      {t.freezeAuthority !== null && (
        <Row label="Freeze authority">
          {t.freezeAuthority === 'none' ? 'None, wallets cannot be frozen' : 'Held'}
        </Row>
      )}
      <Row label="Liquidity">
        {t.graduated
          ? t.lock
            ? t.lock.allLocked
              ? 'Locked permanently in DAMM v2'
              : 'In DAMM v2, lock not fully verified'
            : 'In DAMM v2'
          : 'Locks permanently at graduation'}
      </Row>
      {fees && (baseFee !== null || quoteFee !== null) && (
        <Row label="Creator fees unclaimed">
          {[baseFee ? `${baseFee} ${t.baseSymbol}` : null, quoteFee ? `${quoteFee} ${t.quoteSymbol}` : null]
            .filter(Boolean)
            .join(' · ')}
        </Row>
      )}
      {t.activity24h && (
        <Row label="Activity, 24h est">
          {t.activity24h.buys} buys · {t.activity24h.sells} sells
        </Row>
      )}
      {t.feeSplits && (
        <Row label="Fee splits">
          {[
            `Creator ${(t.feeSplits.creatorRemainderBps / 100).toFixed(2)}%`,
            ...t.feeSplits.recipients.map(
              (r) =>
                `${(r.bps / 100).toFixed(2)}% ${r.handle ? `@${r.handle}` : r.wallet ? shortAddress(r.wallet) : 'unbound'}`,
            ),
          ].join(' · ')}
        </Row>
      )}
    </section>
  );
}
