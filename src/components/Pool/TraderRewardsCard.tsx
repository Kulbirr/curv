import { useQuery } from '@tanstack/react-query';

interface TraderRewardsData {
  traderReward: { count: number; bps: number; rule: string } | null;
  winners: Array<{ wallet: string; netVolumeRaw: string; rank: number }> | null;
}

function shortAddress(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/**
 * Trust panel card for trader rewards. Shows the rule locked at launch
 * and, after graduation, the decided winners. Self-contained: fetches
 * its own data so the trust pipeline stays untouched.
 *
 * Mobile: clean vertical stack. Desktop: horizontal three-section layout
 * (label | headline | description | winners).
 */
export default function TraderRewardsCard({ poolAddress }: { poolAddress: string }) {
  const q = useQuery({
    queryKey: ['trader-rewards', poolAddress],
    queryFn: async () => {
      const res = await fetch(`/api/pools/${poolAddress}/trader-rewards`);
      if (!res.ok) return { traderReward: null, winners: null } as TraderRewardsData;
      return (await res.json()) as TraderRewardsData;
    },
  });

  const reward = q.data?.traderReward;
  if (!reward) return null;
  const winners = q.data?.winners ?? [];
  const perWinner = winners.length > 0 ? reward.bps / winners.length / 100 : 0;
  const description = winners.length > 0
    ? 'Decided at graduation. Paid on creator claims.'
    : 'Decided at graduation. Locked at launch.';

  return (
    <div className="mb-3 rounded-2xl border border-[#32f27b]/25 bg-[#32f27b]/[0.04] p-5">
      {/* Mobile: vertical stack / Desktop: horizontal */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:gap-8">
        {/* Label */}
        <div className="shrink-0">
          <div className="mb-1 h-0.5 w-6 bg-[#32f27b]" aria-hidden="true" />
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-400">
            Trader rewards
          </div>
        </div>

        {/* Headline */}
        <div className="shrink-0">
          <p className="text-xl font-bold leading-tight text-neutral-50 md:text-2xl">
            Top {reward.count} buyers
            <br />
            split{' '}
            <span className="text-[#32f27b]">{(reward.bps / 100).toFixed(0)}%</span>
          </p>
        </div>

        {/* Description */}
        <div className="min-w-0 flex-1 md:min-w-[180px]">
          <p className="text-xs leading-relaxed text-neutral-500">{description}</p>
        </div>

        {/* Winners */}
        {winners.length > 0 && (
          <div className="flex shrink-0 flex-col gap-2 md:w-[280px]">
            {winners.map((w) => (
              <div
                key={w.wallet}
                className="flex items-center justify-between gap-3 rounded-xl bg-black/30 px-4 py-2.5"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="shrink-0 text-sm font-bold text-neutral-300">#{w.rank}</span>
                  <span className="truncate font-mono text-xs text-neutral-500">
                    {shortAddress(w.wallet)}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-bold text-[#32f27b]">
                  {perWinner.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
