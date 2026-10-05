import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import Page from '@/components/ui/Page/Page';
import BountyCountdown from '@/components/Bounty/BountyCountdown';
import BountyLeaderboard, { LeaderboardEntry } from '@/components/Bounty/BountyLeaderboard';
import BountyEntryForm from '@/components/Bounty/BountyEntryForm';
import { formatRawAmount } from '@/components/Bounty/amounts';
import { buildBountyActionMessage } from '@/lib/signature-messages';

interface BountyDetail {
  id: number;
  poolAddress: string;
  creatorWallet: string;
  title: string;
  description: string | null;
  hashtag: string;
  keyword: string | null;
  prizeBudgetRaw: string;
  prizeMint: string;
  winnerCount: number;
  prizeSplits: number[];
  weights: { likes: number; retweets: number; replies: number; views: number };
  startsAt: number;
  endsAt: number;
  status: string;
  finalizedAt: number | null;
  cancelledAt: number | null;
  createdAt: number;
  entryCount: number;
  fundedRaw: string;
  winners: Array<{
    id: number;
    rank: number;
    authorHandle: string;
    tweetId: string;
    score: string;
    prizeRaw: string;
    prizeMint: string;
    bound: boolean;
    claimed: boolean;
    payoutTx: string | null;
    claimCode: string;
  }>;
}

