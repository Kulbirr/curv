import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { useWallet } from '@solana/wallet-adapter-react';
import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import bs58 from 'bs58';
import Page from '@/components/ui/Page/Page';
import { buildRecipientBindingMessage } from '@/lib/signature-messages';
import type { EffectiveFeeSplitRecipient } from '@/lib/fee-split-terms';
import { cn } from '@/lib/utils';

interface RecipientWithPending extends EffectiveFeeSplitRecipient {
  pendingBaseRaw: string | null;
  pendingQuoteRaw: string | null;
  verifyCode: string | null;
}

interface FeeSplitsResponse {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  configAddress: string;
  creator: string;
  recipients: RecipientWithPending[];
  creatorRemainderBps: number;
  accrued: {
    baseRaw: string | null;
    quoteRaw: string | null;
    baseDecimals: number;
    quoteDecimals: number;
  } | null;
}

interface TrustResponse {
  baseSymbol?: string;
  baseName?: string;
  quoteSymbol?: string;
}

type View =
  | { kind: 'loading' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ready' }
  | { kind: 'binding' }
  | { kind: 'done'; wallet: string }
  | { kind: 'error'; message: string };

function shortWallet(w: string): string {
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

function formatRaw(raw: string | null | undefined, decimals: number): string | null {
  if (!raw) return null;
  try {
    const v = BigInt(raw);
    if (v <= BigInt(0)) return null;
    const s = v.toString().padStart(decimals + 1, '0');
    const int = s.slice(0, -decimals) || '0';
    let frac = s.slice(-decimals).replace(/0+$/, '');
    if (frac.length > 4) frac = frac.slice(0, 4);
    return frac ? `${int}.${frac}` : int;
  } catch {
    return null;
  }
}

export default function RecipientOnboardingPage() {
  const router = useRouter();
  const { publicKey, connected, signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const [splits, setSplits] = useState<FeeSplitsResponse | null>(null);
  const [trust, setTrust] = useState<TrustResponse | null>(null);
  const [view, setView] = useState<View>({ kind: 'loading' });

  const pool = typeof router.query.pool === 'string' ? router.query.pool : null;
  const entryIndex = useMemo(() => {
    const raw = router.query.entry;
    const n = typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isInteger(n) && n >= 0 ? n : null;
  }, [router.query.entry]);

  useEffect(() => {
    if (!router.isReady || !pool || entryIndex === null) return;
    let cancelled = false;
    (async () => {
      try {
        const [sRes, tRes] = await Promise.all([
          fetch(`/api/pools/${pool}/fee-splits`),
          fetch(`/api/pools/${pool}/trust`),
        ]);
        if (!sRes.ok) throw new Error('Pool not found or has no fee splits');
        const sJson = (await sRes.json()) as FeeSplitsResponse;
        if (cancelled) return;
        setSplits(sJson);
        if (tRes.ok) {
          const tJson = (await tRes.json()) as TrustResponse;
          if (!cancelled) setTrust(tJson);
        }
        const entry = sJson.recipients[entryIndex];
        if (!entry) {
          setView({ kind: 'invalid', message: 'This invite link does not match a split entry.' });
          return;
        }
        if (entry.bound || entry.effectiveWallet) {
          setView({ kind: 'done', wallet: String(entry.effectiveWallet ?? entry.wallet ?? '') });
          return;
        }
        setView({ kind: 'ready' });
      } catch (e) {
        if (!cancelled) {
          setView({ kind: 'invalid', message: 'Could not load this invite link.' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router.isReady, pool, entryIndex]);

  const entry: RecipientWithPending | null =
    splits && entryIndex !== null ? (splits.recipients[entryIndex] ?? null) : null;
  const entryName = entry
    ? entry.handle
      ? `@${entry.handle}`
      : entry.wallet
        ? shortWallet(entry.wallet)
        : `Recipient ${entryIndex! + 1}`
    : '';
  const sharePct = entry ? (entry.bps / 100).toFixed(2) : '';
  const tokenName = trust?.baseName || trust?.baseSymbol || 'this token';
  const quoteSymbol = trust?.quoteSymbol || 'quote';
  const isHandleOnly = !!entry?.handle && !entry.wallet;

  const pendingQuote = entry
    ? formatRaw(entry.pendingQuoteRaw, splits?.accrued?.quoteDecimals ?? 6)
    : null;
  const pendingBase = entry
    ? formatRaw(entry.pendingBaseRaw, splits?.accrued?.baseDecimals ?? 9)
    : null;

  const [tweetUrl, setTweetUrl] = useState('');

  const bind = useCallback(async () => {
    if (!pool || entryIndex === null || !publicKey || !signMessage) return;
    setView({ kind: 'binding' });
    try {
      const wallet = publicKey.toBase58();
      const timestamp = Date.now();
      const message = buildRecipientBindingMessage(pool, entryIndex, wallet, timestamp);
      const sigBytes = await signMessage(new TextEncoder().encode(message));
      const isTweetFlow = !!entry?.handle && !entry?.wallet;
      const endpoint = isTweetFlow ? 'verify-tweet' : 'bindings';
      const res = await fetch(`/api/pools/${pool}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryIndex,
          wallet,
          timestamp,
          signature: bs58.encode(sigBytes),
          ...(isTweetFlow ? { tweetUrl: tweetUrl.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || 'Binding failed');
      setView({ kind: 'done', wallet });
      setSplits((s) =>
        s
          ? {
              ...s,
              recipients: s.recipients.map((r, i) =>
                i === entryIndex ? { ...r, bound: true, effectiveWallet: wallet } : r,
              ),
            }
          : s,
      );
    } catch (e) {
      setView({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Binding failed, please try again',
      });
    }
  }, [pool, entryIndex, publicKey, signMessage, tweetUrl, entry?.handle, entry?.wallet]);

  return (
    <Page>
      <div className="mx-auto w-full max-w-xl px-4 py-10">
        <section
          aria-label="Claim fee share"
          className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0d1110] px-6 py-7 md:px-8"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(ellipse_at_top,#32f27b14,transparent_70%)]"
          />
          <div className="relative">
            <p className="text-[11px] font-bold tracking-[0.25em] text-[#32f27b]">
              CLAIM FEE SHARE
            </p>
          </div>

          {view.kind === 'loading' && (
            <div aria-busy="true" className="mt-6">
              <div className="h-8 w-48 animate-pulse rounded-xl bg-white/10" />
              <div className="mt-4 h-4 w-full animate-pulse rounded-full bg-white/5" />
              <div className="mt-2 h-4 w-2/3 animate-pulse rounded-full bg-white/5" />
              <div className="mt-6 h-12 w-full animate-pulse rounded-full bg-white/10" />
            </div>
          )}

          {view.kind === 'invalid' && (
            <p className="mt-6 text-sm text-neutral-400">{view.message}</p>
          )}

          {(view.kind === 'ready' || view.kind === 'binding' || view.kind === 'error') &&
            entry && (
              <div className="relative mt-6">
                <p className="text-5xl font-semibold tracking-tight text-neutral-50">
                  {sharePct}
                  <span className="text-2xl font-light text-neutral-400">%</span>
                </p>
                <p className="mt-3 text-sm leading-relaxed text-neutral-400">
                  This pool set aside <span className="font-semibold text-neutral-100">{sharePct}%</span> of
                  its creator fees for <span className="font-semibold text-neutral-100">{entryName}</span> on{' '}
                  {tokenName}.
                  {(pendingQuote || pendingBase) && (
                    <>
                      {' '}Unclaimed right now:{' '}
                      <span className="font-semibold text-[#32f27b]">
                        ≈ {pendingQuote ? `${pendingQuote} ${quoteSymbol}` : ''}
                        {pendingQuote && pendingBase ? ' + ' : ''}
                        {pendingBase ? `${pendingBase} ${trust?.baseSymbol ?? ''}` : ''}
                      </span>
                    </>
                  )}
                </p>

                {isHandleOnly && entry.verifyCode && (
                  <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
                    <p className="text-xs leading-relaxed text-neutral-400">
                      This share is reserved for{' '}
                      <span className="font-semibold text-neutral-100">{entryName}</span>. Prove
                      it&apos;s you in two steps:
                    </p>
                    <ol className="mt-3 space-y-3 text-xs leading-relaxed text-neutral-400">
                      <li className="flex gap-2">
                        <span className="font-bold text-[#32f27b]">1.</span>
                        <span>
                          Post a public tweet from {entryName} containing this code:{' '}
                          <button
                            type="button"
                            onClick={() => navigator.clipboard?.writeText(entry.verifyCode!)}
                            className="mt-1 inline-block rounded-lg border border-[#32f27b]/30 bg-[#32f27b]/5 px-3 py-1 font-mono text-sm font-bold tracking-widest text-[#32f27b]"
                            title="Tap to copy"
                          >
                            {entry.verifyCode}
                          </button>
                          <a
                            href={`https://x.com/intent/post?text=${encodeURIComponent(`Claiming my Curv creator fee share. Verification code: ${entry.verifyCode}`)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-block text-[#32f27b] underline"
                          >
                            Post the tweet
                          </a>
                        </span>
                      </li>
                      <li className="flex gap-2">
                        <span className="font-bold text-[#32f27b]">2.</span>
                        <span className="flex-1">
                          Paste the tweet link below, then connect your wallet and sign.
                          <input
                            value={tweetUrl}
                            onChange={(e) => setTweetUrl(e.target.value)}
                            placeholder="https://x.com/you/status/123…"
                            spellCheck={false}
                            autoComplete="off"
                            className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/40 px-4 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-[#32f27b]/50 focus:outline-none"
                          />
                        </span>
                      </li>
                    </ol>
                  </div>
                )}

                <div className="mt-6">
                    {!connected ? (
                      <button
                        type="button"
                        onClick={() => setShowModal(true)}
                        className="inline-flex h-12 w-full items-center justify-center rounded-full bg-[#32f27b] text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f]"
                      >
                        Connect wallet to withdraw
                      </button>
                    ) : (
                      <div>
                        <p className="text-xs text-neutral-500">
                          Connected as {shortWallet(publicKey!.toBase58())}
                        </p>
                        <button
                          type="button"
                          onClick={bind}
                          disabled={view.kind === 'binding' || (isHandleOnly && !tweetUrl.trim())}
                          className="mt-3 inline-flex h-12 w-full items-center justify-center rounded-full bg-[#32f27b] text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60"
                        >
                          {view.kind === 'binding'
                            ? 'Verifying…'
                            : isHandleOnly
                              ? 'Verify tweet and bind wallet'
                              : 'Sign and bind wallet'}
                        </button>
                      </div>
                    )}
                  </div>

                {view.kind === 'error' && (
                  <p className="mt-4 text-sm text-[#fa6d74]">{view.message}</p>
                )}

                <p className="mt-6 text-[11px] leading-relaxed text-neutral-600">
                  Nothing moves until the pool creator claims fees. When they do, your share is
                  paid to your bound wallet automatically in the same transaction. The first
                  binding is permanent, so use a wallet you&apos;ll keep.
                </p>
              </div>
            )}

          {view.kind === 'done' && (
            <div className="relative mt-6">
              <p className="inline-flex items-center gap-2 rounded-full border border-[#32f27b]/30 bg-[#32f27b]/5 px-3 py-1 text-xs font-semibold text-[#32f27b]">
                Wallet bound
              </p>
              <p className="mt-4 text-sm leading-relaxed text-neutral-400">
                {view.wallet ? `${shortWallet(view.wallet)} will receive` : 'Your wallet will receive'}{' '}
                your <span className="font-semibold text-neutral-100">{sharePct}%</span> share
                automatically whenever the creator claims fees from this pool.
              </p>
              {pool && (
                <a
                  href={`/token/${pool}`}
                  className={cn('mt-4 inline-block text-sm text-[#32f27b] underline')}
                >
                  View the pool
                </a>
              )}
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}
