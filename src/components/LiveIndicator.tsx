import { cn } from '@/lib/utils';
import type { LiveStatus } from '@/hooks/useLiveStatus';

const STATUS_STYLE: Record<LiveStatus, { dot: string; label: string; text: string }> = {
  live: {
    dot: 'bg-emerald-400',
    label: 'LIVE',
    text: 'text-emerald-400',
  },
  reconnecting: {
    dot: 'bg-amber-400 animate-pulse',
    label: 'reconnecting',
    text: 'text-amber-300',
  },
  stale: {
    dot: 'bg-amber-400',
    label: 'stale',
    text: 'text-amber-300',
  },
  error: {
    dot: 'bg-rose-400',
    label: 'offline',
    text: 'text-rose-400',
  },
  idle: {
    dot: 'bg-neutral-600',
    label: 'connecting',
    text: 'text-neutral-500',
  },
};

/** Small live/stale/reconnecting indicator for auto-polling feeds. */
export default function LiveIndicator({ status }: { status: LiveStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className="inline-flex items-center gap-1.5" title={
      status === 'live'
        ? 'Prices refresh automatically every few seconds'
        : status === 'reconnecting'
          ? 'The feed dropped — retrying now'
          : status === 'stale'
            ? 'No fresh data for a while — showing last known values'
            : status === 'error'
              ? 'The feed is unreachable'
              : 'Waiting for the first update'
    }>
      <span className="relative flex h-2 w-2">
        {status === 'live' && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        )}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', s.dot)} />
      </span>
      <span className={cn('text-xs font-semibold uppercase tracking-wide', s.text)}>{s.label}</span>
    </span>
  );
}
