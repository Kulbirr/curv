import { describe, expect, it } from 'vitest';
import { BN } from '@coral-xyz/anchor';
import { CURVE_PRESETS, buildCurveParams, formatPriceInput, graduationThresholdQuote, platformFeeWallet, presetCurve, quickCurveDesign, quickDefaultStartPrice, resolveEcon, scaleCurveToGraduationTarget, validateDevBuy, validateLaunchSpec, type LaunchSpec } from './launch';
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
  it('covers every declared preset', async () => {
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

  it('scales prices from the starting price', async () => {
    const a = presetCurve('exponential', 1);
    const b = presetCurve('exponential', 2);
    expect(a.prices[0]).toBe(1);
    for (let i = 0; i < a.prices.length; i++) {
      expect(b.prices[i]).toBe(a.prices[i] * 2);
    }
  });

  it('has the documented segment counts', async () => {
    expect(presetCurve('flat', 1).prices).toHaveLength(4);
    expect(presetCurve('exponential', 1).prices).toHaveLength(4);
    expect(presetCurve('long', 1).prices).toHaveLength(6);
    expect(presetCurve('gentle', 1).prices).toHaveLength(5);
  });
});

describe('validateLaunchSpec', () => {
  it('accepts a valid spec', async () => {
    expect(validateLaunchSpec(validSpec())).toEqual([]);
  });

  it('validates the token name', async () => {
    expect(validateLaunchSpec(validSpec({ name: '   ' }))).toContain('Token name is required');
    expect(validateLaunchSpec(validSpec({ name: 'x'.repeat(33) }))).toContain(
      'Token name must be 32 characters or less',
    );
  });

  it('validates the symbol (1-10 alphanumerics)', async () => {
    expect(validateLaunchSpec(validSpec({ symbol: '' }))).toContain('Token symbol is required');
    expect(validateLaunchSpec(validSpec({ symbol: 'TOOLONGSYMBOL' }))).toContain(
      'Symbol must be 1-10 alphanumeric characters',
    );
    expect(validateLaunchSpec(validSpec({ symbol: 'AB-CD' }))).toContain(
      'Symbol must be 1-10 alphanumeric characters',
    );
  });

  it('validates the quote mint and metadata URI', async () => {
    expect(validateLaunchSpec(validSpec({ quoteMint: 'nope' }))).toContain(
      'Quote mint is not a valid address',
    );
    expect(validateLaunchSpec(validSpec({ metadataUri: '  ' }))).toContain('Metadata URI is required');
  });

  it('bounds the total supply', async () => {
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

  it('validates the curve shape', async () => {
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

  it('validates the fee schedule against the DBC SDK bounds (25-9900 bps)', async () => {
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

  it('rejects below-SDK-minimum fees that the SDK would throw on', async () => {
    // Regression: endingFeeBps 20 passed validation but buildCurveParams
    // threw "less than minimum allowed value of 25 bps".
    expect(() => buildCurveParams(validSpec({ endingFeeBps: 20 }))).toThrow(
      'Ending fee must be 25-9900 bps',
    );
  });

  it('collects multiple errors at once', async () => {
    const errors = validateLaunchSpec(validSpec({ name: '', symbol: '!!', totalSupply: 0 }));
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('buildCurveParams', () => {
  it('builds SDK curve params from a valid spec', async () => {
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

  it('carries the 31.51% creator fee share into the SDK fee config', async () => {
    const params = buildCurveParams(validSpec());
    // The SDK's buildCurveWithCustomSqrtPrices flattens the fee config:
    // creatorTradingFeePercentage lands top-level, in percent of the
    // non-protocol fee share (31.51% of the 80% after Meteora's 20% cut
    // is exactly 0.30% of volume at the 1.19% flat trading fee).
    expect(params.creatorTradingFeePercentage).toBe(31.51);
  });

  it('emits a valid Meteora liquidity distribution (buckets sum to 100)', async () => {
    // Regression: the old config passed partnerLiquidityPercentage=7 with
    // partnerPermanentLockedLiquidityPercentage=100 (and the same for the
    // creator), which sums to 214. Meteora reads these four buckets as
    // additive shares of the graduated pool's LP that must total exactly
    // 100, so PartnerService.createConfigAndPool rejected every launch with
    // "Sum of LP percentages must equal 100".
    const params = buildCurveParams(validSpec());
    const total =
      params.partnerLiquidityPercentage +
      params.partnerPermanentLockedLiquidityPercentage +
      params.creatorLiquidityPercentage +
      params.creatorPermanentLockedLiquidityPercentage;
    expect(total).toBe(100);
  });

  it('locks 100% of graduated liquidity with nothing claimable', async () => {
    // Neither Curv nor the creator may hold withdrawable (claimable) LP:
    // a claimable share is a rug vector on the graduated pool.
    const params = buildCurveParams(validSpec());
    expect(params.partnerLiquidityPercentage).toBe(0);
    expect(params.creatorLiquidityPercentage).toBe(0);
    expect(params.partnerPermanentLockedLiquidityPercentage).toBe(20);
    expect(params.creatorPermanentLockedLiquidityPercentage).toBe(80);
  });

  it('keeps at least 10% of graduated LP permanently locked', async () => {
    // Meteora's minimum locked-liquidity rule for new configs.
    const params = buildCurveParams(validSpec());
    const locked =
      params.partnerPermanentLockedLiquidityPercentage +
      params.creatorPermanentLockedLiquidityPercentage;
    expect(locked).toBeGreaterThanOrEqual(10);
  });

  it('throws the first validation error on an invalid spec', async () => {
    expect(() => buildCurveParams(validSpec({ name: '' }))).toThrow('Token name is required');
  });

  it('builds a flat fee (start == end) without scheduler periods', async () => {
    // Regression: the SDK throws "numberOfPeriod and totalDuration must
    // both be zero" when startingFeeBps == endingFeeBps with nonzero
    // periods. Every Quick launch uses the flat 119 -> 119 bps fee with
    // the default 60-period config, so without zeroing the periods here
    // pool creation throws inside buildCurveWithCustomSqrtPrices.
    const params = buildCurveParams(
      validSpec({ startingFeeBps: 119, endingFeeBps: 119 }),
    );
    expect(params.migrationQuoteThreshold.gt(new BN(0))).toBe(true);
    const baseFee = params.poolFees.baseFee as { cliffFeeNumerator: BN; firstFactor: number };
    expect(baseFee.cliffFeeNumerator.gt(new BN(0))).toBe(true);
    expect(baseFee.firstFactor).toBe(0);
  });

  it('keeps scheduler periods for a decaying fee (start != end)', async () => {
    const params = buildCurveParams(validSpec());
    // validSpec uses 100 -> 25 bps, so the 60-period schedule survives.
    const baseFee = params.poolFees.baseFee as { firstFactor: number };
    expect(baseFee.firstFactor).toBe(60);
  });

  it('supports 6-decimal base mints', async () => {
    const params = buildCurveParams(validSpec({ baseDecimals: 6 }));
    expect(params.curve).toHaveLength(3);
  });

  it('uses a custom base mint fixture without complaint', async () => {
    const params = buildCurveParams(validSpec({ quoteMint: randomAddress(), quoteDecimals: 6 }));
    expect(params.curve).toHaveLength(3);
  });
});

describe('creator economics overrides', () => {
  it('resolveEcon returns the defaults with no overrides', async () => {
    const e = resolveEcon(validSpec());
    expect(e.feeSchedulerPeriods).toBe(60);
    expect(e.feeSchedulerTotalDuration).toBe(60);
    expect(e.dynamicFeeEnabled).toBe(true);
    expect(e.migrationFeePercent).toBe(4);
    expect(e.migratedPoolFeeBps).toBe(120);
    expect(e.migratedPoolDynamicFee).toBe(true);
    expect(e.partnerLockedLiquidityPercent).toBe(20);
    expect(e.creatorLockedLiquidityPercent).toBe(80);
  });

  it('resolveEcon merges overrides over the defaults', async () => {
    const e = resolveEcon(
      validSpec({ econ: { feeSchedulerPeriods: 120, migrationFeePercent: 5 } }),
    );
    expect(e.feeSchedulerPeriods).toBe(120);
    expect(e.migrationFeePercent).toBe(5);
    // Untouched fields keep their defaults.
    expect(e.feeSchedulerTotalDuration).toBe(60);
    expect(e.migratedPoolFeeBps).toBe(120);
  });

  it('never lets the spec override the locked creator cuts', async () => {
    const e = resolveEcon(validSpec({ econ: {} }));
    expect(e.creatorTradingFeePercent).toBe(31.51);
    expect(e.creatorMigrationFeePercent).toBe(50);
    expect(e.poolCreationFeeSol).toBe(0.02);
  });

  it('rejects a zero or negative fee-decay period count', async () => {
    expect(validateLaunchSpec(validSpec({ econ: { feeSchedulerPeriods: 0 } }))).toContain(
      'Fee decay periods must be a whole number of 1 or more',
    );
  });

  it('rejects a decay duration shorter than the period count', async () => {
    expect(
      validateLaunchSpec(validSpec({ econ: { feeSchedulerPeriods: 60, feeSchedulerTotalDuration: 59 } })),
    ).toContain(
      'Fee decay duration must be a whole number of slots, at least the number of periods',
    );
  });

  it('rejects out-of-range migration fees', async () => {
    expect(validateLaunchSpec(validSpec({ econ: { migrationFeePercent: 100 } }))).toContain(
      'Migration fee must be a whole percent between 0 and 99',
    );
    expect(validateLaunchSpec(validSpec({ econ: { migrationFeePercent: -1 } }))).toContain(
      'Migration fee must be a whole percent between 0 and 99',
    );
    expect(validateLaunchSpec(validSpec({ econ: { migrationFeePercent: 2.5 } }))).toContain(
      'Migration fee must be a whole percent between 0 and 99',
    );
  });

  it('rejects out-of-range post-graduation pool fees', async () => {
    expect(validateLaunchSpec(validSpec({ econ: { migratedPoolFeeBps: 9 } }))).toContain(
      'Post-graduation pool fee must be 10-1000 bps',
    );
    expect(validateLaunchSpec(validSpec({ econ: { migratedPoolFeeBps: 1001 } }))).toContain(
      'Post-graduation pool fee must be 10-1000 bps',
    );
  });

  it('accepts valid overrides', async () => {
    expect(
      validateLaunchSpec(
        validSpec({
          econ: {
            feeSchedulerPeriods: 120,
            feeSchedulerTotalDuration: 240,
            dynamicFeeEnabled: false,
            migrationFeePercent: 0,
            migratedPoolFeeBps: 10,
            migratedPoolDynamicFee: false,
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe('graduationThresholdQuote', () => {
  it('returns a positive threshold for a valid spec', async () => {
    const t = graduationThresholdQuote(validSpec());
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(0);
    expect(Number.isFinite(t!)).toBe(true);
  });

  it('returns null for an invalid spec', async () => {
    expect(graduationThresholdQuote(validSpec({ name: '' }))).toBeNull();
  });

  it('rises when the migration fee rises', async () => {
    const low = graduationThresholdQuote(validSpec({ econ: { migrationFeePercent: 0 } }))!;
    const high = graduationThresholdQuote(validSpec({ econ: { migrationFeePercent: 20 } }))!;
    expect(high).toBeGreaterThan(low);
  });

  it('is unaffected by the fee schedule', async () => {
    const a = graduationThresholdQuote(validSpec())!;
    const b = graduationThresholdQuote(
      validSpec({ econ: { feeSchedulerPeriods: 240, feeSchedulerTotalDuration: 240 } }),
    )!;
    expect(b).toBeCloseTo(a, 10);
  });
});

describe('scaleCurveToGraduationTarget', () => {
  it('hits a lower target', async () => {
    const s = validSpec();
    const t0 = graduationThresholdQuote(s)!;
    const target = t0 / 10;
    const r = scaleCurveToGraduationTarget(s, target);
    const t1 = graduationThresholdQuote(r)!;
    expect(Math.abs(t1 - target) / target).toBeLessThan(0.01);
  });

  it('hits a higher target', async () => {
    const s = validSpec();
    const t0 = graduationThresholdQuote(s)!;
    const target = t0 * 3;
    const r = scaleCurveToGraduationTarget(s, target);
    const t1 = graduationThresholdQuote(r)!;
    expect(Math.abs(t1 - target) / target).toBeLessThan(0.01);
  });

  it('scales the curve uniformly, preserving its shape', async () => {
    const s = validSpec();
    const t0 = graduationThresholdQuote(s)!;
    const r = scaleCurveToGraduationTarget(s, t0 * 2);
    const ratios = r.curve.prices.map((p, i) => p / s.curve.prices[i]);
    const spread = Math.max(...ratios) / Math.min(...ratios);
    expect(spread).toBeLessThan(1.000001);
    expect(r.curve.liquidityWeights).toEqual(s.curve.liquidityWeights);
  });

  it('throws on a non-positive target', async () => {
    expect(() => scaleCurveToGraduationTarget(validSpec(), 0)).toThrow();
    expect(() => scaleCurveToGraduationTarget(validSpec(), -5)).toThrow();
  });

  it('throws on an invalid spec', async () => {
    const t0 = graduationThresholdQuote(validSpec())!;
    expect(() => scaleCurveToGraduationTarget(validSpec({ name: '' }), t0)).toThrow();
  });
});

describe('quickDefaultStartPrice', () => {
  it('targets ~$3k starting valuation at 1B supply for any quote asset', async () => {
    // SOL at $200: 2.5e-8 SOL/token * 1B = 25 SOL = $5,000.
    expect(quickDefaultStartPrice(200)).toBeCloseTo(2.5e-8, 12);
    // USDC at $1: 5e-6 USDC/token * 1B = $5,000.
    expect(quickDefaultStartPrice(1)).toBeCloseTo(5e-6, 12);
    // Unknown price falls back to $1/quote-unit rather than breaking.
    expect(quickDefaultStartPrice(null)).toBeCloseTo(5e-6, 12);
    expect(quickDefaultStartPrice(0)).toBeCloseTo(5e-6, 12);
    expect(quickDefaultStartPrice(-5)).toBeCloseTo(5e-6, 12);
  });

  it('quick curve keeps the pump.fun shape, separate from the Pro exponential preset', async () => {
    // Pro's exponential preset is untouched by the Quick redesign.
    expect(presetCurve('exponential', 1).prices).toEqual([1, 1.6, 3.2, 10]);
    expect(quickCurveDesign(1).prices).toEqual([1, 1.8, 4, 14]);
  });

  it('graduates a SOL pair near ~74 SOL on the $5k-start curve', async () => {
    const spec = validSpec({
      curve: quickCurveDesign(quickDefaultStartPrice(200)),
    });
    const threshold = graduationThresholdQuote(spec);
    // Graduation scales with the starting valuation (curve shape is
    // unchanged): $5k start graduates near ~74 SOL, matching pump.fun's
    // graduation scale, not hundreds of thousands of SOL.
    expect(threshold).toBeGreaterThan(60);
    expect(threshold).toBeLessThan(120);
  });

  it('graduates a USDC pair near $14.9k of reserves', async () => {
    const spec = validSpec({
      quoteDecimals: 6,
      quoteSymbol: 'USDC',
      curve: quickCurveDesign(quickDefaultStartPrice(1)),
    });
    const threshold = graduationThresholdQuote(spec);
    expect(threshold).toBeGreaterThan(12000);
    expect(threshold).toBeLessThan(22000);
  });
});

describe('formatPriceInput', () => {
  it('never emits scientific notation', async () => {
    expect(formatPriceInput(4e-8)).toBe('0.00000004');
    expect(formatPriceInput(8e-6)).toBe('0.000008');
    expect(formatPriceInput(0.0001)).toBe('0.0001');
    expect(formatPriceInput(1.5)).toBe('1.5');
  });

  it('handles non-positive input', async () => {
    expect(formatPriceInput(0)).toBe('0');
    expect(formatPriceInput(-1)).toBe('0');
  });
});

describe('platformFeeWallet', () => {
  const KEY = 'NEXT_PUBLIC_CURV_FEE_WALLET';
  const saved = process.env[KEY];

  it('returns null when the variable is missing or blank', async () => {
    delete process.env[KEY];
    expect(platformFeeWallet()).toBeNull();
    process.env[KEY] = '   ';
    expect(platformFeeWallet()).toBeNull();
  });

  it('returns null for an invalid address', async () => {
    process.env[KEY] = 'not-a-pubkey';
    expect(platformFeeWallet()).toBeNull();
  });

  it('parses a valid fee wallet address', async () => {
    process.env[KEY] = 'EcRWrJtULSrmVqB99KrrcywKi3WWhDdMwfzppCzLhbiA';
    expect(platformFeeWallet()?.toBase58()).toBe('EcRWrJtULSrmVqB99KrrcywKi3WWhDdMwfzppCzLhbiA');
  });

  it('restores the environment', async () => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });
});

describe('validateDevBuy', () => {
  const DECIMALS = 9;
  const THRESHOLD = 74.44; // quote UI units, like the Quick graduation threshold

  it('empty string means no dev buy', () => {
    expect(validateDevBuy('', DECIMALS, THRESHOLD)).toEqual({ ok: true, lamports: null });
    expect(validateDevBuy('   ', DECIMALS, THRESHOLD)).toEqual({ ok: true, lamports: null });
  });

  it('accepts a valid amount and converts to lamports', () => {
    const res = validateDevBuy('0.5', DECIMALS, THRESHOLD);
    expect(res).toEqual({ ok: true, lamports: 500_000_000 });
  });

  it('rejects zero', () => {
    const res = validateDevBuy('0', DECIMALS, THRESHOLD);
    expect(res.ok).toBe(false);
  });

  it('rejects negative amounts', () => {
    const res = validateDevBuy('-1', DECIMALS, THRESHOLD);
    expect(res.ok).toBe(false);
  });

  it('rejects non numeric input', () => {
    expect(validateDevBuy('abc', DECIMALS, THRESHOLD).ok).toBe(false);
    expect(validateDevBuy('1.2.3', DECIMALS, THRESHOLD).ok).toBe(false);
  });

  it('rejects more decimals than the quote mint supports', () => {
    expect(validateDevBuy('0.1234567891', DECIMALS, THRESHOLD).ok).toBe(false);
  });

  it('rejects amounts above the graduation threshold cap', () => {
    const res = validateDevBuy('74.45', DECIMALS, THRESHOLD);
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error).toMatch(/graduation threshold/);
  });

  it('accepts exactly the graduation threshold', () => {
    const res = validateDevBuy('74.44', DECIMALS, THRESHOLD);
    expect(res.ok).toBe(true);
  });

  it('skips the cap check when the threshold is unknown', () => {
    const res = validateDevBuy('1000', DECIMALS, null);
    expect(res).toEqual({ ok: true, lamports: 1_000_000_000_000 });
  });
});
