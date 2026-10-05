import { useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { buildBountyActionMessage } from '@/lib/signature-messages';
import { formatRawAmount, parseUiAmount } from './amounts';

const SPLIT_PRESETS: Array<{ name: string; splits: number[] }> = [
  { name: 'Winner takes all', splits: [10000] },
  { name: 'Top 3 (50/30/20)', splits: [5000, 3000, 2000] },
  { name: 'Top 5 (40/25/15/12/8)', splits: [4000, 2500, 1500, 1200, 800] },
];

const DURATIONS = [
  { label: '24 hours', ms: 24 * 3600_000 },
  { label: '3 days', ms: 3 * 24 * 3600_000 },
  { label: '7 days', ms: 7 * 24 * 3600_000 },
];

function StepDots({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={`h-2 flex-1 rounded-full ${n <= step ? 'bg-[#32f27b]' : 'bg-white/10'}`}
        />
      ))}
    </div>
  );
}

/**
 * Three step bounty creation wizard. Premium dark styling, mobile
 * first. Step 1: the prize. Step 2: the rules. Step 3: review and
 * sign with the creator wallet.
 */
export default function CreateBountyWizard({
  poolAddress,
  quoteSymbol,
  quoteDecimals,
  quoteMint,
  bountyBalanceRaw,
  onCreated,
  onClose,
}: {
  poolAddress: string;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteMint: string;
  bountyBalanceRaw: string;
  onCreated: (bountyId: number) => void;
  onClose: () => void;
}) {
  const { publicKey, signMessage, connected } = useWallet();
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [budgetUi, setBudgetUi] = useState('');
  const [winnerCount, setWinnerCount] = useState(3);
  const [splits, setSplits] = useState<number[]>([5000, 3000, 2000]);
  const [hashtag, setHashtag] = useState('');
  const [keyword, setKeyword] = useState('');
  const [durationMs, setDurationMs] = useState(DURATIONS[1].ms);
  const [wLikes, setWLikes] = useState(1);
  const [wRetweets, setWRetweets] = useState(3);
  const [wReplies, setWReplies] = useState(2);
  const [wViews, setWViews] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const budgetRaw = useMemo(() => parseUiAmount(budgetUi, quoteDecimals), [budgetUi, quoteDecimals]);
  const balanceBig = useMemo(() => {
    try {
      return BigInt(bountyBalanceRaw);
    } catch {
      return BigInt(0);
    }
  }, [bountyBalanceRaw]);
  const budgetOk = budgetRaw !== null && BigInt(budgetRaw) > BigInt(0) && BigInt(budgetRaw) <= balanceBig;
  const splitsOk = splits.length === winnerCount && splits.reduce((s, n) => s + n, 0) === 10000;
  const hashtagOk = /^[a-z0-9_]{2,40}$/.test(hashtag.trim().toLowerCase().replace(/^#+/, ''));
  const step1Ok = title.trim().length > 0 && budgetOk && splitsOk;
  const step2Ok = hashtagOk;

  const pickPreset = (preset: number[]) => {
    setWinnerCount(preset.length);
    setSplits(preset);
  };

  const setSplitAt = (i: number, bps: number) => {
    setSplits((prev) => prev.map((v, j) => (j === i ? Math.max(0, Math.min(10000, Math.floor(bps))) : v)));
  };

  const create = async () => {
    setError(null);
    if (!connected || !publicKey || !signMessage) {
      setError('Connect the creator wallet to sign.');
      return;
    }
    if (!step1Ok || !step2Ok || !budgetRaw) {
      setError('Check the prize and rules first.');
      return;
    }
    setBusy(true);
    try {
      const timestamp = Date.now();
      const message = buildBountyActionMessage(poolAddress, 'create', null, timestamp);
      const sigBytes = await signMessage(new TextEncoder().encode(message));
      const res = await fetch(`/api/pools/${poolAddress}/bounties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          hashtag: hashtag.trim(),
          keyword: keyword.trim() || undefined,
          prizeBudgetRaw: budgetRaw,
          prizeMint: quoteMint,
          winnerCount,
          prizeSplits: splits,
          weights: { likes: wLikes, retweets: wRetweets, replies: wReplies, views: wViews },
          startsAt: timestamp,
          endsAt: timestamp + durationMs,
          wallet: publicKey.toBase58(),
          timestamp,
          signature: bs58.encode(sigBytes),
        }),
      });
      const j = (await res.json()) as { error?: string; bounty?: { id: number } };
      if (!res.ok || !j.bounty) {
        setError(j.error || 'Could not create the bounty.');
        return;
      }
      onCreated(j.bounty.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Signing failed.');
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'min-h-[44px] w-full rounded-xl border border-white/10 bg-black/40 px-4 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[#32f27b]/50';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-white/10 bg-[#0d1110] p-6 sm:rounded-3xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-neutral-100">Create a bounty</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 text-neutral-400 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>
        <StepDots step={step} />

        {step === 1 && (
          <div className="mt-5 flex flex-col gap-4">
            <p className="rounded-xl border border-[#32f27b]/20 bg-[#32f27b]/5 px-4 py-3 text-sm text-neutral-200">
              <span className="font-bold text-[#32f27b]">{formatRawAmount(bountyBalanceRaw, quoteDecimals, quoteSymbol)}</span>{' '}
              available from your fee share.
            </p>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-400">Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Launch week shill contest" className={inputCls} maxLength={120} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-400">Prize budget ({quoteSymbol})</span>
              <input value={budgetUi} onChange={(e) => setBudgetUi(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="1.5" inputMode="decimal" className={inputCls} />
              {budgetUi && !budgetOk && (
                <span className="mt-1 block text-xs text-red-400">Must be above zero and within your funded balance.</span>
              )}
            </label>
            <div>
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-400">Winners</span>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => { const n = Math.max(1, winnerCount - 1); setWinnerCount(n); setSplits(evenSplits(n)); }} className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 text-lg text-neutral-200">−</button>
                <span className="min-w-[3ch] text-center text-lg font-bold text-neutral-100">{winnerCount}</span>
                <button type="button" onClick={() => { const n = Math.min(10, winnerCount + 1); setWinnerCount(n); setSplits(evenSplits(n)); }} className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 text-lg text-neutral-200">+</button>
              </div>
            </div>
            <div>
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-400">Prize splits</span>
              <div className="flex flex-wrap gap-2">
                {SPLIT_PRESETS.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => pickPreset(p.splits)}
                    className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-neutral-200 hover:border-[#32f27b]/40 min-h-[44px]"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {splits.map((s, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="w-12 text-xs font-semibold text-neutral-400">#{i + 1}</span>
                    <input
                      type="range"
                      min={0}
                      max={10000}
                      step={100}
                      value={s}
                      onChange={(e) => setSplitAt(i, Number(e.target.value))}
                      className="h-2 flex-1 accent-[#32f27b]"
                      aria-label={`Prize share for rank ${i + 1}`}
                    />
                    <span className="w-14 text-right text-xs font-bold tabular-nums text-neutral-100">{(s / 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
              <p className={`mt-1 text-xs font-semibold ${splitsOk ? 'text-[#32f27b]' : 'text-red-400'}`}>
                {splitsOk ? 'Splits add up to 100%.' : 'Splits must add up to 100%.'}
              </p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="mt-5 flex flex-col gap-4">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-400">Hashtag</span>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-[#32f27b]">#</span>
                <input value={hashtag} onChange={(e) => setHashtag(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="curvlaunch" className={inputCls} maxLength={40} />
              </div>
              {hashtag && !hashtagOk && (
                <span className="mt-1 block text-xs text-red-400">2 to 40 chars, letters numbers and underscores.</span>
              )}
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-400">Required phrase (optional)</span>
              <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="e.g. your token name" className={inputCls} maxLength={120} />
            </label>
            <div>
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-400">Duration</span>
              <div className="flex flex-wrap gap-2">
                {DURATIONS.map((d) => (
                  <button
                    key={d.label}
                    type="button"
                    onClick={() => setDurationMs(d.ms)}
                    aria-pressed={durationMs === d.ms}
                    className={`rounded-full border px-4 py-2 text-xs font-semibold min-h-[44px] ${durationMs === d.ms ? 'border-[#32f27b]/60 bg-[#32f27b]/10 text-[#32f27b]' : 'border-white/10 bg-white/5 text-neutral-200'}`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-400">Engagement weights</span>
              {[
                { label: 'Likes', v: wLikes, set: setWLikes },
                { label: 'Reposts', v: wRetweets, set: setWRetweets },
                { label: 'Replies', v: wReplies, set: setWReplies },
                { label: 'Views', v: wViews, set: setWViews },
              ].map((w) => (
                <div key={w.label} className="flex items-center gap-3 py-1">
                  <span className="w-16 text-xs text-neutral-400">{w.label}</span>
                  <input type="range" min={0} max={10} value={w.v} onChange={(e) => w.set(Number(e.target.value))} className="h-2 flex-1 accent-[#32f27b]" aria-label={`${w.label} weight`} />
                  <span className="w-8 text-right text-xs font-bold tabular-nums text-neutral-100">{w.v}</span>
                </div>
              ))}
              <p className="mt-1 text-xs text-neutral-500">Views stay at zero by default. View counts are the easiest to fake.</p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="mt-5 flex flex-col gap-4">
            <div className="rounded-2xl border border-white/10 bg-black/40 p-5">
              <h3 className="font-bold text-neutral-100">{title || 'Untitled bounty'}</h3>
              {description && <p className="mt-1 text-xs text-neutral-400">{description}</p>}
              <dl className="mt-4 flex flex-col gap-2 text-sm">
                <div className="flex justify-between"><dt className="text-neutral-500">Prize pool</dt><dd className="font-bold text-[#32f27b]">{budgetRaw ? formatRawAmount(budgetRaw, quoteDecimals, quoteSymbol) : '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-neutral-500">Winners</dt><dd className="text-neutral-100">Top {winnerCount}</dd></div>
                <div className="flex justify-between"><dt className="text-neutral-500">Hashtag</dt><dd className="font-semibold text-neutral-100">#{hashtag}</dd></div>
                <div className="flex justify-between"><dt className="text-neutral-500">Duration</dt><dd className="text-neutral-100">{DURATIONS.find((d) => d.ms === durationMs)?.label ?? 'Custom'}</dd></div>
              </dl>
            </div>
            <p className="text-xs leading-relaxed text-neutral-500">
              Funded by your fee share. Rounds are final once created: the prize, splits, hashtag and weights cannot change mid round.
            </p>
          </div>
        )}

        {error && <p className="mt-4 text-xs font-medium text-red-400">{error}</p>}

        <div className="mt-6 flex items-center justify-between gap-3">
          {step > 1 ? (
            <button type="button" onClick={() => setStep(step - 1)} className="min-h-[44px] rounded-xl border border-white/10 px-6 text-sm font-semibold text-neutral-200">
              Back
            </button>
          ) : (
            <span />
          )}
          {step < 3 ? (
            <button
              type="button"
              onClick={() => setStep(step + 1)}
              disabled={(step === 1 && !step1Ok) || (step === 2 && !step2Ok)}
              className="min-h-[44px] rounded-xl bg-[#32f27b] px-8 text-sm font-bold text-black disabled:opacity-40"
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={create}
              disabled={busy}
              className="min-h-[44px] rounded-xl bg-[#32f27b] px-8 text-sm font-bold text-black disabled:opacity-50"
            >
              {busy ? 'Signing' : 'Sign and create'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function evenSplits(n: number): number[] {
  const each = Math.floor(10000 / n);
  const out = Array(n).fill(each);
  out[0] += 10000 - each * n;
  return out;
}
