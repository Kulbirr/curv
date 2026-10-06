import { describe, expect, it, afterEach } from 'vitest';
import {
  JupiterError,
  JUPITER_REFERRAL_FEE_BPS,
  fetchJupiterQuote,
  fetchJupiterSwapTransaction,
  getVersionedTxFeePayer,
  jupiterReferralFeeAccount,
  validateJupiterQuoteAmounts,
  type JupiterQuote,
} from './jupiter';

const PARAMS = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amountRaw: '100000000',
  slippageBps: 100,
};

function okJson(json: unknown) {
  return async () =>
    ({
      ok: true,
      status: 200,
      json: async () => json,
    }) as Response;
}

describe('fetchJupiterQuote', () => {
  it('parses a good quote', async () => {
    const q = await fetchJupiterQuote(
      PARAMS,
      okJson({ inputMint: PARAMS.inputMint, outputMint: PARAMS.outputMint, inAmount: '100000000', outAmount: '500000' }),
    );
    expect(q.outAmount).toBe('500000');
  });
  it('rejects unreadable quotes', async () => {
    await expect(fetchJupiterQuote(PARAMS, okJson({ nope: true }))).rejects.toBeInstanceOf(JupiterError);
  });
  it('maps 400 to no route', async () => {
    const f = async () => ({ ok: false, status: 400 }) as Response;
    const err = await fetchJupiterQuote(PARAMS, f).catch((e) => e);
    expect(err).toBeInstanceOf(JupiterError);
    expect((err as JupiterError).friendly).toBe('No route for this pair right now');
  });
  it('maps network failure to unreachable', async () => {
    const f = async () => {
      throw new Error('down');
    };
    const err = await fetchJupiterQuote(PARAMS, f as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(JupiterError);
    expect((err as JupiterError).friendly).toBe('Live quotes are unreachable right now');
  });
  it('sends the right query params', async () => {
    let seen = '';
    const f = async (input: string) => {
      seen = input;
      return { ok: true, status: 200, json: async () => ({ inputMint: 'a', outputMint: 'b', inAmount: '1', outAmount: '2' }) } as Response;
    };
    await fetchJupiterQuote(PARAMS, f as typeof fetch);
    expect(seen).toContain('lite-api.jup.ag/swap/v1/quote');
    expect(seen).toContain(`inputMint=${encodeURIComponent(PARAMS.inputMint)}`);
    expect(seen).toContain('slippageBps=100');
  });
  it('adds platformFeeBps when set', async () => {
    let seen = '';
    const f = async (input: string) => {
      seen = input;
      return { ok: true, status: 200, json: async () => ({ inputMint: 'a', outputMint: 'b', inAmount: '1', outAmount: '2' }) } as Response;
    };
    const q = await fetchJupiterQuote({ ...PARAMS, platformFeeBps: 25 }, f as typeof fetch);
    expect(seen).toContain('platformFeeBps=25');
    expect(q.platformFeeBps).toBe(25);
  });
  it('omits platformFeeBps when zero', async () => {
    let seen = '';
    const f = async (input: string) => {
      seen = input;
      return { ok: true, status: 200, json: async () => ({ inputMint: 'a', outputMint: 'b', inAmount: '1', outAmount: '2' }) } as Response;
    };
    await fetchJupiterQuote({ ...PARAMS, platformFeeBps: 0 }, f as typeof fetch);
    expect(seen).not.toContain('platformFeeBps');
  });
  it('parses price impact and venue label', async () => {
    const q = await fetchJupiterQuote(
      PARAMS,
      okJson({
        inputMint: 'a',
        outputMint: 'b',
        inAmount: '1',
        outAmount: '2',
        priceImpactPct: '0.42',
        routePlan: [{ swapInfo: { label: 'Meteora DAMM v2' } }],
      }),
    );
    expect(q.priceImpactPct).toBe(0.42);
    expect(q.venueLabel).toBe('Meteora DAMM v2');
  });
  it('tolerates missing price impact and route plan', async () => {
    const q = await fetchJupiterQuote(
      PARAMS,
      okJson({ inputMint: 'a', outputMint: 'b', inAmount: '1', outAmount: '2' }),
    );
    expect(q.priceImpactPct).toBeNull();
    expect(q.venueLabel).toBeNull();
    expect(q.otherAmountThreshold).toBeNull();
  });
});

describe('fetchJupiterSwapTransaction', () => {
  const quote: JupiterQuote = {
    inputMint: 'a',
    outputMint: 'b',
    inAmount: '1',
    outAmount: '2',
    otherAmountThreshold: '1',
    priceImpactPct: null,
    venueLabel: null,
    platformFeeBps: 0,
    raw: { inputMint: 'a', outputMint: 'b', inAmount: '1', outAmount: '2', otherAmountThreshold: '1' },
  };
  it('returns the base64 transaction', async () => {
    const tx = await fetchJupiterSwapTransaction(
      quote,
      'Wallet1111111111111111111111111111111111111',
      okJson({ swapTransaction: 'aGVsbG8=' }),
    );
    expect(tx).toBe('aGVsbG8=');
  });
  it('sends the full quote response back to the swap endpoint', async () => {
    let seenBody: unknown = null;
    const f = (async (_url: unknown, init: unknown) => {
      seenBody = JSON.parse((init as { body: string }).body);
      return { ok: true, status: 200, json: async () => ({ swapTransaction: 'aGVsbG8=' }) };
    }) as typeof fetch;
    await fetchJupiterSwapTransaction(quote, 'Wallet1111111111111111111111111111111111111', f);
    const body = seenBody as { quoteResponse: Record<string, unknown> };
    expect(body.quoteResponse.otherAmountThreshold).toBe('1');
  });
  it('fails closed on bad payloads', async () => {
    await expect(fetchJupiterSwapTransaction(quote, 'w', okJson({}))).rejects.toBeInstanceOf(JupiterError);
    const bad = async () => ({ ok: false, status: 500 }) as Response;
    await expect(fetchJupiterSwapTransaction(quote, 'w', bad)).rejects.toBeInstanceOf(JupiterError);
  });
  it('friendly messages are dash free', async () => {    const errs: JupiterError[] = [];
    const fns: Array<typeof fetch> = [
      (async () => {
        throw new Error('x');
      }) as typeof fetch,
      (async () => ({ ok: false, status: 400 }) as Response) as typeof fetch,
      (async () =>
        ({ ok: true, status: 200, json: async () => ({}) }) as Response) as typeof fetch,
    ];
    for (const f of fns) {
      errs.push(await fetchJupiterQuote(PARAMS, f).catch((e) => e));
    }
    for (const e of errs) {
      expect(e.friendly).not.toContain('-');
    }
  });
});

describe('fetchJupiterSwapTransaction fee account', () => {
  const quote: JupiterQuote = {
    inputMint: 'a',
    outputMint: 'b',
    inAmount: '1',
    outAmount: '2',
    otherAmountThreshold: '1',
    priceImpactPct: null,
    venueLabel: null,
    platformFeeBps: 25,
    raw: { inputMint: 'a', outputMint: 'b', inAmount: '1', outAmount: '2' },
  };
  function captureBody() {
    let seenBody: unknown = null;
    const f = (async (_url: unknown, init: unknown) => {
      seenBody = JSON.parse((init as { body: string }).body);
      return { ok: true, status: 200, json: async () => ({ swapTransaction: 'aGVsbG8=' }) };
    }) as typeof fetch;
    return { f, body: () => seenBody as Record<string, unknown> };
  }
  it('sends feeAccount when provided', async () => {
    const { f, body } = captureBody();
    await fetchJupiterSwapTransaction(quote, 'w', { feeAccount: 'Fee1111111111111111111111111111111111111' }, f);
    expect(body().feeAccount).toBe('Fee1111111111111111111111111111111111111');
  });
  it('omits feeAccount when not provided', async () => {
    const { f, body } = captureBody();
    await fetchJupiterSwapTransaction(quote, 'w', {}, f);
    expect('feeAccount' in body()).toBe(false);
  });
  it('keeps the old (quote, key, fetchFn) call shape working', async () => {
    const { f, body } = captureBody();
    const tx = await fetchJupiterSwapTransaction(quote, 'w', f);
    expect(tx).toBe('aGVsbG8=');
    expect('feeAccount' in body()).toBe(false);
  });
});

describe('validateJupiterQuoteAmounts', () => {
  const base: JupiterQuote = {
    inputMint: 'a',
    outputMint: 'b',
    inAmount: '100000000',
    outAmount: '5000000',
    otherAmountThreshold: '4950000',
    priceImpactPct: 0.5,
    venueLabel: 'Meteora DAMM v2',
    platformFeeBps: 25,
    raw: {},
  };
  it('accepts a matching quote inside slippage', () => {
    expect(validateJupiterQuoteAmounts(base, '100000000', 100).ok).toBe(true);
  });
  it('rejects when the input amount drifted', () => {
    const r = validateJupiterQuoteAmounts(base, '99999999', 100);
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('-');
  });
  it('rejects when the minimum output is below the slippage floor', () => {
    // 100 bps on 5000000 allows down to 4950000; 4949999 is below.
    const q: JupiterQuote = { ...base, otherAmountThreshold: '4949999' };
    const r = validateJupiterQuoteAmounts(q, '100000000', 100);
    expect(r.ok).toBe(false);
  });
  it('rejects a missing minimum output', () => {
    const q: JupiterQuote = { ...base, otherAmountThreshold: null };
    expect(validateJupiterQuoteAmounts(q, '100000000', 100).ok).toBe(false);
  });
});

describe('jupiterReferralFeeAccount', () => {
  const OLD = process.env.NEXT_PUBLIC_CURV_FEE_WALLET;
  afterEach(() => {
    if (OLD === undefined) delete process.env.NEXT_PUBLIC_CURV_FEE_WALLET;
    else process.env.NEXT_PUBLIC_CURV_FEE_WALLET = OLD;
  });
  it('derives the wSOL ATA for the fee wallet', () => {
    process.env.NEXT_PUBLIC_CURV_FEE_WALLET = 'RikDFSSJHFJtFaeZtEJ4m6zTMJkgRJ8RczECdfKq16g';
    const ata = jupiterReferralFeeAccount();
    expect(typeof ata).toBe('string');
    expect(ata!.length).toBeGreaterThan(30);
  });
  it('returns null without a configured wallet', () => {
    delete process.env.NEXT_PUBLIC_CURV_FEE_WALLET;
    expect(jupiterReferralFeeAccount()).toBeNull();
  });
  it('referral fee is 25 bps', () => {
    expect(JUPITER_REFERRAL_FEE_BPS).toBe(25);
  });
});

describe('getVersionedTxFeePayer', () => {
  it('reads the first static account key', async () => {
    const { VersionedTransaction, TransactionMessage, PublicKey } = await import('@solana/web3.js');
    const payer = new PublicKey('RikDFSSJHFJtFaeZtEJ4m6zTMJkgRJ8RczECdfKq16g');
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    expect(getVersionedTxFeePayer(tx)).toBe(payer.toBase58());
  });
});
