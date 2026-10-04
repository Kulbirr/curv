import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BN } from '@coral-xyz/anchor';
import { parseUiAmountToRaw, priceImpactPct, rawToUi } from '@/lib/swap-math';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import CurvyLoader from '../CurvyLoader';
import { getConnection, getDbcClient, isDevnet } from '@/lib/solana';
import { getCurrentPoint } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_SOL_MINT, type PoolStateResponse } from './types';
import { getMintDecimalsCached, useOnChainPool, type OnChainPool } from './useOnChainPool';
import { formatTokenCompact } from './chartFormat';
import { UsdRef } from '@/components/UsdRef';
import {
  isSignTimeout,
  signingTimeoutMessage,
  withSignTimeout,
} from '@/lib/sign-timeout';

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
    if (Date.now() > deadline) throw new Error('Timed out waiting for confirmation. Check the explorer for status.');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

interface Props {
  poolAddress: string;
  state: PoolStateResponse | undefined;
}

export default function TradePanel({ poolAddress, state }: Props) {
  const { publicKey, signTransaction, connected } = useWallet();
  const { setShowModal: setWalletModalVisible } = useUnifiedWalletContext();
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
    // Near-cap guard: a buy that would overshoot the remaining headroom
    // before graduation fails on-chain with 6033. Warn before the wallet
    // ever signs.
    if (side === 'buy' && state?.quoteReserve != null && state?.migrationQuoteThreshold != null) {
      const headroom = state.migrationQuoteThreshold - state.quoteReserve;
      if (headroom > 0) {
        const amountUi = parseFloat(amountStr);
        if (!isNaN(amountUi) && amountUi > 0) {
          // Conservative: the executable amount is slightly less than raw
          // headroom due to fees and price impact. Cap at 90%.
          const safeMax = headroom * 0.9;
          if (amountUi > safeMax) {
            return `Too large for the room left before graduation. Max about ${safeMax.toFixed(2)} ${inputSymbol}`;
          }
          // Warn when close to the cap even if under it.
          if (state.progress != null && state.progress > 95) {
            return null; // Let it through, but the 6033 handler covers failures.
          }
        }
      }
    }
    return null;
  }, [amountStr, balance, inputSymbol, onChain, graduated, side, state]);

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

  /** USD value of the typed amount, for the line under the input. Buy side is
   *  quote-denominated (SOL x live SOL price); sell side is token x token USD.
   *  Null when the amount or the price feed is missing. */
  const amountUsd = useMemo(() => {
    const amt = Number(amountStr);
    if (!Number.isFinite(amt) || amt <= 0) return null;
    const price = state?.price;
    const priceUsd = state?.priceUsd;
    if (typeof priceUsd !== 'number' || !Number.isFinite(priceUsd)) return null;
    if (side === 'sell') return amt * priceUsd;
    if (typeof price !== 'number' || !(price > 0)) return null;
    return (amt * priceUsd) / price;
  }, [amountStr, side, state?.price, state?.priceUsd]);

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

      const signed = await withSignTimeout(signTransaction(tx));
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
      const rawMsg = e instanceof Error ? e.message : 'Transaction failed';
      // Friendly message for the near-cap 6033: the buy was too large for
      // the remaining room before graduation. Never show raw program errors.
      const msg = /6033|0x1791|InsufficientLiquidity/i.test(rawMsg)
        ? 'This buy is too large for the room left before graduation. Try a smaller amount.'
        : isSignTimeout(e)
          ? signingTimeoutMessage()
          : rawMsg;
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
    <section className="sc-trade-panel" aria-label="Trade">
      <div className="sc-trade-side-tabs" role="tablist" aria-label="Trade direction">
        {(['buy', 'sell'] as Side[]).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            className={side === s ? 'selected' : ''}
            onClick={() => {
              setSide(s);
              setAmountStr('');
              setQuote(null);
              setError(null);
              setTxSig(null);
              setStatus('idle');
            }}
          >
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>

      {!connected ? (
        <div
          style={{
            display: 'grid',
            gap: 12,
            justifyItems: 'center',
            padding: '26px 12px',
            textAlign: 'center',
          }}
        >
          <p style={{ margin: 0, fontSize: 11, color: '#8c968d' }}>
            Connect your wallet to trade
          </p>
          <button
            type="button"
            className="sc-button sc-trade-submit"
            onClick={() => setWalletModalVisible(true)}
          >
            Connect wallet
          </button>
        </div>
      ) : graduated ? (
        <p
          style={{
            margin: '14px 0 0',
            padding: 12,
            borderRadius: 6,
            border: '1px solid #242b29',
            background: '#0d1110',
            fontSize: 12,
            color: '#8c968d',
            textAlign: 'center',
          }}
        >
          This pool has graduated and migrated to DAMM. Trading here is closed.
        </p>
      ) : onChainLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0' }}>
          <CurvyLoader size={36} />
        </div>
      ) : onChainError || !onChain ? (
        <p
          style={{
            margin: '14px 0 0',
            padding: 12,
            borderRadius: 6,
            border: '1px solid #242b29',
            background: '#0d1110',
            fontSize: 12,
            color: '#8c968d',
            textAlign: 'center',
          }}
        >
          Couldn&apos;t read the pool from the chain. Check your connection and try again.
        </p>
      ) : (
        <>
          <div className="sc-trade-input-heading">
            <label htmlFor="pool-amount">Amount</label>
            <span>
              {balance ? `${rawToUi(balance.raw, balance.decimals)} ${inputSymbol}` : '--'}
              {balance && balance.raw.gt(new BN(0)) && (
                <button
                  type="button"
                  onClick={setMax}
                  style={{
                    marginLeft: 6,
                    padding: 0,
                    border: 0,
                    background: 'transparent',
                    color: '#a9e778',
                    font: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  MAX
                </button>
              )}
            </span>
          </div>
          <div className="sc-trade-amount">
            <input
              id="pool-amount"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              aria-label={`Amount in ${inputSymbol}`}
            />
            <span>{inputSymbol}</span>
          </div>
          {amountUsd !== null && (
            <div className="sc-trade-usd">
              &asymp; $
              {amountUsd.toLocaleString('en-US', {
                maximumFractionDigits: 2,
                minimumFractionDigits: 2,
              })}
              {state?.usdReference && (
                <UsdRef reference={state.usdReference} hasUsd={true} />
              )}
            </div>
          )}

          {/* Quick amount presets */}
          <div className="sc-quick-amounts">
            {side === 'buy'
              ? buyPresets.map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => setAmountStr(String(amt))}
                  >
                    {amt} {inputSymbol}
                  </button>
                ))
              : sellPresets.map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => applySellPreset(pct)}
                    disabled={!balance || balance.raw.isZero()}
                    style={
                      !balance || balance.raw.isZero()
                        ? { opacity: 0.4, cursor: 'not-allowed' }
                        : undefined
                    }
                  >
                    {pct === 100 ? 'MAX' : `${pct}%`}
                  </button>
                ))}
          </div>

          <div className="sc-receive-row">
            <span>You receive</span>
            <strong
              title={
                quote ? `${quote.outputUi} ${outputSymbol}` : undefined
              }
            >
              {status === 'quoting'
                ? 'quoting…'
                : quote
                  ? `${formatTokenCompact(Number(quote.outputUi))} ${outputSymbol}`
                  : '--'}
            </strong>
          </div>
          {quote && (
            <>
              <div className="sc-receive-row" style={{ marginTop: 5 }}>
                <span>Minimum received</span>
                <strong
                  title={`${rawToUi(quote.minOutRaw, quote.outDecimals)} ${outputSymbol}`}
                >
                  {formatTokenCompact(
                    Number(rawToUi(quote.minOutRaw, quote.outDecimals))
                  )}{' '}
                  {outputSymbol}
                </strong>
              </div>
              {quote.priceImpactPct !== null && (
                <div className="sc-receive-row" style={{ marginTop: 5 }}>
                  <span>Price impact</span>
                  <strong
                    style={quote.priceImpactPct > 5 ? { color: '#f05f67' } : undefined}
                  >
                    ~{quote.priceImpactPct.toFixed(2)}%
                  </strong>
                </div>
              )}
            </>
          )}

          <div className="sc-trade-settings">
            <label>Slippage</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
              {SLIPPAGE_OPTIONS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  onClick={() => {
                    setSlippageBps(bps);
                    setCustomSlippage('');
                  }}
                  style={{
                    minHeight: 22,
                    padding: '0 7px',
                    border: '1px solid #242b29',
                    borderRadius: 5,
                    background:
                      slippageBps === bps && customSlippage === '' ? '#132016' : '#0e1211',
                    color: slippageBps === bps && customSlippage === '' ? '#74e799' : '#8b948b',
                    fontFamily: 'var(--sc-number)',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  {(bps / 100).toFixed(1)}%
                </button>
              ))}
              <input
                value={customSlippage}
                onChange={(e) => {
                  const v = e.target.value;
                  setCustomSlippage(v);
                  const n = Number(v);
                  if (v !== '' && Number.isFinite(n) && n > 0 && n <= 50)
                    setSlippageBps(Math.round(n * 100));
                }}
                inputMode="decimal"
                placeholder="Custom %"
                aria-label="Custom slippage percent"
                style={{
                  width: 64,
                  minHeight: 22,
                  padding: '0 7px',
                  border: '1px solid #242b29',
                  borderRadius: 5,
                  background: '#0e1211',
                  color: '#aeb8ae',
                  fontFamily: 'var(--sc-number)',
                  fontSize: 11,
                  outline: 'none',
                }}
              />
            </div>
            <span>Creator fee 0.3%</span>
          </div>

          {validationError && <p className="sc-trade-message">{validationError}</p>}
          {error && status === 'failed' && (
            <p className="sc-trade-message" role="alert">
              {error}
            </p>
          )}
          {status === 'confirmed' && txSig && (
            <p
              style={{
                margin: '10px 0 0',
                padding: 10,
                borderRadius: 6,
                border: '1px solid #1f3a28',
                background: '#0e1710',
                fontSize: 12,
                color: '#91c99c',
              }}
            >
              Swap confirmed.{' '}
              <a
                href={explorerUrl ?? '#'}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#c4f0c8', textDecoration: 'underline' }}
              >
                View on Solscan
              </a>
            </p>
          )}

          <button
            type="button"
            disabled={!canTrade || busy}
            onClick={execute}
            className={cn('sc-button sc-trade-submit', side === 'sell' && 'sell')}
            style={
              !canTrade || busy ? { opacity: 0.4, cursor: 'not-allowed' } : undefined
            }
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
          <p
            style={{
              margin: '10px 0 0',
              fontSize: 10,
              color: '#5f6a60',
              textAlign: 'center',
              lineHeight: 1.6,
            }}
          >
            Swaps execute on-chain via Meteora DBC. You sign every transaction in
            your wallet.
          </p>
        </>
      )}
    </section>
  );
}
