import { describe, expect, it } from 'vitest';
import { BN } from '@coral-xyz/anchor';
import {
  applySlippageBps,
  parseUiAmountToRaw,
  priceImpactPct,
  rawToUi,
} from './swap-math';

describe('parseUiAmountToRaw', () => {
  it('converts decimal strings to exact raw integers', async () => {
    expect(parseUiAmountToRaw('1.5', 9)!.toString()).toBe('1500000000');
    expect(parseUiAmountToRaw('0.000000001', 9)!.toString()).toBe('1');
    expect(parseUiAmountToRaw('100', 6)!.toString()).toBe('100000000');
    expect(parseUiAmountToRaw('.5', 9)!.toString()).toBe('500000000');
    expect(parseUiAmountToRaw('  2.5  ', 9)!.toString()).toBe('2500000000');
  });

  it('never uses float math: 0.1 + 0.2 === 0.3 exactly', async () => {
    const a = parseUiAmountToRaw('0.1', 9)!;
    const b = parseUiAmountToRaw('0.2', 9)!;
    const c = parseUiAmountToRaw('0.3', 9)!;
    expect(a.add(b).eq(c)).toBe(true);
  });

  it('handles leading zeros', async () => {
    expect(parseUiAmountToRaw('0001.50', 9)!.toString()).toBe('1500000000');
    expect(parseUiAmountToRaw('0.000000001', 9)!.toString()).toBe('1');
  });

  it('rejects invalid input with null (never throws, never NaN)', async () => {
    for (const bad of ['', '.', '   ', 'abc', '1.2.3', '-1', '+1', '1e5', '0x10', 'NaN']) {
      expect(parseUiAmountToRaw(bad, 9), bad).toBeNull();
    }
  });

  it('rejects more decimals than the mint allows', async () => {
    expect(parseUiAmountToRaw('1.0000000001', 9)).toBeNull();
    expect(parseUiAmountToRaw('1.000000001', 9)).not.toBeNull();
  });

  it('rejects zero amounts (a swap of nothing is not a swap)', async () => {
    expect(parseUiAmountToRaw('0', 9)).toBeNull();
    expect(parseUiAmountToRaw('0.000000000', 9)).toBeNull();
  });
});

describe('rawToUi', () => {
  it('formats raw integers back to UI strings', async () => {
    expect(rawToUi(new BN('1500000000'), 9)).toBe('1.5');
    expect(rawToUi(new BN('1'), 9)).toBe('0.000000001');
    expect(rawToUi(new BN('100000000'), 6)).toBe('100');
    expect(rawToUi(new BN('0'), 9)).toBe('0');
  });

  it('respects decimals = 0', async () => {
    expect(rawToUi(new BN('12345'), 0)).toBe('12345');
  });

  it('round-trips parse -> format for canonical inputs', async () => {
    for (const s of ['1', '1.5', '0.000000001', '123456.789']) {
      const raw = parseUiAmountToRaw(s, 9)!;
      expect(rawToUi(raw, 9)).toBe(s);
    }
  });
});

describe('applySlippageBps', () => {
  it('computes minimum-out with integer math', async () => {
    expect(applySlippageBps(new BN('1000000'), 100).toString()).toBe('990000'); // 1%
    expect(applySlippageBps(new BN('1000000'), 0).toString()).toBe('1000000');
    expect(applySlippageBps(new BN('1000000'), 10_000).toString()).toBe('0');
  });

  it('floors the result: the user is guaranteed at least this much', async () => {
    // 999 * 9667 / 10000 = 965.7333... -> 965
    expect(applySlippageBps(new BN('999'), 333).toString()).toBe('965');
  });

  it('rejects out-of-range slippage (defense against UI bugs)', async () => {
    expect(() => applySlippageBps(new BN('100'), -1)).toThrow();
    expect(() => applySlippageBps(new BN('100'), 10_001)).toThrow();
    expect(() => applySlippageBps(new BN('100'), 1.5)).toThrow();
  });
});

describe('priceImpactPct', () => {
  it('computes buy impact vs spot (quote per base paid)', async () => {
    // Pay 1 quote (9dp) for 100 base (9dp) at spot 0.009 -> eff 0.01 -> +11.11%
    const impact = priceImpactPct('buy', new BN('1000000000'), 9, new BN('100000000000'), 9, 0.009)!;
    expect(impact).toBeCloseTo(11.1111, 3);
  });

  it('computes sell impact vs spot (quote per base received)', async () => {
    // Sell 100 base for 0.9 quote at spot 0.01 -> eff 0.009 -> +10% impact
    const impact = priceImpactPct('sell', new BN('100000000000'), 9, new BN('900000000'), 9, 0.01)!;
    expect(impact).toBeCloseTo(10, 6);
  });

  it('can be negative (better than spot)', async () => {
    const impact = priceImpactPct('buy', new BN('1000000000'), 9, new BN('200000000000'), 9, 0.01)!;
    expect(impact).toBeLessThan(0);
  });

  it('returns null when it cannot be computed honestly', async () => {
    expect(priceImpactPct('buy', new BN('100'), 9, new BN('100'), 9, null)).toBeNull();
    expect(priceImpactPct('buy', new BN('100'), 9, new BN('100'), 9, 0)).toBeNull();
    expect(priceImpactPct('buy', new BN('100'), 9, new BN('100'), 9, -1)).toBeNull();
    expect(priceImpactPct('buy', new BN('0'), 9, new BN('100'), 9, 0.01)).toBeNull();
    expect(priceImpactPct('buy', new BN('100'), 9, new BN('0'), 9, 0.01)).toBeNull();
  });
});
