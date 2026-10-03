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

interface XSessionResponse {
  configured: boolean;
  user: { xUserId: string; username: string } | null;
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

function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  );
}

export default function RecipientOnboardingPage() {
  const router = useRouter();
  const { publicKey, connected, signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const [splits, setSplits] = useState<FeeSplitsResponse | null>(null);
  const [trust, setTrust] = useState<TrustResponse | null>(null);
  const [xSession, setXSession] = useState<XSessionResponse | null>(null);
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
        const [sRes, tRes, xRes] = await Promise.all([
          fetch(`/api/pools/${pool}/fee-splits`),
          fetch(`/api/pools/${pool}/trust`),
          fetch('/api/auth/x/session'),
        ]);
        if (!sRes.ok) throw new Error('Pool not found or has no fee splits');
        const sJson = (await sRes.json()) as FeeSplitsResponse;
        if (cancelled) return;
        setSplits(sJson);
        if (tRes.ok) {
          const tJson = (await tRes.json()) as TrustResponse;
          if (!cancelled) setTrust(tJson);
        }
        if (xRes.ok && !cancelled) {
          setXSession((await xRes.json()) as XSessionResponse);
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
  const needsX = !!entry?.handle && !entry.wallet;
  const xUser = xSession?.user ?? null;
  const xMismatch =
    needsX && xUser && entry?.handle
      ? xUser.username.toLowerCase() !== entry.handle.toLowerCase()
      : false;
  const xVerified = needsX && xUser && !xMismatch;

  const pendingQuote = entry
    ? formatRaw(entry.pendingQuoteRaw, splits?.accrued?.quoteDecimals ?? 6)
    : null;
  const pendingBase = entry
    ? formatRaw(entry.pendingBaseRaw, splits?.accrued?.baseDecimals ?? 9)
    : null;

  const loginWithX = useCallback(() => {
    if (!pool || entryIndex === null) return;
    window.location.href = `/api/auth/x/login?next=${encodeURIComponent(`/claim/onboard/${pool}/${entryIndex}`)}`;
  }, [pool, entryIndex]);

  const bind = useCallback(async () => {
    if (!pool || entryIndex === null || !publicKey || !signMessage) return;
    setView({ kind: 'binding' });
    try {
      const wallet = publicKey.toBase58();
      const timestamp = Date.now();
      const message = buildRecipientBindingMessage(pool, entryIndex, wallet, timestamp);
      const sigBytes = await signMessage(new TextEncoder().encode(message));
      const res = await fetch(`/api/pools/${pool}/bindings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryIndex,
          wallet,
          timestamp,
          signature: bs58.encode(sigBytes),
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
  }, [pool, entryIndex, publicKey, signMessage]);

  const canBind = !needsX || xVerified;

  return (
    <Page>
      <div className="mx-auto w-full max-w-xl px-4 py-10">
        <section
          aria-label="Claim fee share"
          className="rounded-2xl border border-white/10 bg-[#141110] px-6 py-7 md:px-8"
        >
          <div className="flex items-center justify-between gap-4">
            <p className="text-[11px] font-bold tracking-[0.25em] text-[#d08a5f]">
              CLAIM FEE SHARE
            </p>
            {entry && (
              <span className="rounded-full border border-[#d08a5f]/40 px-3 py-1 text-[10px] font-semibold tracking-[0.18em] text-[#d08a5f]">
                {sharePct}% OF CREATOR FEES
              </span>
            )}
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
              <div className="mt-6">
                <p className="text-3xl font-light tracking-tight text-neutral-50">
                  {sharePct}
                  <span className="text-xl text-neutral-400">%</span>
                </p>
                <p className="mt-3 text-sm leading-relaxed text-neutral-400">
                  This pool set aside <span className="font-semibold text-neutral-100">{sharePct}%</span> of
                  its creator fees for <span className="font-semibold text-neutral-100">{entryName}</span> on{' '}
                  {tokenName}.
                  {(pendingQuote || pendingBase) && (
                    <>
                      {' '}Unclaimed right now:{' '}
                      <span className="font-semibold text-[#d08a5f]">
                        ≈ {pendingQuote ? `${pendingQuote} ${quoteSymbol}` : ''}
                        {pendingQuote && pendingBase ? ' + ' : ''}
                        {pendingBase ? `${pendingBase} ${trust?.baseSymbol ?? ''}` : ''}
                      </span>
                    </>
                  )}
                </p>

                {needsX && !xUser && (
                  <div className="mt-6">
                    <p className="text-xs leading-relaxed text-neutral-500">
                      This share is reserved for the X account {entryName}. Log in with X to prove
                      it's you, then connect the wallet you want payouts sent to.
                    </p>
                    {xSession && !xSession.configured ? (
                      <p className="mt-3 text-xs text-neutral-500">
                        X login isn't enabled on this site yet. Ask the pool creator for the direct
                        invite flow instead.
                      </p>
                    ) : (
                      <button
                        type="button"
                        onClick={loginWithX}
                        className="mt-4 inline-flex h-12 w-full items-center justify-center gap-3 rounded-full bg-neutral-50 text-sm font-bold text-black transition hover:bg-white"
                      >
                        <XLogo className="h-4 w-4" />
                        Log in with X
                      </button>
                    )}
                  </div>
                )}

                {xMismatch && (
                  <div className="mt-6 rounded-2xl border border-[#fa6d74]/30 bg-[#fa6d74]/5 px-4 py-3">
                    <p className="text-sm text-neutral-300">
                      You're logged in as <span className="font-semibold">@{xUser!.username}</span>,
                      but this share is reserved for{' '}
                      <span className="font-semibold">{entryName}</span>. Switch X accounts to
                      continue.
                    </p>
                  </div>
                )}

                {canBind && (
                  <div className="mt-6">
                    {xVerified && (
                      <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-[#32f27b]/30 bg-[#32f27b]/5 px-3 py-1 text-xs font-semibold text-[#32f27b]">
                        <XLogo className="h-3 w-3" />@{xUser!.username} verified
                      </p>
                    )}
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
                          disabled={view.kind === 'binding'}
                          className="mt-3 inline-flex h-12 w-full items-center justify-center rounded-full bg-[#32f27b] text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60"
                        >
                          {view.kind === 'binding' ? 'Waiting for signature…' : 'Sign and bind wallet'}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {view.kind === 'error' && (
                  <p className="mt-4 text-sm text-[#fa6d74]">{view.message}</p>
                )}

                <p className="mt-6 text-[11px] leading-relaxed text-neutral-600">
                  Nothing moves until the pool creator claims fees. When they do, your share is
                  paid to your bound wallet automatically in the same transaction. The first
                  binding is permanent, so use a wallet you'll keep.
                </p>
              </div>
            )}

          {view.kind === 'done' && (
            <div className="mt-6">
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
                  className={cn('mt-4 inline-block text-sm text-[#d08a5f] underline')}
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
