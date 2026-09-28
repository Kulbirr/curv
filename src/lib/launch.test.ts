import { describe, expect, it } from 'vitest';
import { BN } from '@coral-xyz/anchor';
import { CURVE_PRESETS, buildCurveParams, presetCurve, validateLaunchSpec, type LaunchSpec } from './launch';
import { SOL_MINT } from './quote-assets';
import { randomAddress } from '@/test-support/db';

function validSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    name: 'Test Token',
    symbol: 'TEST',
    metadataUri: 'https://example.com/meta.json',
    quoteMint: SOL_MINT,
    quoteDecimals: 9,
    quoteSymbol: 'SOL',
    baseDecimals: 9,
    totalSupply: 1_000_000_000,
    curve: presetCurve('flat', 0.001),
    startingFeeBps: 100,
    endingFeeBps: 25,
    ...overrides,
  };
}

describe('presetCurve', () => {
  it('covers every declared preset', () => {
    for (const p of CURVE_PRESETS) {
      const curve = presetCurve(p.id, 0.001);
      expect(curve.prices.length).toBeGreaterThanOrEqual(2);
      expect(curve.liquidityWeights).toHaveLength(curve.prices.length - 1);
      // Prices strictly increase toward migration; weights are uniform 1s.
      for (let i = 1; i < curve.prices.length; i++) {
        expect(curve.prices[i]).toBeGreaterThan(curve.prices[i - 1]);
      }
      expect(curve.liquidityWeights.every((w) => w === 1)).toBe(true);
    }
  });

  it('scales prices from the starting price', () => {
    const a = presetCurve('exponential', 1);
    const b = presetCurve('exponential', 2);
    expect(a.prices[0]).toBe(1);
    for (let i = 0; i < a.prices.length; i++) {
      expect(b.prices[i]).toBe(a.prices[i] * 2);
    }
  });

  it('has the documented segment counts', () => {
    expect(presetCurve('flat', 1).prices).toHaveLength(4);
    expect(presetCurve('exponential', 1).prices).toHaveLength(4);
    expect(presetCurve('long', 1).prices).toHaveLength(6);
    expect(presetCurve('gentle', 1).prices).toHaveLength(5);
  });
});

