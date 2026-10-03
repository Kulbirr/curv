import { describe, expect, it } from 'vitest';
import {
  TokenDecimal,
  getMigrationThresholdPrice,
  getPriceFromSqrtPrice,
  validateConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import {
  buildCurveParams,
  graduationThresholdQuote,
  quickDefaultStartPrice,
  type LaunchSpec,
} from './launch';
import {
  DEFAULT_QUICK_TIER_ID,
  QUICK_TIERS,
  TIER_CURVE_HEADROOM,
  calibrateTierThreshold,
  quickTierById,
  quickTierCurveDesign,
  quickTierDisplayPrices,
  type QuickTier,
  type TierCurveParams,
} from './launch-tiers';
import { DEVNET_USDC_MINT, SOL_MINT } from './quote-assets';

const SUPPLY = 1_000_000_000;

function tierSpec(
  tier: QuickTier,
  quoteUsd: number,
  quote: { mint: string; decimals: number; symbol: string },
): LaunchSpec {
  const startPrice = quickDefaultStartPrice(quoteUsd);
  return {
    name: 'Tier Test',
    symbol: 'TIER',
    metadataUri: 'https://example.com/meta.json',
    quoteMint: quote.mint,
    quoteDecimals: quote.decimals,
    quoteSymbol: quote.symbol,
    baseDecimals: 9,
    totalSupply: SUPPLY,
    curve: quickTierCurveDesign(startPrice, tier),
    startingFeeBps: 119,
    endingFeeBps: 119,
    quickTierId: tier.id,
  };
}

function asTierParams(p: unknown): TierCurveParams {
  const q = p as {
    migrationQuoteThreshold: BN;
    sqrtStartPrice: BN;
    curve: Array<{ sqrtPrice: BN; liquidity: BN }>;
  };
  return {
    migrationQuoteThreshold: q.migrationQuoteThreshold,
    sqrtStartPrice: q.sqrtStartPrice,
    curve: q.curve,
  };
}

/** Market cap in USD at the migration point for built params. */
function migrationMcUsd(
  params: TierCurveParams,
  threshold: BN,
  quoteUsd: number,
  quoteDecimals: number,
): number {
  const migSqrt = getMigrationThresholdPrice(
    threshold,
    params.sqrtStartPrice,
    params.curve as never,
  );
  const price = Number(
    getPriceFromSqrtPrice(migSqrt, TokenDecimal.NINE, quoteDecimals).toString(),
  );
  return price * SUPPLY * quoteUsd;
}

describe('quick graduation tiers', () => {
  it('defines the three Ember-style tiers with $35K balanced as default', () => {
    expect(QUICK_TIERS.map((t) => t.id)).toEqual(['fast', 'balanced', 'deep']);
    expect(QUICK_TIERS.map((t) => t.capUsd)).toEqual([25000, 35000, 40000]);
    expect(QUICK_TIERS.map((t) => t.endMultiple)).toEqual([5, 7, 8]);
    expect(DEFAULT_QUICK_TIER_ID).toBe('balanced');
    expect(quickTierById('balanced').capUsd).toBe(35000);
    // Unknown ids fall back to the default tier, never throw.
    expect(quickTierById('nope').id).toBe('balanced');
  });

  it('builds a 4-point display ladder and a 5-point on-chain curve with headroom', () => {
    for (const tier of QUICK_TIERS) {
      const display = quickTierDisplayPrices(1, tier);
      expect(display).toEqual([1, tier.mids[0], tier.mids[1], tier.endMultiple]);
      const design = quickTierCurveDesign(1, tier);
      expect(design.prices).toHaveLength(5);
      expect(design.liquidityWeights).toHaveLength(4);
      // The headroom segment carries double weight: structural depth that
      // keeps the SDK's supply validation inside the 1B supply. It is
      // never traded, no swap can reach past the migration price.
      expect(design.liquidityWeights).toEqual([1, 1, 1, 2]);
      // The headroom point sits 1.5x past the advertised graduation price.
      expect(design.prices[4]).toBeCloseTo(
        tier.endMultiple * TIER_CURVE_HEADROOM,
        10,
      );
      expect(design.prices[3]).toBeCloseTo(tier.endMultiple, 10);
    }
  });

  it.each(QUICK_TIERS.map((t) => [t.id, t] as [string, QuickTier]))(
    'graduates the %s tier at exactly the advertised cap on SOL',
    (_id, tier) => {
      const quoteUsd = 200;
      const spec = tierSpec(tier, quoteUsd, {
        mint: SOL_MINT,
        decimals: 9,
        symbol: 'SOL',
      });
      const params = asTierParams(buildCurveParams(spec));
      const calibrated = params.migrationQuoteThreshold;

      // The uncalibrated full-curve threshold is the structural ceiling.
      const raw = asTierParams(
        buildCurveParams({ ...spec, quickTierId: undefined }),
      );
      expect(calibrated.lt(raw.migrationQuoteThreshold)).toBe(true);
      // Headroom: the full curve can absorb well past the migration point.
      const margin =
        Number(raw.migrationQuoteThreshold.toString()) /
        Number(calibrated.toString());
      expect(margin).toBeGreaterThan(1.2);

      // The actual migration market cap matches the advertised cap.
      const mc = migrationMcUsd(params, calibrated, quoteUsd, 9);
      expect(mc).toBeGreaterThan(tier.capUsd * 0.995);
      expect(mc).toBeLessThan(tier.capUsd * 1.005);

      // The graduation preview the UI shows is the calibrated threshold.
      const preview = graduationThresholdQuote(spec)!;
      expect(preview).toBeCloseTo(
        Number(calibrated.toString()) / 1e9,
        10,
      );
    },
  );

  it('graduates the balanced tier at exactly $35K on USDC', () => {
    const tier = quickTierById('balanced');
    const spec = tierSpec(tier, 1, {
      mint: DEVNET_USDC_MINT,
      decimals: 6,
      symbol: 'USDC',
    });
    const params = asTierParams(buildCurveParams(spec));
    const mc = migrationMcUsd(
      params,
      params.migrationQuoteThreshold,
      1,
      6,
    );
    expect(mc).toBeGreaterThan(35000 * 0.995);
    expect(mc).toBeLessThan(35000 * 1.005);
  });

  it.each(QUICK_TIERS.map((t) => [t.id] as [string]))(
    'passes the SDK on-chain config validation for the %s tier',
    (id) => {
      // validateConfigParameters is the exact check the DBC program's
      // createConfig instruction runs. A calibrated threshold that fails
      // it can never become a pool, so every tier must pass here.
      const tier = quickTierById(id);
      const spec = tierSpec(tier, 1, {
        mint: DEVNET_USDC_MINT,
        decimals: 6,
        symbol: 'USDC',
      });
      const params = buildCurveParams(spec) as unknown as Record<
        string,
        unknown
      >;
      expect(() =>
        validateConfigParameters({
          ...(params as object),
          leftoverReceiver: new PublicKey(
            '4zmTkFjKrcYyy5B5s116vJAxxMwuvfpjZuUTv6xJe9Rz'
          ),
        } as never),
      ).not.toThrow();
    },
  );

  it('calibrates by price for quote mints without a USD price', () => {
    const tier = quickTierById('deep');
    // Unknown quote price falls back to $1 per quote unit for the start
    // price; the tier still graduates at exactly 8x the starting price.
    const spec = tierSpec(tier, 1, {
      mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB4b',
      decimals: 6,
      symbol: 'MEME',
    });
    const params = asTierParams(buildCurveParams(spec));
    const migSqrt = getMigrationThresholdPrice(
      params.migrationQuoteThreshold,
      params.sqrtStartPrice,
      params.curve as never,
    );
    const price = Number(
      getPriceFromSqrtPrice(migSqrt, TokenDecimal.NINE, 6).toString(),
    );
    const startPrice = spec.curve.prices[0];
    expect(price / startPrice).toBeGreaterThan(8 * 0.999);
    expect(price / startPrice).toBeLessThan(8 * 1.001);
  });

  it('calibrateTierThreshold rejects out-of-range targets', () => {
    const tier = quickTierById('fast');
    const spec = tierSpec(tier, 200, {
      mint: SOL_MINT,
      decimals: 9,
      symbol: 'SOL',
    });
    const params = asTierParams(
      buildCurveParams({ ...spec, quickTierId: undefined }),
    );
    expect(() =>
      calibrateTierThreshold(params, -1, 9, 9),
    ).toThrowError(/positive/);
    // A target above the curve's max price cannot be calibrated.
    expect(() =>
      calibrateTierThreshold(params, 1e30, 9, 9),
    ).toThrowError(/outside the curve range/);
  });
});
