import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';

/**
 * Jupiter swap API client for strategy mirroring and post graduation trading.
 *
 * Used strictly client side: the app fetches a quote, checks it against
 * guards, then asks Jupiter to build the swap transaction, which the USER
 * signs in their own wallet. The server never calls this module and never
 * sees the transaction.
 *
 * Jupiter is mainnet routing. On devnet the quote request fails and the
 * caller surfaces an honest message instead of a trade.
 */

const JUP_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';

/** Referral cut on post graduation swaps, in basis points. 25 = 0.25%. */
export const JUPITER_REFERRAL_FEE_BPS = 25;

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  /** Input amount in raw units (lamports / token base units). */
  amountRaw: string;
  slippageBps: number;
  /** Optional integrator fee in bps. 0 or omitted = no fee. */
  platformFeeBps?: number;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** Minimum output after slippage, raw units. Null when Jupiter omits it. */
  otherAmountThreshold: string | null;
  /** Percent, e.g. 0.42 means 0.42%. Null when Jupiter omits it. */
  priceImpactPct: number | null;
  /** Top route venue label, e.g. "Meteora DAMM v2". Null when absent. */
  venueLabel: string | null;
  /** The platform fee bps the quote was requested with. */
  platformFeeBps: number;
  /**
   * The untouched quote response. Jupiter's swap endpoint requires the
   * full quote object back (otherAmountThreshold, route plan and all),
   * so the stripped fields above are only a convenience view.
   */
  raw: Record<string, unknown>;
}

export class JupiterError extends Error {
  /** Safe to show in the UI. Dash free. */
  readonly friendly: string;
  constructor(friendly: string) {
    super(friendly);
    this.name = 'JupiterError';
    this.friendly = friendly;
  }
}

type FetchFn = typeof fetch;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseQuote(json: unknown, platformFeeBps: number): JupiterQuote {
  if (!isRecord(json)) throw new JupiterError('Live quote came back unreadable');
  const { inputMint, outputMint, inAmount, outAmount } = json;
  if (
    typeof inputMint !== 'string' ||
    typeof outputMint !== 'string' ||
    typeof inAmount !== 'string' ||
    typeof outAmount !== 'string'
  ) {
    throw new JupiterError('Live quote came back unreadable');
  }
  const otherAmountThreshold =
    typeof json.otherAmountThreshold === 'string' ? json.otherAmountThreshold : null;
  let priceImpactPct: number | null = null;
  if (typeof json.priceImpactPct === 'string') {
    const n = Number(json.priceImpactPct);
    if (Number.isFinite(n) && n >= 0) priceImpactPct = n;
  }
  let venueLabel: string | null = null;
  if (Array.isArray(json.routePlan) && json.routePlan.length > 0) {
    const first = json.routePlan[0];
    if (isRecord(first)) {
      const swapInfo = first.swapInfo;
      if (isRecord(swapInfo) && typeof swapInfo.label === 'string' && swapInfo.label) {
        venueLabel = swapInfo.label;
      }
    }
  }
  return {
    inputMint,
    outputMint,
    inAmount,
    outAmount,
    otherAmountThreshold,
    priceImpactPct,
    venueLabel,
    platformFeeBps,
    raw: json,
  };
}

/** API key for headroom above the keyless rate limit. Optional. */
export function jupiterApiKey(): string | null {
  const k =
    process.env.NEXT_PUBLIC_JUPITER_API_KEY?.trim() ||
    process.env.JUPITER_API_KEY?.trim() ||
    '';
  return k ? k : null;
}

function jupiterHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  const key = jupiterApiKey();
  if (key) h['x-api-key'] = key;
  return h;
}

/**
 * Fetch a fresh swap quote. Throws JupiterError with a UI safe message
 * when routing is unavailable (including on devnet).
 */
