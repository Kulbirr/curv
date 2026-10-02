import { describe, expect, it } from 'vitest';
import {
  JupiterError,
  fetchJupiterQuote,
  fetchJupiterSwapTransaction,
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
});

describe('fetchJupiterSwapTransaction', () => {
  const quote = { inputMint: 'a', outputMint: 'b', inAmount: '1', outAmount: '2' };
  it('returns the base64 transaction', async () => {
    const tx = await fetchJupiterSwapTransaction(
      quote,
      'Wallet1111111111111111111111111111111111111',
      okJson({ swapTransaction: 'aGVsbG8=' }),
    );
    expect(tx).toBe('aGVsbG8=');
  });
  it('fails closed on bad payloads', async () => {
    await expect(fetchJupiterSwapTransaction(quote, 'w', okJson({}))).rejects.toBeInstanceOf(JupiterError);
    const bad = async () => ({ ok: false, status: 500 }) as Response;
    await expect(fetchJupiterSwapTransaction(quote, 'w', bad)).rejects.toBeInstanceOf(JupiterError);
  });
  it('friendly messages are dash free', async () => {
    const errs: JupiterError[] = [];
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