describe('validateLaunchSpec', () => {
  it('accepts a valid spec', () => {
    expect(validateLaunchSpec(validSpec())).toEqual([]);
  });

  it('validates the token name', () => {
    expect(validateLaunchSpec(validSpec({ name: '   ' }))).toContain('Token name is required');
    expect(validateLaunchSpec(validSpec({ name: 'x'.repeat(33) }))).toContain(
      'Token name must be 32 characters or less',
    );
  });

  it('validates the symbol (1-10 alphanumerics)', () => {
    expect(validateLaunchSpec(validSpec({ symbol: '' }))).toContain('Token symbol is required');
    expect(validateLaunchSpec(validSpec({ symbol: 'TOOLONGSYMBOL' }))).toContain(
      'Symbol must be 1-10 alphanumeric characters',
    );
    expect(validateLaunchSpec(validSpec({ symbol: 'AB-CD' }))).toContain(
      'Symbol must be 1-10 alphanumeric characters',
    );
  });

  it('validates the quote mint and metadata URI', () => {
    expect(validateLaunchSpec(validSpec({ quoteMint: 'nope' }))).toContain(
      'Quote mint is not a valid address',
    );
    expect(validateLaunchSpec(validSpec({ metadataUri: '  ' }))).toContain('Metadata URI is required');
  });

  it('bounds the total supply', () => {
    expect(validateLaunchSpec(validSpec({ totalSupply: 999 }))).toContain(
      'Total supply must be between 1,000 and 1,000,000,000,000,000',
    );
    expect(validateLaunchSpec(validSpec({ totalSupply: 1e16 }))).toContain(
      'Total supply must be between 1,000 and 1,000,000,000,000,000',
    );
    expect(validateLaunchSpec(validSpec({ totalSupply: NaN }))).toContain(
      'Total supply must be between 1,000 and 1,000,000,000,000,000',
    );
  });

  it('validates the curve shape', () => {
    expect(
      validateLaunchSpec(validSpec({ curve: { prices: [0.001], liquidityWeights: [] } })),
    ).toContain('Curve needs 2-10 price points');
    expect(
      validateLaunchSpec(
        validSpec({ curve: { prices: new Array(11).fill(0.001), liquidityWeights: new Array(10).fill(1) } }),
      ),
    ).toContain('Curve needs 2-10 price points');
    expect(
      validateLaunchSpec(validSpec({ curve: { prices: [0.001, 0.002], liquidityWeights: [] } })),
    ).toContain('Liquidity weights must match the number of curve segments');
    expect(
      validateLaunchSpec(validSpec({ curve: { prices: [0.001, 0], liquidityWeights: [1] } })),
    ).toContain('Price point 2 must be a positive number');
    expect(
      validateLaunchSpec(validSpec({ curve: { prices: [0.002, 0.001], liquidityWeights: [1] } })),
    ).toContain('Price points must strictly increase toward migration');
    expect(
      validateLaunchSpec(validSpec({ curve: { prices: [0.001, 0.001], liquidityWeights: [1] } })),
    ).toContain('Price points must strictly increase toward migration');
    expect(
      validateLaunchSpec(validSpec({ curve: { prices: [0.001, 0.002], liquidityWeights: [0] } })),
    ).toContain('Liquidity weights must be positive numbers');
  });

  it('validates the fee schedule against the DBC SDK bounds (25-9900 bps)', () => {
    // The SDK throws below 25 / above 9900, so the UI must reject them first.
    for (const v of [-1, 0, 24, 9901, 10001]) {
      expect(validateLaunchSpec(validSpec({ startingFeeBps: v })), `start=${v}`).toContain(
        'Starting fee must be 25-9900 bps',
      );
      expect(validateLaunchSpec(validSpec({ endingFeeBps: v })), `end=${v}`).toContain(
        'Ending fee must be 25-9900 bps',
      );
    }
    expect(validateLaunchSpec(validSpec({ startingFeeBps: 1.5 }))).toContain(
      'Starting fee must be 25-9900 bps',
    );
    expect(validateLaunchSpec(validSpec({ startingFeeBps: 50, endingFeeBps: 100 }))).toContain(
      'Ending fee cannot exceed the starting fee',
    );
    // Boundary values are accepted.
    expect(validateLaunchSpec(validSpec({ startingFeeBps: 25, endingFeeBps: 25 }))).toEqual([]);
    expect(validateLaunchSpec(validSpec({ startingFeeBps: 9900, endingFeeBps: 25 }))).toEqual([]);
  });

  it('rejects below-SDK-minimum fees that the SDK would throw on', () => {
    // Regression: endingFeeBps 20 passed validation but buildCurveParams
    // threw "less than minimum allowed value of 25 bps".
    expect(() => buildCurveParams(validSpec({ endingFeeBps: 20 }))).toThrow(
      'Ending fee must be 25-9900 bps',
    );
  });

  it('collects multiple errors at once', () => {
    const errors = validateLaunchSpec(validSpec({ name: '', symbol: '!!', totalSupply: 0 }));
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('buildCurveParams', () => {
  it('builds SDK curve params from a valid spec', () => {
    const params = buildCurveParams(validSpec());
    // The SDK returns per-segment { sqrtPrice, liquidity } entries.
    expect(params.curve).toHaveLength(3); // flat preset: 4 price points -> 3 segments
    for (let i = 0; i < params.curve.length; i++) {
      expect(params.curve[i].liquidity.gt(new BN(0))).toBe(true);
      if (i > 0) {
        expect(params.curve[i].sqrtPrice.gt(params.curve[i - 1].sqrtPrice)).toBe(true);
      }
    }
    expect(params.migrationQuoteThreshold.gt(new BN(0))).toBe(true);
  });

  it('carries the 0.3% creator trading fee into the SDK fee config', () => {
    const params = buildCurveParams(validSpec());
    // The SDK's buildCurveWithCustomSqrtPrices flattens the fee config:
    // creatorTradingFeePercentage lands top-level, in percent.
    expect(params.creatorTradingFeePercentage).toBe(0.3);
  });

  it('throws the first validation error on an invalid spec', () => {
    expect(() => buildCurveParams(validSpec({ name: '' }))).toThrow('Token name is required');
  });

  it('supports 6-decimal base mints', () => {
    const params = buildCurveParams(validSpec({ baseDecimals: 6 }));
    expect(params.curve).toHaveLength(3);
  });

  it('uses a custom base mint fixture without complaint', () => {
    const params = buildCurveParams(validSpec({ quoteMint: randomAddress(), quoteDecimals: 6 }));
    expect(params.curve).toHaveLength(3);
  });
});
