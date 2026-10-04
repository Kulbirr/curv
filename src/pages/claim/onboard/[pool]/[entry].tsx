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

  const entryPlatform = (entry?.platform ?? 'x') as 'x' | 'twitch' | 'reddit';
  const isOAuthFlow = isHandleOnly && (entryPlatform === 'twitch' || entryPlatform === 'reddit');
  const oauthStatus = typeof router.query.oauth === 'string' ? router.query.oauth : null;
  const [sessionExpired, setSessionExpired] = useState(false);
  const oauthVerified = (oauthStatus === 'twitch' || oauthStatus === 'reddit') && !sessionExpired;
  const oauthError = oauthStatus === 'error' ? (typeof router.query.reason === 'string' ? router.query.reason : 'error') : null;

  const bind = useCallback(async () => {
    if (!pool || entryIndex === null) return;
    const isTweetFlow = !!entry?.handle && !entry?.wallet && (entry?.platform ?? 'x') === 'x';
    const isOAuthBind = !!entry?.handle && !entry?.wallet && ((entry?.platform ?? 'x') === 'twitch' || (entry?.platform ?? 'x') === 'reddit');
    // Tweet flow needs no wallet connection: the wallet comes from
    // the tweet text itself, authored by the handle owner.
    // OAuth flow needs the wallet connection: the identity cookie
    // proves handle ownership, the signature proves wallet control.
    if (!isTweetFlow && (!publicKey || !signMessage)) return;
    setView({ kind: 'binding' });
    try {
      const endpoint = isTweetFlow ? 'verify-tweet' : isOAuthBind ? 'verify-oauth' : 'bindings';
      const body: Record<string, unknown> = { entryIndex };
      let wallet: string | null = null;
      if (isTweetFlow) {
        body.tweetUrl = tweetUrl.trim();
      } else {
        wallet = publicKey!.toBase58();
        const timestamp = Date.now();
        const message = buildRecipientBindingMessage(pool, entryIndex, wallet, timestamp);
        const sigBytes = await signMessage!(new TextEncoder().encode(message));
        body.wallet = wallet;
        body.timestamp = timestamp;
        body.signature = bs58.encode(sigBytes);
      }
      const res = await fetch(`/api/pools/${pool}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const resBody = (await res.json().catch(() => ({}))) as { error?: string; wallet?: string };
      if (!res.ok) {
        // The OAuth identity cookie is gone (expired, different tab, or
        // private window). Drop back to the verify step instead of
        // leaving the page stuck on "Identity verified".
        if (res.status === 401 && isOAuthBind) setSessionExpired(true);
        throw new Error(resBody.error || 'Binding failed');
      }
      const boundWallet = wallet ?? resBody.wallet ?? '';
      setView({ kind: 'done', wallet: boundWallet });
      setSplits((s) =>
        s
          ? {
              ...s,
              recipients: s.recipients.map((r, i) =>
                i === entryIndex ? { ...r, bound: true, effectiveWallet: boundWallet } : r,
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
  }, [pool, entryIndex, publicKey, signMessage, tweetUrl, entry?.handle, entry?.wallet, entry?.platform]);

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

                {isHandleOnly && entry.verifyCode && entryPlatform === 'x' && (
                  <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
                    <p className="text-xs leading-relaxed text-neutral-400">
                      This share is reserved for{' '}
                      <span className="font-semibold text-neutral-100">{entryName}</span>. No
                      wallet connection needed, prove it&apos;s you in two steps:
                    </p>
                    <ol className="mt-3 space-y-3 text-xs leading-relaxed text-neutral-400">
                      <li className="flex gap-2">
                        <span className="font-bold text-[#32f27b]">1.</span>
                        <span>
                          Post a public tweet from {entryName} with this code{' '}
                          <span className="font-semibold text-neutral-100">and</span> the
                          Solana wallet that should receive your share:{' '}
                          <button
                            type="button"
                            onClick={() => navigator.clipboard?.writeText(entry.verifyCode!)}
                            className="mt-1 inline-block rounded-lg border border-[#32f27b]/30 bg-[#32f27b]/5 px-3 py-1 font-mono text-sm font-bold tracking-widest text-[#32f27b]"
                            title="Tap to copy"
                          >
                            {entry.verifyCode}
                          </button>
                          <a
                            href={`https://x.com/intent/post?text=${encodeURIComponent(`Claiming my Curv creator fee share. Verification code: ${entry.verifyCode}\nMy wallet: PASTE_YOUR_SOLANA_WALLET_HERE`)}`}
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
                          Paste the tweet link below and submit. The wallet in your tweet is
                          what gets paid.
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

                {isOAuthFlow && (
                  <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
                    <p className="text-xs leading-relaxed text-neutral-400">
                      This share is reserved for{' '}
                      <span className="font-semibold text-neutral-100">{entryName}</span>{' '}
                      on {entryPlatform === 'twitch' ? 'Twitch' : 'Reddit'}.
                      {oauthVerified
                        ? ' Identity verified. Now connect the wallet that should receive your share and sign to bind it.'
                        : ' Prove it is you in two steps:'}
                    </p>
                    {oauthError && (
                      <p className="mt-3 text-xs text-[#fa6d74]">
                        Verification failed
                        {oauthError === 'mismatch'
                          ? ': the account you logged in with does not match this share.'
                          : ', please try again.'}
                      </p>
                    )}
                    {sessionExpired && (
                      <p className="mt-3 text-xs text-[#fa6d74]">
                        Your verification expired. Please verify with{' '}
                        {entryPlatform === 'twitch' ? 'Twitch' : 'Reddit'} again, then
                        connect your wallet and sign.
                      </p>
                    )}
                    {!oauthVerified && (
                      <ol className="mt-3 space-y-3 text-xs leading-relaxed text-neutral-400">
                        <li className="flex gap-2">
                          <span className="font-bold text-[#32f27b]">1.</span>
                          <span>
                            Log in with {entryPlatform === 'twitch' ? 'Twitch' : 'Reddit'} as{' '}
                            <span className="font-semibold text-neutral-100">{entryName}</span>.
                            We only read your username, nothing else.{' '}
                            <a
                              href={`/api/auth/${entryPlatform}/authorize?pool=${pool}&entry=${entryIndex}`}
                              className="mt-2 inline-block rounded-full bg-[#32f27b] px-5 py-2 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f]"
                            >
                              Verify with {entryPlatform === 'twitch' ? 'Twitch' : 'Reddit'}
                            </a>
                          </span>
                        </li>
                        <li className="flex gap-2">
                          <span className="font-bold text-[#32f27b]">2.</span>
                          <span>
                            After verifying, connect your wallet below and sign once to bind it.
                            The wallet you connect is what gets paid.
                          </span>
                        </li>
                      </ol>
                    )}
                  </div>
                )}

                <div className="mt-6">
                    {isHandleOnly && entryPlatform === 'x' ? (
                      <button
                        type="button"
                        onClick={bind}
                        disabled={view.kind === 'binding' || !tweetUrl.trim()}
                        className="inline-flex h-12 w-full items-center justify-center rounded-full bg-[#32f27b] text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60"
                      >
                        {view.kind === 'binding' ? 'Verifying…' : 'Verify tweet and bind wallet'}
                      </button>
                    ) : isOAuthFlow && !oauthVerified ? null : !connected ? (
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
                          disabled={view.kind === 'binding'}
                          className="mt-3 inline-flex h-12 w-full items-center justify-center rounded-full bg-[#32f27b] text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60"
                        >
                          {view.kind === 'binding' ? 'Verifying…' : 'Sign and bind wallet'}
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