export async function fetchJupiterQuote(
  params: JupiterQuoteParams,
  fetchFn: FetchFn = fetch,
): Promise<JupiterQuote> {
  const feeBps = Math.max(0, Math.floor(params.platformFeeBps ?? 0));
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amountRaw,
    slippageBps: String(params.slippageBps),
  });
  if (feeBps > 0) qs.set('platformFeeBps', String(feeBps));
  let res: Response;
  try {
    res = await fetchFn(`${JUP_QUOTE_URL}?${qs.toString()}`, {
      headers: jupiterHeaders(),
    });
  } catch {
    throw new JupiterError('Live quotes are unreachable right now');
  }
  if (!res.ok) {
    if (res.status === 400 || res.status === 404) {
      throw new JupiterError('No route for this pair right now');
    }
    throw new JupiterError('Live quotes are unreachable right now');
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new JupiterError('Live quote came back unreadable');
  }
  return parseQuote(json, feeBps);
}

export interface JupiterSwapOptions {
  /** wSOL ATA of the fee wallet. Omit for no referral fee. */
  feeAccount?: string;
}

/**
 * Ask Jupiter to build the swap transaction for a quote the user already
 * approved the bounds of. Returns the base64 transaction for the user's
 * wallet to sign. Throws JupiterError with a UI safe message on failure.
 */
export async function fetchJupiterSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: string,
  optsOrFetch: JupiterSwapOptions | FetchFn = {},
  fetchFn: FetchFn = fetch,
): Promise<string> {
  // Backward compatible: the third argument used to be the fetch function.
  const opts: JupiterSwapOptions = typeof optsOrFetch === 'function' ? {} : optsOrFetch;
  const fetcher: FetchFn = typeof optsOrFetch === 'function' ? optsOrFetch : fetchFn;
  const body: Record<string, unknown> = {
    quoteResponse: quote.raw,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  };
  if (opts.feeAccount) body.feeAccount = opts.feeAccount;
  let res: Response;
  try {
    res = await fetcher(JUP_SWAP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...jupiterHeaders() },
      body: JSON.stringify(body),
    });
  } catch {
    throw new JupiterError('Could not build the swap, please try again');
  }
  if (!res.ok) throw new JupiterError('Could not build the swap, please try again');
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new JupiterError('Could not build the swap, please try again');
  }
  if (!isRecord(json) || typeof json.swapTransaction !== 'string' || json.swapTransaction.length === 0) {
    throw new JupiterError('Could not build the swap, please try again');
  }
  return json.swapTransaction;
}

/**
 * The wSOL associated token account of the Curv fee wallet, the
 * destination for Jupiter referral fees. Null when the fee wallet is not
 * configured. Pure address derivation: does not check the account exists.
 */
export function jupiterReferralFeeAccount(): string | null {
  const wallet = process.env.NEXT_PUBLIC_CURV_FEE_WALLET?.trim();
  if (!wallet) return null;
  try {
    return getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(wallet)).toBase58();
  } catch {
    return null;
  }
}

/**
 * The fee payer of a versioned transaction: the first static account key.
 * Pure and testable.
 */
export function getVersionedTxFeePayer(tx: VersionedTransaction): string {
  return tx.message.staticAccountKeys[0].toBase58();
}

export interface JupiterQuoteCheck {
  ok: boolean;
  /** UI safe reason when ok is false. Dash free. */
  error?: string;
}

/**
 * Pre sign sanity check on a Jupiter quote before building the swap:
 * the input amount must be exactly what the user typed, and the
 * minimum output must respect the selected slippage. Pure and testable.
 */
export function validateJupiterQuoteAmounts(
  quote: JupiterQuote,
  expectedInAmountRaw: string,
  slippageBps: number,
): JupiterQuoteCheck {
  if (quote.inAmount !== expectedInAmountRaw) {
    return { ok: false, error: 'The quote changed, please try again' };
  }
  if (quote.otherAmountThreshold === null) {
    return { ok: false, error: 'The quote is missing its minimum output, please try again' };
  }
  try {
    const out = BigInt(quote.outAmount);
    const minOut = BigInt(quote.otherAmountThreshold);
    const floor = (out * BigInt(10000 - slippageBps)) / BigInt(10000);
    if (minOut < floor) {
      return { ok: false, error: 'The quote moved outside your slippage, please try again' };
    }
  } catch {
    return { ok: false, error: 'The quote came back unreadable, please try again' };
  }
  return { ok: true };
}
