import { describe, expect, it } from 'vitest';
import { USDC_MINT, validateCandidateBody } from './candidates';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CBBTC = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';

function body(over: Record<string, unknown> = {}) {
  return {
    baseMint: CBBTC,
    baseSymbol: 'BTC',
    quoteMint: USDC,
    quoteSymbol: 'USDC',
    entryLow: 100,
    entryHigh: 105,
    stopPrice: 95,
    targets: [115, 130],
    thesis: 'Clean retest of the broken level with rising volume behind it.',
    submittedBy: 'operator',
    noKnownUnlock: true,
    ...over,
  };
}

describe('validateCandidateBody', () => {
  it('accepts a valid body', () => {
    const r = validateCandidateBody(body());
    expect(r.ok).toBe(true);
  });
  it('defaults quote to USDC when omitted', () => {
    const b = body();
    delete (b as Record<string, unknown>).quoteMint;
    delete (b as Record<string, unknown>).quoteSymbol;
    const r = validateCandidateBody(b);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.quoteMint).toBe(USDC_MINT);
      expect(r.input.quoteSymbol).toBe('USDC');
    }
  });
  it('rejects a bad mint', () => {
    const r = validateCandidateBody(body({ baseMint: 'nope' }));
    expect(r.ok).toBe(false);
  });
  it('rejects identical base and quote mints', () => {
    const r = validateCandidateBody(body({ baseMint: USDC }));
    expect(r.ok).toBe(false);
  });
  it('rejects empty targets', () => {
    const r = validateCandidateBody(body({ targets: [] }));
    expect(r.ok).toBe(false);
  });
  it('rejects a short thesis', () => {
    const r = validateCandidateBody(body({ thesis: 'buy it' }));
    expect(r.ok).toBe(false);
  });
  it('rejects a non object body', () => {
    expect(validateCandidateBody(null).ok).toBe(false);
    expect(validateCandidateBody('x').ok).toBe(false);
  });
});
