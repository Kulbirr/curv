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
 * Uses inline styles for layout to guarantee the vertical stack renders
 * identically on all viewports, bypassing any Tailwind CSS caching issues.
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
    <div
      style={{
        marginBottom: 12,
        borderRadius: 8,
        border: '1px solid rgba(50, 242, 123, 0.4)',
        backgroundColor: 'rgba(50, 242, 123, 0.05)',
        padding: 16,
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="sc-section-glyph" aria-hidden="true">
          🏆
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: '#a3a3a3',
          }}
        >
          Trader rewards
        </span>
      </div>
      <p
        style={{
          marginTop: 8,
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1.4,
          color: '#32f27b',
        }}
      >
        Top {reward.count} buyers split {(reward.bps / 100).toFixed(0)}%
      </p>
      <p
        style={{
          marginTop: 4,
          fontSize: 10,
          lineHeight: 1.6,
          color: '#737373',
        }}
      >
        {winners.length > 0
          ? 'Decided at graduation. Paid on creator claims.'
          : 'Decided at graduation. Locked at launch.'}
      </p>
      {winners.length > 0 && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: '1px solid rgba(255,255,255,0.05)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {winners.map((w) => (
            <div
              key={w.wallet}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                borderRadius: 8,
                backgroundColor: 'rgba(0,0,0,0.25)',
                padding: '8px 12px',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#d4d4d4', flexShrink: 0 }}>
                  #{w.rank}
                </span>
                <span
                  className="sc-mono"
                  style={{
                    fontSize: 12,
                    color: '#737373',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {shortAddress(w.wallet)}
                </span>
              </span>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#32f27b', flexShrink: 0 }}>
                {perWinner.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
