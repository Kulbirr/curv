import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import bs58 from 'bs58';
import { buildDuelActionMessage } from '@/lib/signature-messages';
import { fetchJson } from '@/components/Pool/usePoolData';
import { DuelCoinAvatar, VsMedallion } from './DuelBits';
import { shortWallet } from './duel';
import { cn } from '@/lib/utils';

interface PoolSummary {
  poolAddress: string;
  baseSymbol: string;
  baseName: string;
  imageUrl: string | null;
  creator: string;
  progress: number | null;
  graduated: boolean;
}

interface PoolsResponse {
  pools: PoolSummary[];
}

function PoolRow({
  pool,
  selected,
  onSelect,
}: {
  pool: PoolSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const duelQuery = useQuery({
    queryKey: ['pool-duel', pool.poolAddress],
    queryFn: () =>
      fetchJson<{ duel: { id: number } | null }>(`/api/pools/${pool.poolAddress}/duel`),
    staleTime: 60_000,
    retry: 1,
  });
  const dueling = !!duelQuery.data?.duel;
  const disabled = dueling || duelQuery.isError;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex min-h-[64px] w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition',
        selected
          ? 'border-[#32f27b]/60 bg-[#32f27b]/[0.07]'
          : 'border-white/10 bg-white/[0.02] hover:border-white/25',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <DuelCoinAvatar imageUrl={pool.imageUrl} symbol={pool.baseSymbol} size={44} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold text-neutral-100">
          ${pool.baseSymbol}
        </span>
        <span className="block truncate text-xs text-neutral-500">{pool.baseName}</span>
      </span>
      {dueling ? (
        <span className="text-[11px] font-bold tracking-wider text-neutral-500">IN A DUEL</span>
      ) : selected ? (
        <span className="text-[11px] font-bold tracking-wider text-[#32f27b]">PICKED</span>
      ) : null}
    </button>
  );
}

const STEPS = ['Pick your fighter', 'Review the terms', 'Sign the challenge'];

