import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import Page from '@/components/ui/Page/Page';
import { getConnection, isDevnet } from '@/lib/solana';
import { platformFeeWallet } from '@/lib/launch';
import { cn } from '@/lib/utils';
import {
  MIRROR_SLIPPAGE_BPS,
  SUBSCRIPTION_DURATION_MS,
  SUBSCRIPTION_PRICE_LAMPORTS,
  formatCountdown,
  isPriceAcceptable,
  isSignalLive,
  quoteToBasePrice,
} from '@/lib/strategies';
import type { StrategySignal } from '@/lib/strategies';
import {
  JupiterError,
  fetchJupiterQuote,
  fetchJupiterSwapTransaction,
  type JupiterQuote,
} from '@/lib/jupiter';

/**
 * Strategies mirror feed.
 *
 * The operator publishes identical spot buy signals to every subscriber.
 * Each card carries a Mirror button that fetches a fresh Jupiter quote,
 * refuses the trade when the signal expired or the live price moved above
 * the signal max, applies a 1 percent slippage guard, and hands the swap
 * to the user's wallet for a fresh signature. Curv never holds funds,
 * keys, or signatures. Connecting a wallet is not permission to trade.
 *
 * The feed is subscriber only: a flat 0.05 SOL pass for 30 days, bought
 * with a plain SOL transfer the user signs themselves. No performance
 * fee, no cut of profits.
 */

function hueFromString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}

function fmtPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'unavailable';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function friendlyError(e: unknown): string {
  if (e instanceof JupiterError) return e.friendly;
  if (e instanceof Error && e.message) {
    if (/was not confirmed in/i.test(e.message))
      return 'The network was slow to confirm your payment. It may still have gone through, so check below before paying again.';
    return e.message;
  }
  return 'Something went wrong, please try again';
}

/**
 * Ask the server to verify a pass payment on chain and activate the pass.
 * Retries while the payment is not found yet: approving in the wallet only
 * broadcasts the transaction, and a slow network can leave it unconfirmed
 * for a while even though the SOL already arrived.
 */
async function activatePass(wallet: string, signature: string): Promise<void> {
  const ROUNDS = 22;
  for (let i = 0; i < ROUNDS; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 4000));
    const res = await fetch('/api/strategies/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet, signature }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.ok) return;
    const notFound = res.status === 422 && /not found on chain/i.test(json.error ?? '');
    if (notFound && i < ROUNDS - 1) continue;
    throw new Error(json.error || 'Could not activate the pass');
  }
  throw new Error('Payment not found on chain yet, try again in a bit');
}

function PairAvatar({ baseSymbol, quoteSymbol }: { baseSymbol: string; quoteSymbol: string }) {
  const hue = hueFromString(baseSymbol);
  return (
    <span className="relative inline-flex shrink-0" aria-hidden="true">
      <span
        className="flex h-12 w-12 items-center justify-center rounded-2xl text-lg font-bold text-white"
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 65% 42%), hsl(${(hue + 50) % 360} 65% 58%))`,
        }}
      >
        {baseSymbol.charAt(0)}
      </span>
      <span className="absolute -right-1 -bottom-1 flex h-6 w-6 items-center justify-center rounded-full border-2 border-[#0e1112] bg-[#1a2022] text-[10px] font-bold text-neutral-300">
        {quoteSymbol.charAt(0)}
      </span>
    </span>
  );
}

function LivePill({ signal, now }: { signal: StrategySignal; now: number }) {
  const live = isSignalLive(signal, now);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold',
        live ? 'bg-[#32f27b]/10 text-[#32f27b]' : 'bg-neutral-800 text-neutral-400',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', live && 'animate-pulse bg-[#32f27b]', !live && 'bg-neutral-500')} />
      {live ? `${formatCountdown(signal.expiresAt, now)} left` : 'expired'}
    </span>
  );
}

type SubState =
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'active'; expiresAt: number };

function useSubscription(wallet: string | null) {
  const [sub, setSub] = useState<SubState>({ kind: 'unknown' });
  const refresh = useCallback(async () => {
    if (!wallet) {
      setSub({ kind: 'none' });
      return;
    }
    try {
      const res = await fetch(`/api/strategies/subscription?wallet=${wallet}`);
      const json = await res.json();
      setSub(json.active ? { kind: 'active', expiresAt: json.expiresAt } : { kind: 'none' });
    } catch {
      // A failed refresh must never flip a known state to the paywall:
      // keep whatever was showing and let the next refresh correct it.
      setSub((prev) => (prev.kind === 'unknown' ? { kind: 'none' } : prev));
    }
  }, [wallet]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
  return { sub, refresh };
}

function useSignals(active: boolean, wallet: string | null) {
  const [signals, setSignals] = useState<StrategySignal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !wallet) {
      setSignals(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/strategies/signals?wallet=${wallet}`);
        if (!res.ok) throw new Error('feed unavailable');
        const json = await res.json();
        if (!cancelled) {
          setSignals(json.signals);
          setError(null);
        }
      } catch {
        if (!cancelled) setError('Could not load the feed');
      }
    };
    load();
    const t = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [active, wallet]);
  return { signals, error };
}

