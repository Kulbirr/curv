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
 * Layout follows the sibling trust cards (Dev buy, Buyback and burn):
 * a single vertical stack that is identical on mobile and desktop, so
 * narrow viewports can never squeeze it into a broken multi-column grid.
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

  return (
    <div className="mb-3 rounded-lg border border-[#32f27b]/40 bg-[#32f27b]/5 p-4">
      <div className="flex items-center gap-2">
        <span className="sc-section-glyph" aria-hidden="true">
          🏆
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Trader rewards
        </span>
      </div>
      <p className="mt-2 text-lg font-bold leading-snug text-[#32f27b] sm:text-xl">
        Top {reward.count} net buyer{reward.count === 1 ? '' : 's'} split{' '}
        {(reward.bps / 100).toFixed(0)}% of creator fees
      </p>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500">
        {winners.length > 0
          ? 'Winners decided at graduation from on-chain trade history. Paid automatically on creator claims.'
          : 'Winners are decided at graduation from on-chain buy volume. Locked at launch, the rule cannot change.'}
      </p>
      {winners.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-white/5 pt-3">
          {winners.map((w) => (
            <div
              key={w.wallet}
              className="flex items-center justify-between gap-3 rounded-lg bg-black/25 px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-xs font-bold text-neutral-300">
                  #{w.rank}
                </span>
                <span className="sc-mono truncate text-xs text-neutral-500">
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
  );
}