export default function ChallengeWizard({
  poolB,
  onClose,
  onCreated,
}: {
  poolB: string;
  onClose: () => void;
  onCreated: (duelId: number) => void;
}) {
  const { publicKey, signMessage, connected } = useWallet();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [poolA, setPoolA] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<number | null>(null);

  const wallet = publicKey?.toBase58() ?? null;

  const poolsQuery = useQuery({
    queryKey: ['pools', 'all-for-duel'],
    queryFn: () => fetchJson<PoolsResponse>('/api/pools?limit=500'),
    staleTime: 60_000,
    retry: 1,
    enabled: connected,
  });

  const candidates = useMemo(() => {
    const pools = poolsQuery.data?.pools ?? [];
    return pools.filter(
      (p) => p.creator === wallet && !p.graduated && p.poolAddress !== poolB,
    );
  }, [poolsQuery.data, wallet, poolB]);

  const poolBMeta = useMemo(() => {
    const pools = poolsQuery.data?.pools ?? [];
    return pools.find((p) => p.poolAddress === poolB) ?? null;
  }, [poolsQuery.data, poolB]);

  const poolAMeta = useMemo(
    () => candidates.find((p) => p.poolAddress === poolA) ?? null,
    [candidates, poolA],
  );

  const sign = async () => {
    setError(null);
    if (!connected || !publicKey || !signMessage || !poolA) {
      setError('Connect the creator wallet to sign.');
      return;
    }
    setBusy(true);
    try {
      const timestamp = Date.now();
      const message = buildDuelActionMessage(poolA, poolB, 'challenge', null, timestamp);
      const sigBytes = await signMessage(new TextEncoder().encode(message));
      const res = await fetch('/api/duels/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poolA,
          poolB,
          wallet: publicKey.toBase58(),
          timestamp,
          signature: bs58.encode(sigBytes),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        duel?: { id: number };
      };
      if (!res.ok || !j.duel) throw new Error(j.error || 'Challenge failed. Try again.');
      await queryClient.invalidateQueries({ queryKey: ['duels'] });
      setCreatedId(j.duel.id);
      onCreated(j.duel.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Challenge failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Challenge to a coin duel"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-[#0d1110] sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div>
            <p className="text-[11px] font-bold tracking-[0.25em] text-[#e8b64c]">COIN DUEL</p>
            <h2 className="mt-1 text-lg font-bold text-neutral-50">Challenge to a duel</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 text-neutral-400 transition hover:border-white/25 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>

        <div className="flex gap-2 px-6 pt-4" aria-hidden="true">
          {STEPS.map((s, i) => (
            <div key={s} className="flex-1">
              <div
                className={cn(
                  'h-1 rounded-full',
                  step > i + 1 || (createdId != null && i === 2)
                    ? 'bg-[#32f27b]'
                    : step === i + 1
                      ? 'bg-[#e8b64c]'
                      : 'bg-white/10',
                )}
              />
              <p
                className={cn(
                  'mt-1.5 text-[10px] font-bold tracking-wider',
                  step === i + 1 ? 'text-neutral-200' : 'text-neutral-600',
                )}
              >
                {s.toUpperCase()}
              </p>
            </div>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {createdId != null ? (
            <div className="flex flex-col items-center py-6 text-center">
              <VsMedallion size="lg" />
              <h3 className="mt-5 text-xl font-black text-neutral-50">Challenge sent</h3>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-neutral-400">
                {poolBMeta ? `$${poolBMeta.baseSymbol}` : 'The other'} creator has been
                notified. The race starts the moment they accept.
              </p>
              <Link
                href={`/duels/${createdId}`}
                className="mt-6 inline-flex h-12 items-center rounded-2xl bg-[#32f27b] px-8 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f]"
              >
                View the duel
              </Link>
              <button
                type="button"
                onClick={onClose}
                className="mt-3 inline-flex h-11 items-center rounded-xl px-6 text-sm font-bold text-neutral-400 transition hover:text-neutral-100"
              >
                Done
              </button>
            </div>
          ) : step === 1 ? (
            <div>
              <p className="text-sm leading-relaxed text-neutral-400">
                Pick the coin you fight with. Only coins you created, still on the curve,
                and not already dueling.
              </p>
              {!connected ? (
                <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-neutral-300">
                  Connect the creator wallet to pick your fighter.
                </p>
              ) : poolsQuery.isLoading ? (
                <div className="mt-4 space-y-2">
                  {[0, 1].map((i) => (
                    <div key={i} className="h-16 animate-pulse rounded-2xl bg-white/[0.04]" />
                  ))}
                </div>
              ) : candidates.length === 0 ? (
                <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-relaxed text-neutral-300">
                  No eligible coins. You need a coin you created that has not graduated
                  yet and is not already in a duel.
                </p>
              ) : (
                <div className="mt-4 space-y-2">
                  {candidates.map((p) => (
                    <PoolRow
                      key={p.poolAddress}
                      pool={p}
                      selected={poolA === p.poolAddress}
                      onSelect={() => setPoolA(p.poolAddress)}
                    />
                  ))}
                </div>
              )}
              {error && (
                <p role="alert" className="mt-3 text-sm text-[#fa6d74]">
                  {error}
                </p>
              )}
              <div className="mt-5 flex justify-end">
                <button
                  type="button"
                  disabled={!poolA}
                  onClick={() => setStep(2)}
                  className="inline-flex h-12 items-center rounded-2xl bg-[#32f27b] px-8 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-40"
                >
                  Continue
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-5">
                <div className="flex flex-1 flex-col items-center gap-2 text-center">
                  <DuelCoinAvatar
                    imageUrl={poolAMeta?.imageUrl ?? null}
                    symbol={poolAMeta?.baseSymbol ?? '?'}
                    size={56}
                  />
                  <p className="text-sm font-bold text-neutral-100">
                    ${poolAMeta?.baseSymbol ?? '…'}
                  </p>
                  <p className="text-[11px] text-neutral-500">Your fighter</p>
                </div>
                <VsMedallion />
                <div className="flex flex-1 flex-col items-center gap-2 text-center">
                  <DuelCoinAvatar
                    imageUrl={poolBMeta?.imageUrl ?? null}
                    symbol={poolBMeta?.baseSymbol ?? '?'}
                    size={56}
                  />
                  <p className="text-sm font-bold text-neutral-100">
                    ${poolBMeta?.baseSymbol ?? '…'}
                  </p>
                  <p className="text-[11px] text-neutral-500">The challenged</p>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-[#e8b64c]/25 bg-[#e8b64c]/[0.04] px-5 py-4">
                <p className="text-[11px] font-bold tracking-[0.2em] text-[#e8b64c]">
                  THE TERMS, LOCKED ON ACCEPT
                </p>
                <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-neutral-300">
                  <li>First coin to graduate wins. No judges, no votes.</li>
                  <li>The winner takes the loser creator fees for 90 days after graduation.</li>
                  <li>Fee splits promised to others are always paid in full.</li>
                  <li>Buyback and bounty commitments made at launch are paid before any forfeit.</li>
                  <li>The other creator must accept. Nobody is forced into a duel.</li>
                </ul>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-neutral-500">
                The forfeit lands when the loser claims. If the loser never claims during
                the window, the winner receives nothing. Signing is free.
              </p>
              {error && (
                <p role="alert" className="mt-3 text-sm text-[#fa6d74]">
                  {error}
                </p>
              )}
              <div className="mt-5 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="inline-flex h-12 items-center rounded-2xl border border-white/15 px-6 text-sm font-bold text-neutral-300 transition hover:border-white/30"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={busy || !poolA}
                  onClick={() => void sign()}
                  className="inline-flex h-12 flex-1 items-center justify-center rounded-2xl bg-[#e8b64c] px-8 text-sm font-black text-[#1a1408] transition hover:brightness-110 disabled:opacity-60 sm:flex-none"
                >
                  {busy ? 'Waiting for wallet signature…' : 'Sign the challenge'}
                </button>
              </div>
              <p className="mt-2 text-center text-[11px] text-neutral-600">
                Signed by {wallet ? shortWallet(wallet) : 'your wallet'} · free, no tokens move
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
