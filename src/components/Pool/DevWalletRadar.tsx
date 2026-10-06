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
 *
 * Layout note: everything below the eyebrow label lives inside a single
 * `.dwr` wrapper. The global `.sc-pool-info-card > div` rule only ever
 * reaches `.dwr` itself (reset by the override in curv-spec.css), so the
 * inner layout is immune to it. Never add another bare div as a direct
 * child of the section.
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
      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-white/5 hover:text-neutral-200 active:bg-white/10"
    >
      {copied ? (
        <span className="text-xs font-medium text-primary">Copied</span>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
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
    <div className={big ? 'dwr-row-big' : undefined}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="dwr-row"
      >
        <span
          aria-hidden="true"
          className={`dwr-glyph ${isSell ? 'dwr-glyph-sell' : 'dwr-glyph-buy'}`}
        >
          {isSell ? '▼' : '▲'}
        </span>
        <span className="dwr-row-main">
          <span className="dwr-row-title">
            {isSell ? 'Sold' : 'Bought'}{' '}
            {move.supplyPct !== null ? `${fmtPct(move.supplyPct)}% of supply` : 'tokens'}
            <span className="dwr-row-sub-inline"> ({move.quoteUi} {quoteSymbol})</span>
          </span>
          <span className="dwr-row-time">{relativeTime(move.tradedAt, now)}</span>
        </span>
        <span aria-hidden="true" className={`dwr-chevron ${open ? 'dwr-chevron-open' : ''}`}>
          ›
        </span>
      </button>
      {open && (
        <div className="dwr-tx">
          <a
            href={`https://solscan.io/tx/${move.txSignature}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center gap-1 text-xs font-medium text-primary hover:underline"
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
    <section className="sc-pool-info-card sc-dev-radar" aria-label="Dev wallet loading">
      <div className="sc-trade-card-label">Dev wallet</div>
      <div className="dwr">
        <div className="animate-pulse">
          <div className="flex items-center justify-between">
            <div className="h-4 w-28 rounded bg-white/10" />
            <div className="flex gap-2">
              <div className="h-11 w-11 rounded-lg bg-white/10" />
              <div className="h-11 w-11 rounded-lg bg-white/10" />
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-white/5 p-4">
            <div className="h-10 w-36 rounded bg-white/10" />
            <div className="mt-3 h-1 w-full rounded bg-white/10" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="h-12 rounded bg-white/10" />
            <div className="h-12 rounded bg-white/10" />
            <div className="h-12 rounded bg-white/10" />
          </div>
          <div className="mt-4 space-y-2">
            <div className="h-14 rounded bg-white/10" />
            <div className="h-14 rounded bg-white/10" />
          </div>
        </div>
      </div>
    </section>
  );
}

function StatCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="dwr-stat">
      <p className="dwr-stat-label">{label}</p>
      <p className="dwr-stat-value sc-number">{children}</p>
    </div>
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

  // Off curve row: balance fell with no matching recent sells in the feed.
  const showOffCurve =
    d.balanceDelta24h !== null &&
    d.balanceDelta24h.direction === 'outflow' &&
    d.balanceDelta24h.pctPoints <= -0.5;

  const hasStats = d.activity1h !== null || d.activity24h !== null;

  return (
    <section className="sc-pool-info-card sc-dev-radar" aria-label="Dev wallet facts">
      <div className="sc-trade-card-label">Dev wallet</div>
      <div className="dwr">
        {/* Header: address plus actions */}
        <div className="dwr-head">
          <span className="sc-mono dwr-addr" title={d.devWallet}>
            {shortAddress(d.devWallet)}
          </span>
          <span className="dwr-actions">
            <CopyButton text={d.devWallet} />
            <a
              href={`https://solscan.io/account/${d.devWallet}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View dev wallet on Solscan"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-white/5 hover:text-neutral-200 active:bg-white/10"
            >
              <span aria-hidden="true" className="text-base leading-none">↗</span>
            </a>
          </span>
        </div>

        {/* Supply hero: the visual anchor */}
        {d.supplyPct !== null && (
          <div className="dwr-hero">
            <p className="dwr-hero-pct sc-number">
              {fmtPct(d.supplyPct)}
              <span className="dwr-hero-pct-unit">%</span>
            </p>
            <p className="dwr-hero-cap">of supply held</p>
            <div className="sc-progress dwr-bar" role="presentation">
              <span style={{ width: `${Math.min(100, Math.max(0, d.supplyPct))}%` }} />
            </div>
            {d.balanceUi !== null && (
              <p className="dwr-hero-bal">
                {d.balanceUi} {d.baseSymbol} in associated account
              </p>
            )}
          </div>
        )}

        {/* Activity strip: compact 3 column row, never wraps */}
        {hasStats && (
          <div className="dwr-stats">
            <StatCell label="Last 1h">
              {d.activity1h ? (
                <>{d.activity1h.buys} buys<br />{d.activity1h.sells} sells</>
              ) : (
                <span className="dwr-stat-na">no data</span>
              )}
            </StatCell>
            <StatCell label="Last 24h">
              {d.activity24h ? (
                <>{d.activity24h.buys} buys<br />{d.activity24h.sells} sells</>
              ) : (
                <span className="dwr-stat-na">no data</span>
              )}
            </StatCell>
            <StatCell label="Net 24h">
              {d.activity24h ? (
                <>{d.activity24h.netQuoteUi} {d.quoteSymbol}</>
              ) : (
                <span className="dwr-stat-na">no data</span>
              )}
            </StatCell>
          </div>
        )}

        {/* Moves feed */}
        <div className="dwr-feed">
          <p className="dwr-feed-label">Recent moves</p>
          <div className="dwr-rows">
            {showOffCurve && (
              <div className="dwr-offcurve">
                <span aria-hidden="true" className="dwr-glyph dwr-glyph-off">⇄</span>
                <span className="dwr-offcurve-text">
                  Dev moved {fmtPct(Math.abs(d.balanceDelta24h!.pctPoints))}% of supply off curve
                  <span className="dwr-offcurve-sub">no swap recorded in 24h</span>
                </span>
              </div>
            )}
            {d.moves.map((m) => (
              <MoveRow key={m.id} move={m} quoteSymbol={d.quoteSymbol} now={now} />
            ))}
            {d.moves.length === 0 && !showOffCurve && (
              <p className="dwr-empty">No dev moves yet.</p>
            )}
          </div>
        </div>

        <p className="dwr-foot">
          Balance from associated token account · updated {updatedAgo}
        </p>
      </div>
    </section>
  );
}
