/**
 * Jupiter swap API client for strategy mirroring.
 *
 * Used strictly client side: the app fetches a quote, checks it against
 * the signal's guards, then asks Jupiter to build the swap transaction,
 * which the USER signs in their own wallet. The server never calls this
 * module and never sees the transaction.
 *
 * Jupiter is mainnet routing. On devnet the quote request fails and the
 * caller surfaces an honest message instead of a trade.
 */

const JUP_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  /** Input amount in raw units (lamports / token base units). */
  amountRaw: string;
  slippageBps: number;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
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

function parseQuote(json: unknown): JupiterQuote {
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
  return { inputMint, outputMint, inAmount, outAmount, raw: json };
}

/**
 * Fetch a fresh swap quote. Throws JupiterError with a UI safe message
 * when routing is unavailable (including on devnet).
 */
export async function fetchJupiterQuote(
  params: JupiterQuoteParams,
  fetchFn: FetchFn = fetch,
): Promise<JupiterQuote> {
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amountRaw,
    slippageBps: String(params.slippageBps),
  });
  let res: Response;
  try {
    res = await fetchFn(`${JUP_QUOTE_URL}?${qs.toString()}`, {
      headers: { accept: 'application/json' },
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
  return parseQuote(json);
}

/**
 * Ask Jupiter to build the swap transaction for a quote the user already
 * approved the bounds of. Returns the base64 transaction for the user's
 * wallet to sign. Throws JupiterError with a UI safe message on failure.
 */
export async function fetchJupiterSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: string,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(JUP_SWAP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
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
