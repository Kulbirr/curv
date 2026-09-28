import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BN } from '@coral-xyz/anchor';
import { parseUiAmountToRaw, priceImpactPct, rawToUi } from '@/lib/swap-math';
import { PublicKey } from '@solana/web3.js';
import { useWallet, UnifiedWalletButton } from '@jup-ag/wallet-adapter';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { getConnection, getDbcClient, isDevnet } from '@/lib/solana';
import { getCurrentPoint } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_SOL_MINT, type PoolStateResponse } from './types';
import { getMintDecimalsCached, useOnChainPool, type OnChainPool } from './useOnChainPool';

type Side = 'buy' | 'sell';
type Status =
  | 'idle'
  | 'quoting'
  | 'ready'
  | 'signing'
  | 'sending'
  | 'confirming'
  | 'confirmed'
  | 'failed';

interface Quote {
  outputRaw: BN;
  minOutRaw: BN;
  outputUi: string;
  outDecimals: number;
  priceImpactPct: number | null;
}

const SLIPPAGE_OPTIONS = [50, 100, 200]; // bps

async function fetchBalance(owner: PublicKey, mint: string): Promise<{ raw: BN; decimals: number }> {
  const connection = getConnection();
  if (mint === NATIVE_SOL_MINT) {
    const lamports = await connection.getBalance(owner);
    return { raw: new BN(lamports.toString()), decimals: 9 };
  }
  const decimals = await getMintDecimalsCached(mint);
  // NOTE: web3.js 1.x's getTokenAccountsByOwner hardcodes base64 encoding in
  // its response validator, so passing { encoding: 'jsonParsed' } to it
  // breaks response parsing. getParsedTokenAccountsByOwner is the method
  // that pairs jsonParsed encoding with the parsed-data validator. Without
  // this, `data.parsed` is undefined and every SPL balance reads as zero
  // (which previously blocked UI sells with a false "Insufficient balance").
  const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  let total = new BN(0);
  for (const acc of resp.value) {
    const parsed = (acc.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed;
    const amount = parsed?.info?.tokenAmount?.amount;
    if (amount) total = total.add(new BN(amount));
  }
  return { raw: total, decimals };
}

async function pollSignatureStatus(signature: string): Promise<void> {
  const connection = getConnection();
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await connection.getSignatureStatus(signature);
    const status = res?.value;
    if (status?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for confirmation — check the explorer for status.');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

interface Props {
  poolAddress: string;
  state: PoolStateResponse | undefined;
}

export default function TradePanel({ poolAddress, state }: Props) {
  const { publicKey, signTransaction, connected } = useWallet();
  const queryClient = useQueryClient();
  const { data: onChain, isLoading: onChainLoading, isError: onChainError } = useOnChainPool(poolAddress);

  const [side, setSide] = useState<Side>('buy');
  const [amountStr, setAmountStr] = useState('');
  const [slippageBps, setSlippageBps] = useState(100);
  const [customSlippage, setCustomSlippage] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [balance, setBalance] = useState<{ raw: BN; decimals: number } | null>(null);
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True while a swap is being executed; blocks quote resets mid-flow. */
  const executingRef = useRef(false);

  const graduated = state?.graduated === true;

  const inputMint = useMemo(() => {
    if (!onChain) return null;
    return side === 'buy' ? onChain.quoteMint : onChain.baseMint;
  }, [onChain, side]);
  const outputMint = useMemo(() => {
    if (!onChain) return null;
    return side === 'buy' ? onChain.baseMint : onChain.quoteMint;
  }, [onChain, side]);
  const inputSymbol = side === 'buy' ? state?.quoteSymbol : state?.baseSymbol;
  const outputSymbol = side === 'buy' ? state?.baseSymbol : state?.quoteSymbol;

  // Balance of the input mint.
  useEffect(() => {
    if (!publicKey || !inputMint) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    fetchBalance(publicKey, inputMint)
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => {
        if (!cancelled) setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey, inputMint, side, txSig]);

  const doQuote = useCallback(
    async (oc: OnChainPool, amountRaw: BN, inDecimals: number, outDecimals: number) => {
      const client = getDbcClient();
      const connection = getConnection();
      const config = oc.config as {
        activationType?: number;
        enableFirstSwapWithMinFee?: boolean;
      };
      const ps = (oc.virtualPool as { poolState?: Record<string, unknown> }).poolState ?? {};
      const hasSwap = Number(ps['hasSwap'] ?? 0) === 1;
      const eligibleForFirstSwapWithMinFee = config.enableFirstSwapWithMinFee === true && !hasSwap;
      const currentPoint = await getCurrentPoint(connection, (config.activationType ?? 1) as 0 | 1);
      // The SDK's SwapQuoteResult IDL typing does not resolve `outputAmount`,
      // but the runtime returns { ...swapResult, minimumAmountOut } where
      // swapResult always carries outputAmount (see getSwapResult in the SDK).
      const q = client.pool.swapQuote({
        virtualPool: oc.virtualPool as never,
        config: oc.config as never,
        swapBaseForQuote: side === 'sell',
        amountIn: amountRaw,
        slippageBps,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee,
        currentPoint,
      }) as unknown as { outputAmount: BN; minimumAmountOut: BN };
      const outputRaw = q.outputAmount;
      const minOutRaw = q.minimumAmountOut;
      const outputUi = rawToUi(outputRaw, outDecimals);

      // Price impact vs the live spot price (quote per base). Display only.
      const impact = priceImpactPct(side, amountRaw, inDecimals, outputRaw, outDecimals, state?.price);
      return { outputRaw, minOutRaw, outputUi, outDecimals, priceImpactPct: impact } as Quote;
    },
    [side, slippageBps, state?.price]
  );

  // Debounced quoting.
  useEffect(() => {
    if (quoteTimer.current) clearTimeout(quoteTimer.current);
    setQuote(null);
    if (!onChain || !inputMint || !outputMint || graduated) {
      setStatus('idle');
      return;
    }
    if (executingRef.current) return;
    setStatus('idle');
    setError(null);

    let cancelled = false;
    const run = async () => {
      try {
        const inDecimals = inputMint === NATIVE_SOL_MINT ? 9 : await getMintDecimalsCached(inputMint);
        const outDecimals = outputMint === NATIVE_SOL_MINT ? 9 : await getMintDecimalsCached(outputMint);
        const amountRaw = parseUiAmountToRaw(amountStr, inDecimals);
        if (!amountRaw || cancelled) return;
        setStatus('quoting');
        const q = await doQuote(onChain, amountRaw, inDecimals, outDecimals);
        if (cancelled) return;
        setQuote(q);
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Quote failed');
        setStatus('failed');
      }
    };
    quoteTimer.current = setTimeout(run, 450);
    return () => {
      cancelled = true;
      if (quoteTimer.current) clearTimeout(quoteTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountStr, side, slippageBps, onChain, inputMint, outputMint, graduated]);

  const validationError = useMemo(() => {
    if (!onChain || graduated) return null;
    if (!amountStr.trim()) return null;
    const raw = parseUiAmountToRaw(amountStr, balance?.decimals ?? 9);
    if (!raw) return 'Enter a valid amount greater than zero';
    if (balance && raw.gt(balance.raw)) return `Insufficient ${inputSymbol} balance`;
    return null;
  }, [amountStr, balance, inputSymbol, onChain, graduated]);

  const setMax = () => {
    if (!balance) return;
    let raw = balance.raw;
    if (inputMint === NATIVE_SOL_MINT) {
      // Leave a buffer for transaction fees.
      const buffer = new BN(5_000_000); // 0.005 SOL
      if (raw.gt(buffer)) raw = raw.sub(buffer);
    }
    setAmountStr(rawToUi(raw, balance.decimals));
  };

  /** Quick-fill presets above the amount input. */
  const buyPresets = useMemo(() => {
    // Quote-denominated quick amounts; smaller steps for SOL, rounder for the rest.
    return state?.quoteSymbol === 'SOL' ? [0.1, 0.5, 1, 5] : [1, 10, 50, 100];
  }, [state?.quoteSymbol]);
  const sellPresets = useMemo(() => [25, 50, 75, 100], []);

  const applySellPreset = (pct: number) => {
    if (!balance) return;
    if (pct >= 100) {
      setMax();
      return;
    }
    const raw = balance.raw.mul(new BN(pct)).div(new BN(100));
    setAmountStr(rawToUi(raw, balance.decimals));
  };

  const execute = async () => {
    if (!publicKey || !signTransaction || !onChain || !inputMint || !quote) return;
    setError(null);
    setTxSig(null);
    executingRef.current = true;
    try {
      const client = getDbcClient();
      const connection = getConnection();
      const inDecimals = inputMint === NATIVE_SOL_MINT ? 9 : await getMintDecimalsCached(inputMint);
      const amountRaw = parseUiAmountToRaw(amountStr, inDecimals);
      if (!amountRaw) throw new Error('Invalid amount');

      // Re-quote immediately before building so minimumAmountOut is fresh.
      setStatus('quoting');
      const outDecimals =
        (side === 'buy' ? onChain.baseMint : onChain.quoteMint) === NATIVE_SOL_MINT
          ? 9
          : await getMintDecimalsCached(side === 'buy' ? onChain.baseMint : onChain.quoteMint);
      const fresh = await doQuote(onChain, amountRaw, inDecimals, outDecimals);
      setQuote(fresh);

      setStatus('signing');
      const tx = await client.pool.swap({
        owner: publicKey,
        payer: publicKey,
        pool: new PublicKey(poolAddress),
        amountIn: amountRaw,
        minimumAmountOut: fresh.minOutRaw,
        swapBaseForQuote: side === 'sell',
        referralTokenAccount: null,
      });
      tx.feePayer = publicKey;
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      const signed = await signTransaction(tx);
      setStatus('sending');
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      setTxSig(sig);
      setStatus('confirming');
      await pollSignatureStatus(sig);
      setStatus('confirmed');
      setAmountStr('');
      setQuote(null);
      // Refresh balances and market data.
      if (inputMint && publicKey) {
        fetchBalance(publicKey, inputMint).then(setBalance).catch(() => {});
      }
      queryClient.invalidateQueries({ queryKey: ['pool-state', poolAddress] });
      queryClient.invalidateQueries({ queryKey: ['pool-history', poolAddress] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Transaction failed';
      // User rejecting in the wallet is not an app error worth alarming about.
      setError(msg);
      setStatus('failed');
    } finally {
      executingRef.current = false;
    }
  };

  const explorerUrl = txSig
    ? `https://solscan.io/tx/${txSig}${isDevnet() ? '?cluster=devnet' : ''}`
    : null;

  const busy = status === 'quoting' || status === 'signing' || status === 'sending' || status === 'confirming';
  const canTrade =
    connected && !!publicKey && !!onChain && !graduated && status === 'ready' && !validationError && !!quote;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-neutral-800/60 bg-neutral-950 p-5">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-neutral-900 p-1">
        {(['buy', 'sell'] as Side[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setSide(s);
              setAmountStr('');
              setQuote(null);
              setError(null);
              setTxSig(null);
              setStatus('idle');
            }}
            className={cn(
              'rounded-lg py-2 text-sm font-semibold capitalize transition-colors',
              side === s
                ? s === 'buy'
                  ? 'bg-emerald-500 text-black'
                  : 'bg-rose-500 text-black'
                : 'text-neutral-400 hover:text-neutral-200'
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {!connected ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="text-sm text-neutral-400">Connect your wallet to trade</p>
          <UnifiedWalletButton />
        </div>
      ) : graduated ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-center text-sm text-neutral-400">
          This pool has graduated and migrated to DAMM. Trading here is closed.
        </div>
      ) : onChainLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-700 border-t-primary" />
        </div>
      ) : onChainError || !onChain ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-center text-sm text-neutral-400">
          Couldn&apos;t read the pool from the chain. Check your connection and try again.
        </div>
      ) : (
        <>
          {/* Quick amount presets */}
          <div className="flex flex-wrap items-center gap-1.5">
            {side === 'buy' ? (
              <>
                {buyPresets.map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => setAmountStr(String(amt))}
                    className="rounded-lg bg-neutral-900 px-2.5 py-1 text-xs font-semibold text-neutral-300 tabular-nums hover:bg-neutral-800 hover:text-neutral-100"
                  >
                    {amt} {inputSymbol}
                  </button>
                ))}
              </>
            ) : (
              <>
                {sellPresets.map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => applySellPreset(pct)}
                    disabled={!balance || balance.raw.isZero()}
                    className="rounded-lg bg-neutral-900 px-2.5 py-1 text-xs font-semibold text-neutral-300 tabular-nums hover:bg-neutral-800 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {pct === 100 ? 'MAX' : `${pct}%`}
                  </button>
                ))}
              </>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="text-neutral-500">You {side === 'buy' ? 'pay' : 'sell'}</span>
              <span className="text-neutral-500 tabular-nums">
                Balance:{' '}
                {balance ? (
                  <span className="text-neutral-300">
                    {rawToUi(balance.raw, balance.decimals)} {inputSymbol}
                  </span>
                ) : (
                  '—'
                )}
                {balance && balance.raw.gt(new BN(0)) && (
                  <button
                    type="button"
                    onClick={setMax}
                    className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 font-semibold text-primary hover:bg-primary/20"
                  >
                    MAX
                  </button>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5 focus-within:border-neutral-600">
              <input
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                inputMode="decimal"
                placeholder="0.0"
                className="w-full bg-transparent text-lg font-semibold text-neutral-50 tabular-nums outline-none placeholder:text-neutral-600"
              />
              <span className="shrink-0 text-sm font-semibold text-neutral-400">{inputSymbol}</span>
            </div>
          </div>

          <div className="flex items-center justify-center text-neutral-600">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
          </div>

          <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 px-3 py-2.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-500">You receive</span>
              <span className="font-semibold text-neutral-100 tabular-nums">
                {status === 'quoting' ? (
                  <span className="text-neutral-500">quoting…</span>
                ) : quote ? (
                  `${quote.outputUi} ${outputSymbol}`
                ) : (
                  '—'
                )}
              </span>
            </div>
            {quote && (
              <div className="mt-1.5 space-y-1 text-xs text-neutral-500">
                <div className="flex justify-between">
                  <span>Minimum received</span>
                  <span className="tabular-nums text-neutral-300">
                    {rawToUi(quote.minOutRaw, quote.outDecimals)} {outputSymbol}
                  </span>
                </div>
                {quote.priceImpactPct !== null && (
                  <div className="flex justify-between">
                    <span>Price impact</span>
                    <span className={cn('tabular-nums', quote.priceImpactPct > 5 ? 'text-rose-400' : 'text-neutral-300')}>
                      {quote.priceImpactPct >= 0 ? '~' : '~'}
                      {quote.priceImpactPct.toFixed(2)}%
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-xs text-neutral-500">Slippage tolerance</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {SLIPPAGE_OPTIONS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  onClick={() => {
                    setSlippageBps(bps);
                    setCustomSlippage('');
                  }}
                  className={cn(
                    'rounded-lg px-2.5 py-1 text-xs font-semibold',
                    slippageBps === bps && customSlippage === ''
                      ? 'bg-primary text-black'
                      : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                  )}
                >
                  {(bps / 100).toFixed(1)}%
                </button>
              ))}
              <div className="flex items-center gap-1">
                <input
                  value={customSlippage}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCustomSlippage(v);
                    const n = Number(v);
                    if (v !== '' && Number.isFinite(n) && n > 0 && n <= 50) setSlippageBps(Math.round(n * 100));
                  }}
                  inputMode="decimal"
                  placeholder="Custom %"
                  className="w-20 rounded-lg bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none placeholder:text-neutral-600"
                />
              </div>
            </div>
          </div>

          {validationError && <p className="text-xs text-rose-400">{validationError}</p>}
          {error && status === 'failed' && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
              {error}
            </div>
          )}
          {status === 'confirmed' && txSig && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
              <span className="font-semibold text-emerald-300">Swap confirmed. </span>
              <a
                href={explorerUrl ?? '#'}
                target="_blank"
                rel="noreferrer"
                className="text-emerald-300 underline hover:text-emerald-200"
              >
                View on Solscan
              </a>
            </div>
          )}

          <button
            type="button"
            disabled={!canTrade || busy}
            onClick={execute}
            className={cn(
              'rounded-xl py-3 text-sm font-bold transition-opacity',
              side === 'buy' ? 'bg-emerald-500 text-black' : 'bg-rose-500 text-black',
              (!canTrade || busy) && 'cursor-not-allowed opacity-40'
            )}
          >
            {status === 'quoting'
              ? 'Quoting…'
              : status === 'signing'
                ? 'Sign in wallet…'
                : status === 'sending'
                  ? 'Sending…'
                  : status === 'confirming'
                    ? 'Confirming…'
                    : `Swap ${inputSymbol} → ${outputSymbol}`}
          </button>
          <p className="text-center text-[11px] text-neutral-600">
            Swaps execute on-chain via Meteora DBC. You sign every transaction in your wallet.
          </p>
        </>
      )}
    </div>
  );
}
