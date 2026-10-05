import { useState } from 'react';

/**
 * Submit a tweet to a bounty round. The user posts on X first, then
 * pastes the link. Server verifies the hashtag and authorship.
 */
export default function BountyEntryForm({
  hashtag,
  onSubmitted,
}: {
  hashtag: string;
  onSubmitted: () => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setError(null);
    const id = window.location.pathname.split('/').pop() ?? '';
    if (!url.trim()) {
      setError('Paste your post link first.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/bounties/${id}/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tweetUrl: url.trim() }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(j.error || 'Could not submit, try again.');
        return;
      }
      setDone(true);
      setUrl('');
      onSubmitted();
    } catch {
      setError('Network error, try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-[#0d1110] p-5">
      <h3 className="text-sm font-bold text-neutral-100">Enter this bounty</h3>
      <p className="mt-1 text-xs leading-relaxed text-neutral-400">
        Post about this token on X with <span className="font-semibold text-[#32f27b]">#{hashtag}</span>,
        then paste your post link below. One entry per person. Your X handle is your identity here.
      </p>
      {done ? (
        <p className="mt-4 rounded-xl border border-[#32f27b]/30 bg-[#32f27b]/10 px-4 py-3 text-sm font-semibold text-[#32f27b]">
          Submitted. You are on the leaderboard.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://x.com/you/status/..."
            inputMode="url"
            className="min-h-[44px] flex-1 rounded-xl border border-white/10 bg-black/40 px-4 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[#32f27b]/50"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="min-h-[44px] rounded-xl bg-[#32f27b] px-6 text-sm font-bold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Submitting' : 'Submit post'}
          </button>
        </div>
      )}
      {error && <p className="mt-3 text-xs font-medium text-red-400">{error}</p>}
    </div>
  );
}
