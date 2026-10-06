import { useState } from 'react';
import Link from 'next/link';
import { formatCompact } from '@/components/Discover/format';
import { displayProgress } from '@/lib/graduation';
import { duelStatusMeta, formatDuelDate, shortWallet, type DuelPoolCard, type DuelStatus } from './duel';
import { cn } from '@/lib/utils';

function hueFor(symbol: string): number {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) % 360;
  return h;
}

/** Coin avatar with image fallback to a gradient letter tile. */
export function DuelCoinAvatar({
  imageUrl,
  symbol,
  size = 56,
}: {
  imageUrl: string | null;
  symbol: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const hue = hueFor(symbol || '?');
  const letter = (symbol || '?').charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${hue} 65% 42%), hsl(${(hue + 50) % 360} 65% 58%))`,
        boxShadow: '0 4px 18px rgba(0,0,0,0.45)',
      }}
    >
      {imageUrl && !failed ? (
        <img
          src={imageUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="font-bold text-white" style={{ fontSize: size * 0.42 }}>
          {letter}
        </span>
      )}
    </span>
  );
}

export function DuelStatusPill({ status, className }: { status: DuelStatus; className?: string }) {
  const meta = duelStatusMeta(status);
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[11px] font-bold tracking-[0.18em]',
        meta.className,
        className,
      )}
    >
      {meta.live && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#32f27b] opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[#32f27b]" />
        </span>
      )}
      {meta.label}
    </span>
  );
}

/** The VS medallion between two fighters. */
export function VsMedallion({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const dims =
    size === 'lg'
      ? 'h-16 w-16 text-lg'
      : size === 'sm'
        ? 'h-10 w-10 text-xs'
        : 'h-12 w-12 text-sm';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border font-black tracking-widest text-[#e8b64c]',
        dims,
      )}
      style={{
        borderColor: '#e8b64c55',
        background: 'radial-gradient(circle at 50% 35%, #2a2318 0%, #12100b 70%)',
        boxShadow: '0 0 24px #e8b64c22, inset 0 0 12px #e8b64c11',
      }}
    >
      VS
    </span>
  );
}

/** Live race bar for one side: big percent, gradient bar, SOL to graduate. */
export function DuelRaceBar({
  pool,
  accent = 'green',
  compact = false,
}: {
  pool: DuelPoolCard;
  accent?: 'green' | 'gold' | 'dim';
  compact?: boolean;
}) {
  const pct = pool.graduated ? 100 : displayProgress(pool.progress);
  const bar =
    accent === 'gold'
      ? 'linear-gradient(90deg, #8a6a2a, #e8b64c)'
      : accent === 'dim'
        ? 'linear-gradient(90deg, #3a403b, #5a615b)'
        : 'linear-gradient(90deg, #1d9e52, #32f27b)';
  return (
    <div className={cn('min-w-0 flex-1', accent === 'dim' && 'opacity-60')}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn('font-bold text-neutral-100', compact ? 'text-sm' : 'text-base')}>
          ${pool.symbol}
        </span>
        <span
          className={cn(
            'font-black tabular-nums',
            compact ? 'text-xl' : 'text-3xl',
            accent === 'gold' ? 'text-[#e8b64c]' : 'text-neutral-50',
          )}
        >
          {pct == null ? '–' : `${pct.toFixed(compact ? 0 : 1)}%`}
        </span>
      </div>
      <div
        className={cn('mt-1.5 overflow-hidden rounded-full bg-white/[0.06]', compact ? 'h-2' : 'h-3')}
        role="progressbar"
        aria-valuenow={pct ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${pool.symbol} graduation progress`}
      >
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, background: bar }}
        />
      </div>
      <p className={cn('mt-1.5 text-neutral-400', compact ? 'text-[11px]' : 'text-xs')}>
        {pool.graduated ? (
          <span className="font-semibold text-[#32f27b]">Graduated</span>
        ) : pool.quoteToGraduate != null ? (
          <>
            <span className="font-semibold text-neutral-200">
              {formatCompact(pool.quoteToGraduate)} {pool.quoteSymbol}
            </span>{' '}
            to graduate
          </>
        ) : (
          'Progress unavailable'
        )}
      </p>
    </div>
  );
}

/** Small coin card used in heroes and versus strips. */
export function DuelFighterCard({
  pool,
  align = 'left',
  champion = false,
  dimmed = false,
  size = 'md',
}: {
  pool: DuelPoolCard;
  align?: 'left' | 'right' | 'center';
  champion?: boolean;
  dimmed?: boolean;
  size?: 'md' | 'lg';
}) {
  const avatar = size === 'lg' ? 72 : 56;
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-center gap-3',
        align === 'right' && 'flex-row-reverse text-right',
        align === 'center' && 'flex-col text-center',
        dimmed && 'opacity-50 saturate-50',
      )}
    >
      <div className="relative shrink-0">
        <DuelCoinAvatar imageUrl={pool.imageUrl} symbol={pool.symbol} size={avatar} />
        {champion && (
          <span
            className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full px-2 py-0.5 text-[9px] font-black tracking-[0.2em] whitespace-nowrap"
            style={{
              background: 'linear-gradient(90deg, #8a6a2a, #e8b64c, #8a6a2a)',
              color: '#1a1408',
              boxShadow: '0 0 16px #e8b64c66',
            }}
          >
            WINNER
          </span>
        )}
      </div>
      <div className="min-w-0">
        <p className={cn('truncate font-bold text-neutral-50', size === 'lg' ? 'text-xl' : 'text-base')}>
          ${pool.symbol}
        </p>
        <p className="truncate text-xs text-neutral-500">{pool.name}</p>
        <Link
          href={`/token/${pool.poolAddress}`}
          className="mt-0.5 inline-block text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
        >
          View coin
        </Link>
      </div>
    </div>
  );
}

/** One timeline row. */
export function DuelTimelineRow({
  label,
  detail,
  ts,
  done,
  last = false,
}: {
  label: string;
  detail: string;
  ts: number | null;
  done: boolean;
  last?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            'mt-1 h-2.5 w-2.5 shrink-0 rounded-full',
            done ? 'bg-[#32f27b] shadow-[0_0_10px_#32f27b88]' : 'bg-white/15',
          )}
        />
        {!last && <span className="w-px flex-1 bg-white/10" />}
      </div>
      <div className={cn('pb-5', last && 'pb-0')}>
        <p className={cn('text-sm font-bold', done ? 'text-neutral-100' : 'text-neutral-500')}>
          {label}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-neutral-400">{detail}</p>
        {ts != null && <p className="mt-0.5 text-[11px] text-neutral-600">{formatDuelDate(ts)}</p>}
      </div>
    </div>
  );
}

/** Short creator wallet line used under fighter cards. */
export function DuelCreatorLine({ wallet }: { wallet: string }) {
  return (
    <p className="mt-1 truncate text-[11px] text-neutral-500">
      Creator <span className="font-mono text-neutral-400">{shortWallet(wallet)}</span>
    </p>
  );
}
