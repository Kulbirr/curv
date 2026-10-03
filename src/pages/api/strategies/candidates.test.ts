import { describe, expect, it } from 'vitest';
import { validateCandidateBody } from './candidates';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function body(over: Record<string, unknown> = {}) {
  return {
    baseMint: SOL,
    baseSymbol: 'SOL',
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
  it('defaults quote to SOL when omitted', () => {
    const b = body({
      baseMint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
      baseSymbol: 'BTC',
    });
    delete (b as Record<string, unknown>).quoteMint;
    delete (b as Record<string, unknown>).quoteSymbol;
    const r = validateCandidateBody(b);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.quoteMint).toBe(SOL);
      expect(r.input.quoteSymbol).toBe('SOL');
    }
  });
  it('rejects a bad mint', () => {
    const r = validateCandidateBody(body({ baseMint: 'nope' }));
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
