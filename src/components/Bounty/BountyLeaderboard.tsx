export interface LeaderboardEntry {
  entryId: number;
  tweetId: string;
  handle: string;
  tweetText: string;
  submittedAt: number;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  score: string;
  takenAt: number | null;
}

function timeAgo(takenAt: number | null): string {
  if (!takenAt) return 'no data yet';
  const s = Math.max(0, Math.round((Date.now() - takenAt) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function scoreNum(s: string): number {
  try {
    return Number(BigInt(s));
  } catch {
    return 0;
  }
}

function RankBadge({ rank }: { rank: number }) {
  const style =
    rank === 1
      ? 'border-yellow-400/50 bg-yellow-400/10 text-yellow-300'
      : rank === 2
        ? 'border-neutral-400/40 bg-neutral-400/10 text-neutral-200'
        : rank === 3
          ? 'border-amber-700/50 bg-amber-700/10 text-amber-500'
          : 'border-white/10 bg-white/5 text-neutral-400';
  return (
    <span
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full border text-sm font-bold ${style}`}
    >
      {rank}
    </span>
  );
}

/**
 * Bounty leaderboard. Desktop renders a table; below md it renders
 * stacked cards with no horizontal scroll. Score bars show each row
 * as a proportion of the leader so the race is legible at a glance.
 */
export default function BountyLeaderboard({
  entries,
  myHandle,
  updatedLabel,
  onRefresh,
  refreshCooldownS,
}: {
  entries: LeaderboardEntry[];
  myHandle?: string | null;
  updatedLabel: string;
  onRefresh: () => void;
  refreshCooldownS: number;
}) {
  const leaderScore = entries.length ? Math.max(1, scoreNum(entries[0].score)) : 1;

  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-[#0d1110] p-8 text-center">
        <p className="text-sm text-neutral-400">
          No entries yet. Post with the hashtag and submit your link to take the lead.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-xs text-neutral-500">Updated {updatedLabel}</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshCooldownS > 0}
          className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-neutral-200 transition-colors hover:border-[#32f27b]/40 disabled:opacity-40 min-h-[44px]"
        >
          {refreshCooldownS > 0 ? `Refresh in ${refreshCooldownS}s` : 'Refresh scores'}
        </button>
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-2xl border border-white/10 bg-[#0d1110] md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-4 py-3 font-medium">Rank</th>
              <th className="px-4 py-3 font-medium">Post</th>
              <th className="px-4 py-3 text-right font-medium">Likes</th>
              <th className="px-4 py-3 text-right font-medium">Reposts</th>
              <th className="px-4 py-3 text-right font-medium">Replies</th>
              <th className="px-4 py-3 text-right font-medium">Score</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const mine = myHandle && e.handle.toLowerCase() === myHandle.toLowerCase();
              return (
                <tr
                  key={e.entryId}
                  className={`border-b border-white/5 last:border-0 ${mine ? 'bg-[#32f27b]/5' : ''}`}
                >
                  <td className="px-4 py-3">
                    <RankBadge rank={i + 1} />
                  </td>
                  <td className="max-w-[280px] px-4 py-3">
                    <a
                      href={`https://x.com/i/status/${e.tweetId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-[#32f27b] hover:underline"
                    >
                      @{e.handle}
                      {mine ? ' (you)' : ''}
                    </a>
                    <p className="mt-1 truncate text-xs text-neutral-400">{e.tweetText}</p>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/5">
                      <div
                        className="h-full rounded-full bg-[#32f27b]/70"
                        style={{ width: `${Math.max(2, (scoreNum(e.score) / leaderScore) * 100)}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-200">{e.likes}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-200">{e.retweets}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-200">{e.replies}</td>
                  <td className="px-4 py-3 text-right font-bold tabular-nums text-neutral-100">
                    {scoreNum(e.score).toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="flex flex-col gap-3 md:hidden">
        {entries.map((e, i) => {
          const mine = myHandle && e.handle.toLowerCase() === myHandle.toLowerCase();
          return (
            <div
              key={e.entryId}
              className={`rounded-2xl border bg-[#0d1110] p-4 ${mine ? 'border-[#32f27b]/40' : 'border-white/10'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <RankBadge rank={i + 1} />
                  <a
                    href={`https://x.com/i/status/${e.tweetId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-[#32f27b]"
                  >
                    @{e.handle}
                    {mine ? ' (you)' : ''}
                  </a>
                </div>
                <span className="text-lg font-bold tabular-nums text-neutral-100">
                  {scoreNum(e.score).toLocaleString()}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 text-xs text-neutral-400">{e.tweetText}</p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-[#32f27b]/70"
                  style={{ width: `${Math.max(2, (scoreNum(e.score) / leaderScore) * 100)}%` }}
                />
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-neutral-400">
                <span>
                  {e.likes} likes · {e.retweets} reposts · {e.replies} replies
                </span>
                <a
                  href={`https://x.com/i/status/${e.tweetId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-neutral-200 underline underline-offset-2"
                >
                  View post
                </a>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-xs text-neutral-600">
        Scores refresh automatically. Last snapshot {timeAgo(entries[0]?.takenAt ?? null)}.
      </p>
    </div>
  );
}