function SubscribeCard({
  onSubscribe,
  onRecheck,
  phase,
  error,
  signature,
}: {
  onSubscribe: () => void;
  onRecheck: () => void;
  phase: 'idle' | 'sending' | 'confirming' | 'error';
  error: string | null;
  signature: string | null;
}) {
  const bullets = [
    'Every live signal the moment it publishes',
    'Mirror any signal in one tap',
    'You sign every trade yourself',
    'Flat fee. No cut of your profits, ever.',
  ];
  const busy = phase === 'sending' || phase === 'confirming';
  const explorerUrl = signature
    ? `https://solscan.io/tx/${signature}${isDevnet() ? '?cluster=devnet' : ''}`
    : null;
  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#0e1112] p-8 md:p-10">
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at 50% -20%, rgb(50 242 123 / 12%), transparent 60%)' }}
        aria-hidden="true"
      />
      <div className="relative">
        <p className="text-[11px] font-bold tracking-[0.2em] text-[#32f27b]">THE PASS</p>
        <h2 className="mt-2 text-2xl font-bold text-neutral-50 md:text-3xl">Unlock the feed</h2>
        <div className="mt-4 flex items-baseline gap-2">
          <span className="sc-number text-4xl font-bold text-neutral-50">0.05</span>
          <span className="text-lg font-semibold text-neutral-400">SOL</span>
          <span className="text-sm text-neutral-500">for 30 days</span>
        </div>
        <ul className="mt-6 space-y-3">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-3 text-sm text-neutral-300">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#32f27b]/15 text-[11px] font-bold text-[#32f27b]">
                ✓
              </span>
              {b}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onSubscribe}
          disabled={busy}
          className="mt-8 inline-flex h-12 items-center justify-center rounded-full bg-[#32f27b] px-8 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60"
        >
          {phase === 'sending'
            ? 'Confirm in your wallet…'
            : phase === 'confirming'
              ? 'Confirming your payment…'
              : 'Get the pass'}
        </button>
        {phase === 'error' && error && (
          <div className="mt-4 rounded-2xl border border-[#fa6d74]/30 bg-[#fa6d74]/10 px-4 py-3">
            <p className="text-sm font-semibold text-[#fa6d74]">{error}</p>
            {explorerUrl && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center rounded-full border border-white/15 px-4 text-xs font-bold text-neutral-200 transition hover:border-white/30"
                >
                  View payment on Solscan
                </a>
                <button
                  type="button"
                  onClick={onRecheck}
                  className="inline-flex h-9 items-center rounded-full bg-[#32f27b] px-4 text-xs font-bold text-[#04120a] transition hover:bg-[#4bf78f]"
                >
                  Check again
                </button>
              </div>
            )}
            {signature && (
              <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                Your wallet already approved this payment, so checking again costs
                nothing and never charges you twice.
              </p>
            )}
          </div>
        )}
        <p className="mt-4 text-xs text-neutral-500">
          You send a plain SOL transfer from your own wallet. Curv cannot move your money.
        </p>
      </div>
    </div>
  );
}

