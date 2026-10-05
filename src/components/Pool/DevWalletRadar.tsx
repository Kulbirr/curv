import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from './usePoolData';
import { relativeTime } from './relativeTime';

/**
 * Dev Wallet Radar: checkable facts about the creator's wallet on this
 * pool. Facts only, no verdicts: the panel states what the dev holds
 * and what they moved, the user judges. A fact the API could not
 * establish comes back null and the row is omitted, never guessed.
 * Renders nothing when the lookup fails outright.
 */

interface DevActivityOut {
  buys: number;
  sells: number;
  netQuoteUi: string;
}

interface DevMoveOut {
  id: number;
  side: 'buy' | 'sell';
  quoteUi: string;
  supplyPct: number | null;
  tradedAt: number;
  txSignature: string;
}

interface DevRadarResponse {
  poolAddress: string;
  devWallet: string;
  baseSymbol: string;
  quoteSymbol: string;
  quoteDecimals: number;
  supplyPct: number | null;
  balanceUi: string | null;
  activity1h: DevActivityOut | null;
  activity24h: DevActivityOut | null;
  moves: DevMoveOut[];
  balanceDelta24h: { pctPoints: number; direction: 'inflow' | 'outflow' | 'flat' } | null;
  updatedAt: number;
}

function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

function fmtPct(p: number): string {
  return p >= 10 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(3);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy dev wallet address"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/5 hover:text-neutral-200"
    >
      {copied ? (
        <span className="text-xs text-primary">Copied</span>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function MoveRow({ move, quoteSymbol, now }: { move: DevMoveOut; quoteSymbol: string; now: number }) {
  const [open, setOpen] = useState(false);
  const isSell = move.side === 'sell';
  const big = move.supplyPct !== null && move.supplyPct >= 1;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex min-h-[44px] w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-white/[3%] ${
          big ? 'border-l-2 border-primary/60 pl-3' : 'border-l-2 border-transparent pl-3'
        }`}
      >
        <span
          aria-hidden="true"
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs ${
            isSell ? 'bg-white/5 text-neutral-300' : 'bg-primary/10 text-primary'
          }`}
        >
          {isSell ? '▼' : '▲'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-neutral-100">
            {isSell ? 'Sold' : 'Bought'}{' '}
            {move.supplyPct !== null ? `${fmtPct(move.supplyPct)}% of supply` : 'tokens'}
            <span className="text-neutral-500"> ({move.quoteUi} {quoteSymbol})</span>
          </span>
          <span className="block text-xs text-neutral-500">{relativeTime(move.tradedAt, now)}</span>
        </span>
      </button>
      {open && (
        <div className="pb-2 pl-12 pr-2">
          <a
            href={`https://solscan.io/tx/${move.txSignature}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center gap-1 text-xs text-primary hover:underline"
          >
            View transaction
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <section className="sc-pool-info-card" aria-label="Dev wallet loading">
      <div className="sc-trade-card-label">Dev wallet</div>
      <div className="animate-pulse">
        <div className="h-8 w-32 rounded bg-white/10" />
        <div className="mt-3 h-1 w-full rounded bg-white/10" />
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div className="h-10 rounded bg-white/10" />
          <div className="h-10 rounded bg-white/10" />
        </div>
        <div className="mt-3 h-10 rounded bg-white/10" />
      </div>
    </section>
  );
}

export default function DevWalletRadar({ poolAddress }: { poolAddress: string }) {
  const query = useQuery<DevRadarResponse>({
    queryKey: ['pool-dev-radar', poolAddress],
    queryFn: () => fetchJson<DevRadarResponse>(`/api/pools/${poolAddress}/dev-radar`),
    enabled: !!poolAddress,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  if (query.isLoading) return <Skeleton />;
  const d = query.data;
  if (!d) return null;

  const now = Date.now();
  const updatedAgo = relativeTime(d.updatedAt, now);
  const net24 = d.activity24h;

  // Off-curve row: balance fell with no matching recent sells in the feed.
  const showOffCurve =
    d.balanceDelta24h !== null &&
    d.balanceDelta24h.direction === 'outflow' &&
    d.balanceDelta24h.pctPoints <= -0.5;

  return (
    <section className="sc-pool-info-card sc-dev-radar" aria-label="Dev wallet facts">
      <div className="sc-trade-card-label">Dev wallet</div>

      <div className="flex items-center justify-between gap-2">
        <span className="sc-mono text-neutral-300">{shortAddress(d.devWallet)}</span>
        <span className="flex items-center gap-1">
          <CopyButton text={d.devWallet} />
          <a
            href={`https://solscan.io/account/${d.devWallet}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View dev wallet on Solscan"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/5 hover:text-neutral-200"
          >
            <span aria-hidden="true" className="text-sm">↗</span>
          </a>
        </span>
      </div>

      {d.supplyPct !== null && (
        <div className="mt-2">
          <p className="sc-number text-3xl font-bold text-neutral-100">
            {fmtPct(d.supplyPct)}
            <span className="text-lg text-neutral-400">%</span>
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            of supply held
            {d.balanceUi !== null && (
              <span className="text-neutral-600"> · {d.balanceUi} {d.baseSymbol}</span>
            )}
          </p>
          <div className="sc-progress mt-2" role="presentation">
            <span style={{ width: `${Math.min(100, Math.max(0, d.supplyPct))}%` }} />
          </div>
        </div>
      )}

      {(d.activity1h || d.activity24h || net24) && (
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-3">
          {d.activity1h && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                Last 1h
              </p>
              <p className="sc-number mt-1 text-sm text-neutral-200">
                {d.activity1h.buys} buys · {d.activity1h.sells} sells
              </p>
            </div>
          )}
          {d.activity24h && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                Last 24h
              </p>
              <p className="sc-number mt-1 text-sm text-neutral-200">
                {d.activity24h.buys} buys · {d.activity24h.sells} sells
              </p>
            </div>
          )}
          {net24 && (
            <div className="col-span-2 md:col-span-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                Net 24h
              </p>
              <p className="sc-number mt-1 text-sm text-neutral-200">
                {net24.netQuoteUi} {d.quoteSymbol}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="mt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Recent moves
        </p>
        <div className="mt-2 space-y-1">
          {showOffCurve && (
            <div className="flex min-h-[44px] items-center gap-3 rounded-md border-l-2 border-primary/60 bg-white/[2%] px-3 py-2">
              <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/5 text-xs text-neutral-300">
                ⇄
              </span>
              <span className="text-[13px] text-neutral-200">
                Dev moved {fmtPct(Math.abs(d.balanceDelta24h!.pctPoints))}% of supply off curve
                <span className="block text-xs text-neutral-500">no swap recorded in 24h</span>
              </span>
            </div>
          )}
          {d.moves.map((m) => (
            <MoveRow key={m.id} move={m} quoteSymbol={d.quoteSymbol} now={now} />
          ))}
          {d.moves.length === 0 && !showOffCurve && (
            <p className="py-2 text-[13px] text-neutral-500">No dev moves yet.</p>
          )}
        </div>
      </div>

      <p className="mt-3 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-neutral-600">
        Balance from associated token account · updated {updatedAgo}
      </p>
    </section>
  );
}
