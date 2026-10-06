import { describe, expect, it } from 'vitest';
import {
  deriveTradeMode,
  formatFeeLabel,
  jupiterDeepLink,
  resolveJupiterFeeBps,
} from './tradeMode';

describe('deriveTradeMode', () => {
  it('returns jupiter when graduated is true', () => {
    expect(deriveTradeMode(true)).toBe('jupiter');
  });

  it('returns dbc when graduated is false', () => {
    expect(deriveTradeMode(false)).toBe('dbc');
  });

  it('returns dbc when graduated is undefined', () => {
    expect(deriveTradeMode(undefined)).toBe('dbc');
  });
});

describe('resolveJupiterFeeBps', () => {
  it('returns 25 when a fee account is configured', () => {
    expect(resolveJupiterFeeBps('SomeATA111111111111111111111111111111111')).toBe(25);
  });

  it('returns 0 when no fee account is configured', () => {
    expect(resolveJupiterFeeBps(null)).toBe(0);
  });
});

describe('formatFeeLabel', () => {
  it('formats 25 bps as 0.25 percent', () => {
    expect(formatFeeLabel(25)).toBe('Curv fee 0.25%');
  });

  it('formats 0 bps honestly', () => {
    expect(formatFeeLabel(0)).toBe('Curv fee 0%');
  });

  it('contains no dashes', () => {
    expect(formatFeeLabel(25)).not.toMatch(/[–—-]/);
  });
});

describe('jupiterDeepLink', () => {
  it('builds a swap link with both mints', () => {
    const link = jupiterDeepLink('IN111', 'OUT222');
    expect(link).toBe('https://jup.ag/swap?inputMint=IN111&outputMint=OUT222');
  });
});