function SignalCard({
  signal,
  now,
  onMirror,
}: {
  signal: StrategySignal;
  now: number;
  onMirror: (s: StrategySignal) => void;
}) {
  const live = isSignalLive(signal, now);
  const [showReasons, setShowReasons] = useState(false);
  return (
    <article
      className={cn(
        'group relative overflow-hidden rounded-3xl border bg-[#0e1112] p-6 transition',
        live ? 'border-white/10 hover:border-[#32f27b]/30' : 'border-white/5 opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <PairAvatar baseSymbol={signal.baseSymbol} quoteSymbol={signal.quoteSymbol} />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-[#32f27b]/12 px-2 py-0.5 text-[11px] font-bold text-[#32f27b]">
                BUY
              </span>
              <span className="rounded-md bg-white/5 px-2 py-0.5 text-[11px] font-semibold text-neutral-400">
                Spot
              </span>
              {signal.aiApproved && (
                <button
                  type="button"
                  onClick={() => setShowReasons((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-md bg-sky-400/12 px-2 py-0.5 text-[11px] font-bold text-sky-300 transition hover:bg-sky-400/20"
                  aria-expanded={showReasons}
                >
                  <span aria-hidden="true">✓</span> Approved by AI
                </button>
              )}
            </div>
            <h3 className="mt-1.5 text-lg font-bold text-neutral-50">
              {signal.baseSymbol}
              <span className="font-medium text-neutral-500">/{signal.quoteSymbol}</span>
            </h3>
          </div>
        </div>
        <LivePill signal={signal} now={now} />
      </div>

      {signal.aiApproved && showReasons && signal.aiReasons && signal.aiReasons.length > 0 && (
        <div className="mt-3 rounded-2xl border border-sky-400/20 bg-sky-400/8 px-4 py-3">
          <p className="text-[11px] font-bold tracking-wide text-sky-300">WHY THE AI APPROVED IT</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-neutral-300">
            {signal.aiReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {signal.note && <p className="mt-4 text-sm text-neutral-400 italic">{signal.note}</p>}

      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Entry ref', value: `${fmtPrice(signal.entryPrice)} ${signal.quoteSymbol}` },
          { label: 'Max price', value: `${fmtPrice(signal.maxPrice)} ${signal.quoteSymbol}` },
          { label: 'Size', value: signal.sizeText ?? 'Your choice' },
          { label: 'Published', value: fmtAgo(signal.createdAt, now) },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl bg-white/[3%] px-3.5 py-3">
            <dt className="text-[11px] font-medium text-neutral-500">{s.label}</dt>
            <dd className="sc-number mt-1 text-sm font-semibold text-neutral-100">{s.value}</dd>
          </div>
        ))}
      </dl>

      <button
        type="button"
        onClick={() => onMirror(signal)}
        disabled={!live}
        className="mt-5 flex h-11 w-full items-center justify-center rounded-full bg-[#32f27b] text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
      >
        {live ? 'Mirror this trade' : 'Signal expired'}
      </button>
    </article>
  );
}

type MirrorPhase = 'amount' | 'quoting' | 'review' | 'signing' | 'done' | 'error';

function MirrorModal({ signal, onClose }: { signal: StrategySignal; onClose: () => void }) {
  const { publicKey, signTransaction } = useWallet();
  const [amount, setAmount] = useState('0.5');
  const [phase, setPhase] = useState<MirrorPhase>('amount');
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);

  const amountRaw = useMemo(() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0 || n > 10_000) return null;
    try {
      const raw = BigInt(Math.round(n * 10 ** signal.quoteDecimals));
      return raw > BigInt(0) ? raw.toString() : null;
    } catch {
      return null;
    }
  }, [amount, signal.quoteDecimals]);

  const getQuote = useCallback(async () => {
    if (!isSignalLive(signal, Date.now())) {
      setPhase('error');
      setError('This signal expired, mirror skipped');
      return;
    }
    if (amountRaw === null) {
      setPhase('error');
      setError('Enter an amount above zero');
      return;
    }
    setPhase('quoting');
    setError(null);
    try {
      const q = await fetchJupiterQuote({
        inputMint: signal.quoteMint,
        outputMint: signal.baseMint,
        amountRaw,
        slippageBps: MIRROR_SLIPPAGE_BPS,
      });
      const price = quoteToBasePrice(q.inAmount, q.outAmount, signal.quoteDecimals, signal.baseDecimals);
      if (price === null || !isPriceAcceptable(price, signal.maxPrice)) {
        setPhase('error');
        setError(
          price === null
            ? 'Live price came back unreadable, mirror skipped'
            : `Live price ${fmtPrice(price)} is above the signal max of ${fmtPrice(signal.maxPrice)}, mirror skipped`,
        );
        return;
      }
      setQuote(q);
      setLivePrice(price);
      setPhase('review');
    } catch (e) {
      setPhase('error');
      setError(friendlyError(e));
    }
  }, [signal, amountRaw]);

  const signAndSend = useCallback(async () => {
    if (!quote || !publicKey) return;
    if (!isSignalLive(signal, Date.now())) {
      setPhase('error');
      setError('This signal expired, mirror skipped');
      return;
    }
    if (!signTransaction) {
      setPhase('error');
      setError('Your wallet cannot sign this transaction');
      return;
    }
    setPhase('signing');
    setError(null);
    try {
      const swapB64 = await fetchJupiterSwapTransaction(quote, publicKey.toBase58());
      const bytes = Uint8Array.from(atob(swapB64), (c) => c.charCodeAt(0));
      const vtx = VersionedTransaction.deserialize(bytes);
      const signed = await signTransaction(vtx);
      const sig = await getConnection().sendRawTransaction(signed.serialize());
      setTxSig(sig);
      setPhase('done');
    } catch (e) {
      setPhase('error');
      setError(friendlyError(e));
    }
  }, [quote, publicKey, signTransaction, signal]);

  const expectedOut = useMemo(() => {
    if (!quote) return null;
    const n = Number(quote.outAmount) / 10 ** signal.baseDecimals;
    return Number.isFinite(n) ? n : null;
  }, [quote, signal.baseDecimals]);

  const solscan = txSig
    ? `https://solscan.io/tx/${txSig}${isDevnet() ? '?cluster=devnet' : ''}`
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-[#0e1112]">
        <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
          <div>
            <h3 className="text-base font-bold text-neutral-50">Mirror this signal</h3>
            <p className="text-xs text-neutral-500">
              Buy {signal.baseSymbol} with {signal.quoteSymbol}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-neutral-400 hover:bg-white/10"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-6 py-5">
          {phase === 'done' ? (
            <div className="py-4 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#32f27b]/15 text-2xl text-[#32f27b]">
                ✓
              </div>
              <p className="mt-4 text-base font-bold text-neutral-50">Mirrored. Your trade is on chain.</p>
              {solscan && (
                <a
                  href={solscan}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block text-sm font-semibold text-[#32f27b] hover:underline"
                >
                  View on Solscan
                </a>
              )}
            </div>
          ) : (
            <>
              <label className="text-xs font-semibold text-neutral-400" htmlFor="mirror-amount">
                You spend
              </label>
              <div className="mt-2 flex items-center gap-2">
                <input
                  id="mirror-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={phase === 'quoting' || phase === 'signing'}
                  className="sc-number h-12 w-full rounded-2xl border border-white/10 bg-white/[3%] px-4 text-lg font-semibold text-neutral-50 outline-none focus:border-[#32f27b]/50"
                />
                <span className="shrink-0 text-sm font-semibold text-neutral-400">{signal.quoteSymbol}</span>
              </div>
              <div className="mt-2 flex gap-2">
                {['0.1', '0.5', '1', '5'].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAmount(v)}
                    className="rounded-full bg-white/5 px-3 py-1 text-xs font-semibold text-neutral-300 hover:bg-white/10"
                  >
                    {v}
                  </button>
                ))}
              </div>

              <p className="mt-5 text-xs font-semibold text-neutral-400">Checks before signing</p>
              <ul className="mt-2 space-y-2">
                <li className="flex items-center justify-between rounded-2xl bg-white/[3%] px-4 py-2.5 text-sm">
                  <span className="text-neutral-300">Signal is live</span>
                  <span className="font-semibold text-[#32f27b]">✓</span>
                </li>
                <li className="flex items-center justify-between rounded-2xl bg-white/[3%] px-4 py-2.5 text-sm">
                  <span className="text-neutral-300">Live price at or under max</span>
                  <span className="sc-number font-semibold text-neutral-100">
                    {livePrice !== null ? `${fmtPrice(livePrice)} ${signal.quoteSymbol}` : 'on quote'}
                  </span>
                </li>
                <li className="flex items-center justify-between rounded-2xl bg-white/[3%] px-4 py-2.5 text-sm">
                  <span className="text-neutral-300">Slippage guard</span>
                  <span className="sc-number font-semibold text-neutral-100">1%</span>
                </li>
              </ul>

              {phase === 'review' && expectedOut !== null && (
                <div className="mt-4 rounded-2xl border border-[#32f27b]/20 bg-[#32f27b]/5 px-4 py-3">
                  <p className="sc-number text-sm font-semibold text-neutral-100">
                    You receive about {fmtPrice(expectedOut)} {signal.baseSymbol}
                  </p>
                </div>
              )}

              {phase === 'error' && error && (
                <p className="mt-4 rounded-2xl bg-[#fa6d74]/10 px-4 py-3 text-sm text-[#fa6d74]">{error}</p>
              )}

              {isDevnet() && (
                <p className="mt-4 text-xs text-neutral-500">
                  You are on devnet. Live routing settles on mainnet.
                </p>
              )}

              <div className="mt-5 flex gap-2">
                {phase === 'review' ? (
                  <button
                    type="button"
                    onClick={signAndSend}
                    className="flex h-12 flex-1 items-center justify-center rounded-full bg-[#32f27b] text-sm font-bold text-[#04120a] hover:bg-[#4bf78f]"
                  >
                    Sign in wallet
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={getQuote}
                    disabled={phase === 'quoting' || phase === 'signing' || amountRaw === null}
                    className="flex h-12 flex-1 items-center justify-center rounded-full bg-[#32f27b] text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60"
                  >
                    {phase === 'quoting' ? 'Fetching live quote…' : phase === 'signing' ? 'Waiting for your signature…' : 'Get a live quote'}
                  </button>
                )}
              </div>
              <p className="mt-3 text-center text-xs text-neutral-500">
                You review the exact swap in your wallet before signing.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function StrategiesPage() {
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const wallet = publicKey?.toBase58() ?? null;
  const [now, setNow] = useState(() => Date.now());
  const [mirrorSignal, setMirrorSignal] = useState<StrategySignal | null>(null);
  const [subPhase, setSubPhase] = useState<'idle' | 'sending' | 'confirming' | 'error'>('idle');
  const [subError, setSubError] = useState<string | null>(null);
  const [subSig, setSubSig] = useState<string | null>(null);

  const { sub, refresh } = useSubscription(wallet);
  const active = sub.kind === 'active';
  const { signals, error: feedError } = useSignals(active, wallet);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const subscribe = useCallback(async () => {
    if (!publicKey) {
      setShowModal(true);
      return;
    }
    const feeWallet = platformFeeWallet();
    if (!feeWallet) {
      setSubPhase('error');
      setSubError('Pass payments are not configured yet');
      return;
    }
    setSubPhase('sending');
    setSubError(null);
    try {
      const connection = getConnection();
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: feeWallet,
          lamports: SUBSCRIPTION_PRICE_LAMPORTS,
        }),
      );
      // Sign and broadcast directly instead of the adapter's sendTransaction:
      // the adapter can sit in its own confirmation wait for 30s, while the
      // server below is the real verifier and polls the chain itself.
      let sig: string;
      if (signTransaction) {
        const { blockhash } = await connection.getLatestBlockhash();
        tx.feePayer = publicKey;
        tx.recentBlockhash = blockhash;
        const signed = await signTransaction(tx);
        sig = await connection.sendRawTransaction(signed.serialize());
      } else {
        sig = await sendTransaction(tx, connection);
      }
      setSubSig(sig);
      setSubPhase('confirming');
      await activatePass(publicKey.toBase58(), sig);
      setSubPhase('idle');
      setSubSig(null);
      await refresh();
    } catch (e) {
      setSubPhase('error');
      setSubError(friendlyError(e));
    }
  }, [publicKey, sendTransaction, signTransaction, setShowModal, refresh]);

  // Re-check a payment that was already approved in the wallet. This never
  // creates a new transaction, so the user cannot be charged twice.
  const recheckPayment = useCallback(async () => {
    if (!publicKey || !subSig) return;
    setSubPhase('confirming');
    setSubError(null);
    try {
      await activatePass(publicKey.toBase58(), subSig);
      setSubPhase('idle');
      setSubSig(null);
      await refresh();
    } catch (e) {
      setSubPhase('error');
      setSubError(friendlyError(e));
    }
  }, [publicKey, subSig, refresh]);

  const daysLeft =
    sub.kind === 'active' ? Math.max(0, Math.ceil((sub.expiresAt - now) / 86_400_000)) : 0;

  return (
    <Page>
      <div className="mx-auto w-full max-w-3xl">
        <p className="text-[11px] font-bold tracking-[0.2em] text-[#32f27b]">STRATEGIES</p>
        <h1 className="mt-2 text-3xl font-bold text-neutral-50 md:text-4xl">
          One feed. Same signal for everyone.
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-400 md:text-base">
          Spot calls on crypto, published once for every subscriber. You review each one and
          sign every trade in your own wallet. Curv never touches your money.
        </p>
        <p className="mt-3 max-w-xl text-xs leading-relaxed text-neutral-500">
          Signals are market commentary, not financial advice. Past signals say nothing about
          future results.
        </p>

        <div className="mt-8">
          {!wallet && (
            <div className="rounded-3xl border border-white/10 bg-[#0e1112] p-8 text-center">
              <p className="text-base font-semibold text-neutral-200">Connect a wallet to continue</p>
              <p className="mt-2 text-sm text-neutral-500">
                Connecting only identifies you. It never permits a trade.
              </p>
              <button
                type="button"
                onClick={() => setShowModal(true)}
                className="mt-5 inline-flex h-11 items-center rounded-full bg-[#32f27b] px-7 text-sm font-bold text-[#04120a] hover:bg-[#4bf78f]"
              >
                Connect wallet
              </button>
            </div>
          )}

          {wallet && sub.kind === 'unknown' && (
            <div
              className="rounded-3xl border border-white/10 bg-[#0e1112] p-8 md:p-10"
              aria-busy="true"
              aria-label="Loading your pass status"
            >
              <div className="h-3 w-24 animate-pulse rounded-full bg-white/10" />
              <div className="mt-4 h-8 w-56 animate-pulse rounded-xl bg-white/10" />
              <div className="mt-6 space-y-3">
                <div className="h-4 w-3/4 animate-pulse rounded-full bg-white/5" />
                <div className="h-4 w-2/3 animate-pulse rounded-full bg-white/5" />
                <div className="h-4 w-1/2 animate-pulse rounded-full bg-white/5" />
              </div>
              <div className="mt-8 h-12 w-44 animate-pulse rounded-full bg-white/10" />
            </div>
          )}

          {wallet && sub.kind === 'none' && (
            <SubscribeCard
              onSubscribe={subscribe}
              onRecheck={recheckPayment}
              phase={subPhase}
              error={subError}
              signature={subSig}
            />
          )}

          {wallet && active && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-neutral-50">Live signals</h2>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#32f27b]/10 px-3 py-1 text-xs font-semibold text-[#32f27b]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#32f27b]" />
                  Pass active · {daysLeft}d left
                </span>
              </div>
              {feedError && (
                <p className="mt-4 rounded-2xl bg-[#fa6d74]/10 px-4 py-3 text-sm text-[#fa6d74]">
                  {feedError}
                </p>
              )}
              <div className="mt-4 space-y-4">
                {signals === null && !feedError && (
                  <div className="rounded-3xl border border-white/5 bg-[#0e1112] p-8 text-center text-sm text-neutral-500">
                    Loading the feed…
                  </div>
                )}
                {signals !== null && signals.length === 0 && (
                  <div className="rounded-3xl border border-white/5 bg-[#0e1112] p-10 text-center">
                    <p className="text-base font-semibold text-neutral-200">No live signals right now</p>
                    <p className="mt-2 text-sm text-neutral-500">
                      New calls appear here the moment they publish.
                    </p>
                  </div>
                )}
                {signals?.map((s) => (
                  <SignalCard key={s.id} signal={s} now={now} onMirror={setMirrorSignal} />
                ))}
              </div>
            </>
          )}
        </div>

        <p className="mt-8 text-center text-xs text-neutral-600">
          {SUBSCRIPTION_DURATION_MS / 86_400_000} days · {(SUBSCRIPTION_PRICE_LAMPORTS / LAMPORTS_PER_SOL).toFixed(2)} SOL flat ·{' '}
          <Link href="/faqs" className="underline hover:text-neutral-400">
            How mirroring works
          </Link>
        </p>
      </div>

      {mirrorSignal && <MirrorModal signal={mirrorSignal} onClose={() => setMirrorSignal(null)} />}
    </Page>
  );
}
