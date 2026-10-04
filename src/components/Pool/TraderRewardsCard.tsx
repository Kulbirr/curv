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
      <p className="mt-2 text-xl font-bold text-[#32f27b]">
        Top {reward.count} net buyer{reward.count === 1 ? '' : 's'} split {(reward.bps / 100).toFixed(0)}% of creator fees
      </p>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500">
        {winners.length > 0
          ? 'Winners decided at graduation from on-chain trade history. Paid automatically on creator claims.'
          : 'Winners are decided at graduation from on-chain buy volume. Locked at launch, the rule cannot change.'}
      </p>
      {winners.length > 0 && (
        <div className="mt-2 space-y-1">
          {winners.map((w) => (
            <div key={w.wallet} className="flex items-center justify-between text-xs">
              <span className="text-neutral-400">
                #{w.rank} <span className="sc-mono">{shortAddress(w.wallet)}</span>
              </span>
              <span className="font-semibold text-[#32f27b]">
                {(reward.bps / winners.length / 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
