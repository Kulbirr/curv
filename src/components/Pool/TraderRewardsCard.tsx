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
 * Mobile: 2-col grid (label full width, headline + description side by
 * side, winners full width). Desktop: 4 sections on one row.
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
      <div className="grid grid-cols-2 items-center gap-4 md:grid-cols-[150px_220px_220px_minmax(0,1fr)] md:gap-6">
        {/* label — full width on mobile */}
        <div className="col-span-2 md:col-span-1">
          <div className="mb-1 h-0.5 w-6 bg-[#32f27b]" aria-hidden="true" />
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-400">
            Trader rewards
          </div>
        </div>

        {/* headline */}
        <div>
          <p className="text-xl font-bold leading-tight text-neutral-50">
            Top {reward.count} buyers split{' '}
            <span className="text-[#32f27b]">{(reward.bps / 100).toFixed(0)}%</span>
          </p>
        </div>

        {/* description */}
        <div>
          <p className="text-xs leading-relaxed text-neutral-500">{description}</p>
        </div>

        {/* winners — full width on mobile */}
        {winners.length > 0 && (
          <div className="col-span-2 flex flex-col gap-2 md:col-span-1">
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
