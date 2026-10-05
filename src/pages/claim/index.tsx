import { useState } from 'react';
import Link from 'next/link';
import Page from '@/components/ui/Page/Page';
import { cn } from '@/lib/utils';

type Platform = 'x' | 'twitch';

interface Claim {
  poolAddress: string;
  entryIndex: number;
  bps: number;
  bound: boolean;
  claimUrl: string;
}

const PLATFORM_LABEL: Record<Platform, string> = {
  x: 'X',
  twitch: 'Twitch',
};

const PLATFORM_PLACEHOLDER: Record<Platform, string> = {
  x: 'username (without @)',
  twitch: 'twitch username',
};

function shortPool(p: string): string {
  return `${p.slice(0, 4)}…${p.slice(-4)}`;
}

export default function ClaimLookupPage() {
  const [platform, setPlatform] = useState<Platform>('x');
  const [handle, setHandle] = useState('');
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    const h = handle.trim();
    if (!h || loading) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const res = await fetch(
        `/api/claim/lookup?platform=${platform}&handle=${encodeURIComponent(h)}`,
      );
      const body = (await res.json().catch(() => ({}))) as { claims?: Claim[]; error?: string };
      if (!res.ok) throw new Error(body.error || 'Lookup failed');
      setClaims(Array.isArray(body.claims) ? body.claims : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed');
      setClaims([]);
    } finally {
      setLoading(false);
    }
  };

  const pending = claims.filter((c) => !c.bound);
  const done = claims.filter((c) => c.bound);

  return (
    <Page>
      <div className="mx-auto w-full max-w-xl px-4 py-10">
        <section
          aria-label="Find your fee share"
          className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0d1110] px-6 py-7 md:px-8"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(ellipse_at_top,#32f27b14,transparent_70%)]"
          />
          <div className="relative">
            <p className="text-[11px] font-bold tracking-[0.25em] text-[#32f27b]">
              FIND YOUR FEE SHARE
            </p>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-neutral-50">
              Did someone set aside fees for you?
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-neutral-400">
              Type your social handle below. If a pool creator reserved a fee share for
              you, your claim link appears here. No wallet needed to look.
            </p>

            <div className="mt-6 flex gap-2" role="tablist" aria-label="Platform">
              {(Object.keys(PLATFORM_LABEL) as Platform[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={platform === p}
                  onClick={() => {
                    setPlatform(p);
                    setSearched(false);
                    setClaims([]);
                    setError(null);
                  }}
                  className={cn(
                    'h-10 flex-1 rounded-full text-sm font-bold transition',
                    platform === p
                      ? 'bg-[#32f27b] text-[#04120a]'
                      : 'border border-white/10 bg-white/[0.03] text-neutral-400 hover:border-white/20 hover:text-neutral-200',
                  )}
                >
                  {PLATFORM_LABEL[p]}
                </button>
              ))}
            </div>

            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                search();
              }}
            >
              <input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder={PLATFORM_PLACEHOLDER[platform]}
                spellCheck={false}
                autoComplete="off"
                aria-label="Social handle"
                className="h-12 flex-1 rounded-xl border border-white/10 bg-black/40 px-4 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-[#32f27b]/50 focus:outline-none"
              />
              <button
                type="submit"
                disabled={loading || !handle.trim()}
                className="inline-flex h-12 items-center justify-center rounded-full bg-[#32f27b] px-6 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60 sm:w-auto w-full"
              >
                {loading ? 'Looking…' : 'Find'}
              </button>
            </form>

            {error && <p className="mt-4 text-sm text-[#fa6d74]">{error}</p>}

            {searched && !loading && !error && claims.length === 0 && (
              <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
                <p className="text-sm text-neutral-400">
                  Nothing reserved for{' '}
                  <span className="font-semibold text-neutral-100">@{handle.trim()}</span> on{' '}
                  {PLATFORM_LABEL[platform]} yet. If a creator just added you, give it a
                  moment and try again.
                </p>
              </div>
            )}

            {pending.length > 0 && (
              <div className="mt-6 space-y-3">
                <p className="text-xs font-bold tracking-[0.2em] text-[#32f27b]">
                  READY TO CLAIM ({pending.length})
                </p>
                {pending.map((c) => (
                  <Link
                    key={`${c.poolAddress}-${c.entryIndex}`}
                    href={c.claimUrl}
                    className="block rounded-2xl border border-[#32f27b]/25 bg-[#32f27b]/[0.04] px-5 py-4 transition hover:border-[#32f27b]/50 hover:bg-[#32f27b]/[0.07]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-lg font-semibold text-neutral-50">
                          {(c.bps / 100).toFixed(2)}
                          <span className="text-sm font-light text-neutral-400">%</span>
                          <span className="ml-2 text-xs font-normal text-neutral-500">
                            of creator fees
                          </span>
                        </p>
                        <p className="mt-1 text-xs text-neutral-500">
                          Pool {shortPool(c.poolAddress)}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-[#32f27b] px-4 py-2 text-xs font-bold text-[#04120a]">
                        Claim
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}

            {done.length > 0 && (
              <div className="mt-6 space-y-3">
                <p className="text-xs font-bold tracking-[0.2em] text-neutral-500">
                  ALREADY CLAIMED ({done.length})
                </p>
                {done.map((c) => (
                  <div
                    key={`${c.poolAddress}-${c.entryIndex}`}
                    className="rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4"
                  >
                    <p className="text-sm text-neutral-400">
                      <span className="font-semibold text-neutral-200">
                        {(c.bps / 100).toFixed(2)}%
                      </span>{' '}
                      on pool {shortPool(c.poolAddress)} · wallet bound
                    </p>
                  </div>
                ))}
              </div>
            )}

            <p className="mt-6 text-[11px] leading-relaxed text-neutral-600">
              Claiming still asks you to prove the account is yours: a public post for X,
              a quick login for Twitch. Then you bind the wallet that gets paid.
            </p>
          </div>
        </section>
      </div>
    </Page>
  );
}
