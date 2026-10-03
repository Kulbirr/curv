import {
  TokenDecimal,
  getMigrationThresholdPrice,
  getPriceFromSqrtPrice,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { BN } from '@coral-xyz/anchor';
import type { CurveDesign } from './launch';

/**
 * Curv Quick graduation tiers.
 *
 * Every tier starts near a $5k market cap and graduates at an exact,
 * advertised cap: $20k sprint, $38k cruise (the default), $50k marathon.
 * The end multiple is the price multiple of the $5k start, so
 * the USD caps hold exactly whenever the quote asset has a known USD
 * price; for quote mints without a USD price the same tiers graduate at
 * exactly 4x / 7.6x / 10x the starting price, which is what the UI shows.
 */
export type QuickTierId = 'sprint' | 'cruise' | 'marathon';

export interface QuickTier {
  id: QuickTierId;
  /** Advertised graduation cap in USD (exact when the quote is priced). */
  capUsd: number;
  /** Price multiple of the $5k start at graduation. */
  endMultiple: number;
  /** Middle ladder multiples, keep the exponential feel of the old curve. */
  mids: [number, number];
  /** Card headline, e.g. "$38K". */
  headline: string;
  /** Card name, e.g. "cruise". */
  name: string;
  /** Card blurb, e.g. "the balanced pick". */
  blurb: string;
}

export const QUICK_TIERS: QuickTier[] = [
  {
    id: 'sprint',
    capUsd: 20_000,
    endMultiple: 4,
    mids: [1.8, 2.4],
    headline: '$20K',
    name: 'sprint',
    blurb: 'Quickest path to graduation',
  },
  {
    id: 'cruise',
    capUsd: 38_000,
    endMultiple: 7.6,
    mids: [1.8, 4.3],
    headline: '$38K',
    name: 'cruise',
    blurb: 'Steady climb, most popular',
  },
  {
    id: 'marathon',
    capUsd: 50_000,
    endMultiple: 10,
    mids: [1.8, 5.7],
    headline: '$50K',
    name: 'marathon',
    blurb: 'Longest run, deepest liquidity',
  },
];

export const DEFAULT_QUICK_TIER_ID: QuickTierId = 'cruise';

export function quickTierById(id: string | null | undefined): QuickTier {
  return QUICK_TIERS.find((t) => t.id === id) ?? QUICK_TIERS[1];
}

/**
 * How far past the advertised graduation price the on-chain curve runs.
 * The curve keeps 50% of headroom beyond the migration point, so buys
 * near graduation always have somewhere to go: the old dust zone where
 * the final buys reverted with 6033 cannot happen by construction.
 */
export const TIER_CURVE_HEADROOM = 1.5;

/** The 4 advertised price points: start, two mids, graduation. */
export function quickTierDisplayPrices(
  startPrice: number,
  tier: QuickTier,
): number[] {
  return [1, tier.mids[0], tier.mids[1], tier.endMultiple].map(
    (m) => startPrice * m,
  );
}

/**
 * The on-chain curve for a tier: the advertised ladder plus one headroom
 * point at 1.5x the graduation price. The migration threshold is then
 * calibrated (see calibrateTierThreshold) to sit exactly at the
 * graduation price, with the headroom segment absorbing any overshoot.
 *
 * The headroom segment carries double liquidity weight. That weight is
 * structural, not economic: no trade can ever reach past the migration
 * price, so the segment is never traded. Its depth keeps the DBC SDK's
 * supply validation (a 25% swap buffer capped at the full-curve base)
 * comfortably inside the 1B supply for every tier; with a uniform
 * weight the calibrated threshold fails validation at ~102% of supply.
 */
export function quickTierCurveDesign(
  startPrice: number,
  tier: QuickTier,
): CurveDesign {
  const prices = [
    ...quickTierDisplayPrices(startPrice, tier),
    startPrice * tier.endMultiple * TIER_CURVE_HEADROOM,
  ];
  return {
    prices,
    liquidityWeights: [1, 1, 1, 2],
  };
}

export interface TierCurveParams {
  migrationQuoteThreshold: BN;
  sqrtStartPrice: BN;
  curve: Array<{ sqrtPrice: BN; liquidity: BN }>;
}

function priceAtThreshold(
  params: TierCurveParams,
  threshold: BN,
  baseDecimals: 6 | 9,
  quoteDecimals: number,
): number {
  const migSqrt = getMigrationThresholdPrice(
    threshold,
    params.sqrtStartPrice,
    params.curve as never,
  );
  const baseDec =
    baseDecimals === 6 ? TokenDecimal.SIX : TokenDecimal.NINE;
  const price = getPriceFromSqrtPrice(migSqrt, baseDec, quoteDecimals);
  return Number(price.toString());
}

/**
 * Calibrate the migration quote threshold so the pool graduates at
 * exactly `targetEndPrice` (quote UI units per base token), even though
 * the on-chain curve runs 1.5x past it.
 *
 * The migration price is monotonic in the quote threshold, so a binary
 * search on the SDK's own math converges on the exact threshold. The
 * result is always below the full-curve maximum, which is what leaves
 * the headroom segment intact after migration.
 *
 * Throws when the target price is not positive or sits outside the
 * curve's price range.
 */
export function calibrateTierThreshold(
  params: TierCurveParams,
  targetEndPrice: number,
  baseDecimals: 6 | 9,
  quoteDecimals: number,
): BN {
  if (!Number.isFinite(targetEndPrice) || targetEndPrice <= 0)
    throw new Error('Tier graduation price must be positive');
  const maxThreshold = params.migrationQuoteThreshold;
  if (maxThreshold.lte(new BN(0)))
    throw new Error('Curve has no migration threshold to calibrate');
  const maxPrice = priceAtThreshold(
    params,
    maxThreshold,
    baseDecimals,
    quoteDecimals,
  );
  if (!(targetEndPrice < maxPrice))
    throw new Error(
      'Tier graduation price is outside the curve range, cannot calibrate',
    );

  let lo = new BN(1);
  let hi = maxThreshold;
  // Integer binary search on raw quote units; 200 iterations is far more
  // than enough to close the interval to a single unit.
  for (let i = 0; i < 200; i++) {
    if (hi.sub(lo).lte(new BN(1))) break;
    const mid = lo.add(hi).div(new BN(2));
    const price = priceAtThreshold(params, mid, baseDecimals, quoteDecimals);
    if (!Number.isFinite(price) || price <= 0) {
      lo = mid;
      continue;
    }
    if (price < targetEndPrice) lo = mid;
    else hi = mid;
  }
  const finalPrice = priceAtThreshold(params, hi, baseDecimals, quoteDecimals);
  const relErr = Math.abs(finalPrice - targetEndPrice) / targetEndPrice;
  if (!(relErr < 0.001))
    throw new Error('Tier threshold calibration did not converge');
  return hi;
}