interface PoolBits {
  quoteSymbol: string;
  quoteDecimals: number;
  quoteMint: string;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'border-[#32f27b]/40 bg-[#32f27b]/10 text-[#32f27b]',
    scheduled: 'border-blue-400/40 bg-blue-400/10 text-blue-300',
    finalizing: 'border-yellow-400/40 bg-yellow-400/10 text-yellow-300',
    finalized: 'border-white/20 bg-white/5 text-neutral-300',
    cancelled: 'border-red-400/40 bg-red-400/10 text-red-300',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold capitalize ${map[status] ?? 'border-white/10 bg-white/5 text-neutral-300'}`}
    >
      {status}
    </span>
  );
}

/**
 * Public bounty round page: hero card, live leaderboard, entry form,
 * and the finalized winners block. Everything adapts to mobile.
 */
export default function BountyPage() {
  const router = useRouter();
  const { id } = router.query;
  const { publicKey, signMessage, connected } = useWallet();
  const [bounty, setBounty] = useState<BountyDetail | null>(null);
  const [pool, setPool] = useState<PoolBits | null>(null);
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [leaderboardUpdated, setLeaderboardUpdated] = useState('just now');
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bindWinnerId, setBindWinnerId] = useState<number | null>(null);
  const [tweetUrl, setTweetUrl] = useState('');
  const [bindMsg, setBindMsg] = useState<string | null>(null);

  const load = async (silent = false) => {
    if (!id || typeof id !== 'string') return;
    try {
      if (!silent) setError(null);
      const res = await fetch(`/api/bounties/${id}`);
      const j = (await res.json()) as { error?: string; bounty?: BountyDetail; leaderboard?: LeaderboardEntry[] };
      if (!res.ok || !j.bounty) {
        if (!silent) setError(j.error || 'Bounty not found.');
        return;
      }
      setBounty(j.bounty);
      setEntries(j.leaderboard ?? []);
      setLeaderboardUpdated('just now');
      if (!pool) {
        const t = await fetch(`/api/pools/${j.bounty.poolAddress}/trust`);
        const tj = (await t.json()) as { quoteSymbol?: string; quoteDecimals?: number; quoteMint?: string };
        if (tj.quoteSymbol && typeof tj.quoteDecimals === 'number') {
          setPool({
            quoteSymbol: tj.quoteSymbol,
            quoteDecimals: tj.quoteDecimals,
            quoteMint: tj.quoteMint ?? '',
          });
        }
      }
    } catch {
      if (!silent) setError('Network error loading the bounty.');
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const t = setTimeout(() => setRefreshCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [refreshCooldown]);

  const isCreator = connected && publicKey && bounty && publicKey.toBase58() === bounty.creatorWallet;

  const refresh = async () => {
    if (!id || typeof id !== 'string') return;
    setBusy(true);
    try {
      const res = await fetch(`/api/bounties/${id}/refresh`, { method: 'POST' });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(j.error || 'Refresh failed.');
      } else {
        await load(true);
        setRefreshCooldown(3600);
      }
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  };

  const signedAction = async (action: 'cancel' | 'finalize') => {
    if (!bounty || !publicKey || !signMessage) return;
    setBusy(true);
    setError(null);
    try {
      const timestamp = Date.now();
      const message = buildBountyActionMessage(bounty.poolAddress, action, bounty.id, timestamp);
      const sigBytes = await signMessage(new TextEncoder().encode(message));
      const res = await fetch(`/api/bounties/${bounty.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          timestamp,
          signature: bs58.encode(sigBytes),
        }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(j.error || `${action} failed.`);
      } else {
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Signing failed.');
    } finally {
      setBusy(false);
    }
  };

  const bindWallet = async (winnerId: number, handle: string) => {
    setBindMsg(null);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/bounties/${id}/winners/bind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ winnerId, tweetUrl }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(j.error || 'Could not bind the wallet.');
        return;
      }
      setBindMsg(`Done. Your prize lands in that wallet automatically, @${handle}.`);
      setBindWinnerId(null);
      setTweetUrl('');
      await load();
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  };

  const quoteSymbol = pool?.quoteSymbol ?? '';
  const quoteDecimals = pool?.quoteDecimals ?? 9;

  return (
    <Page>
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        {error && (
          <p className="mb-4 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-300">
            {error}
          </p>
        )}
        {!bounty && !error && <p className="text-sm text-neutral-500">Loading bounty.</p>}
        {bounty && (
          <div className="flex flex-col gap-6">
            {/* Hero card */}
            <section className="rounded-3xl border border-white/10 bg-[#0d1110] p-6">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={bounty.status} />
                <span className="inline-flex items-center rounded-full border border-[#32f27b]/30 bg-[#32f27b]/5 px-3 py-1 text-xs font-bold text-[#32f27b]">
                  #{bounty.hashtag}
                </span>
                <BountyCountdown endsAt={bounty.endsAt} startsAt={bounty.startsAt} />
              </div>
              <h1 className="mt-4 text-2xl font-bold text-neutral-50">{bounty.title}</h1>
              {bounty.description && (
                <p className="mt-2 text-sm leading-relaxed text-neutral-400">{bounty.description}</p>
              )}
              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: 'Prize pool', value: formatRawAmount(bounty.prizeBudgetRaw, quoteDecimals, quoteSymbol) },
                  { label: 'Winners', value: `Top ${bounty.winnerCount}` },
                  { label: 'Entries', value: String(bounty.entryCount) },
                  {
                    label: 'Ends',
                    value: new Date(bounty.endsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                  },
                ].map((s) => (
                  <div key={s.label} className="rounded-2xl border border-white/5 bg-black/40 p-4">
                    <p className="text-xs text-neutral-500">{s.label}</p>
                    <p className="mt-1 text-lg font-bold text-neutral-100">{s.value}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-neutral-500">
                <a href={`/token/${bounty.poolAddress}`} className="font-semibold text-[#32f27b] hover:underline">
                  View the token
                </a>{' '}
                to fund future rounds with your fee share.
              </p>
            </section>

            {/* Winners when finalized */}
            {bounty.status === 'finalized' && (
              <section aria-label="Winners">
                <h2 className="mb-3 text-lg font-bold text-neutral-100">Winners</h2>
                {bounty.winners.length === 0 ? (
                  <p className="rounded-2xl border border-white/10 bg-[#0d1110] p-6 text-sm text-neutral-400">
                    No eligible entries when the round ended, so no prizes were awarded.
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {bounty.winners.map((w) => (
                      <div key={w.id} className="rounded-2xl border border-white/10 bg-[#0d1110] p-4">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-bold text-neutral-100">
                              Rank #{w.rank} · <span className="text-[#32f27b]">@{w.authorHandle}</span>
                            </p>
                            <a
                              href={`https://x.com/i/status/${w.tweetId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-neutral-400 underline underline-offset-2"
                            >
                              Winning post
                            </a>
                          </div>
                          <p className="text-base font-bold text-[#32f27b]">
                            {formatRawAmount(w.prizeRaw, quoteDecimals, quoteSymbol)}
                          </p>
                        </div>
                        <div className="mt-3">
                          {w.payoutTx ? (
                            <p className="text-xs text-neutral-400">
                              Paid.{' '}
                              <a
                                href={`https://solscan.io/tx/${w.payoutTx}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-semibold text-[#32f27b] hover:underline"
                              >
                                View transaction
                              </a>
                            </p>
                          ) : w.bound ? (
                            <p className="text-xs font-semibold text-yellow-300">
                              Wallet bound. The payout is on its way.
                            </p>
                          ) : (
                            <div>
                              {bindWinnerId === w.id ? (
                                <div className="flex flex-col gap-2">
                                  <p className="text-xs text-neutral-400">
                                    Post from <span className="font-semibold text-neutral-200">@{w.authorHandle}</span>{' '}
                                    with your wallet address and the code <span className="font-mono font-bold text-[#32f27b]">{w.claimCode}</span>,
                                    then paste that post link here.
                                  </p>
                                  <div className="flex flex-col gap-2 sm:flex-row">
                                    <input
                                      value={tweetUrl}
                                      onChange={(e) => setTweetUrl(e.target.value)}
                                      placeholder="https://x.com/you/status/..."
                                      inputMode="url"
                                      className="min-h-[44px] flex-1 rounded-xl border border-white/10 bg-black/40 px-4 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[#32f27b]/50"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => bindWallet(w.id, w.authorHandle)}
                                      disabled={busy}
                                      className="min-h-[44px] rounded-xl bg-[#32f27b] px-5 text-sm font-bold text-black disabled:opacity-50"
                                    >
                                      Claim
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setBindWinnerId(w.id)}
                                  className="min-h-[44px] rounded-xl border border-[#32f27b]/40 bg-[#32f27b]/10 px-5 text-sm font-bold text-[#32f27b]"
                                >
                                  Claim your prize
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {bindMsg && (
                      <p className="rounded-xl border border-[#32f27b]/30 bg-[#32f27b]/10 px-4 py-3 text-sm font-semibold text-[#32f27b]">
                        {bindMsg}
                      </p>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Entry form for active rounds */}
            {bounty.status === 'active' && (
              <BountyEntryForm hashtag={bounty.hashtag} onSubmitted={() => load(true)} />
            )}

            {/* Leaderboard */}
            <section aria-label="Leaderboard">
              <h2 className="mb-3 text-lg font-bold text-neutral-100">Leaderboard</h2>
              <BountyLeaderboard
                entries={entries}
                updatedLabel={leaderboardUpdated}
                onRefresh={refresh}
                refreshCooldownS={busy ? 60 : refreshCooldown}
              />
            </section>

            {/* Creator controls */}
            {isCreator && (bounty.status === 'active' || bounty.status === 'scheduled') && (
              <section className="rounded-2xl border border-white/10 bg-[#0d1110] p-5">
                <h3 className="text-sm font-bold text-neutral-100">Creator controls</h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => signedAction('finalize')}
                    disabled={busy || bounty.status === 'scheduled'}
                    className="min-h-[44px] rounded-xl bg-[#32f27b] px-6 text-sm font-bold text-black disabled:opacity-40"
                  >
                    End round and finalize now
                  </button>
                  <button
                    type="button"
                    onClick={() => signedAction('cancel')}
                    disabled={busy}
                    className="min-h-[44px] rounded-xl border border-red-400/40 px-6 text-sm font-semibold text-red-300"
                  >
                    Cancel
                  </button>
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  Cancelling is only possible before the first entry. Finalizing picks winners by final engagement.
                </p>
              </section>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
