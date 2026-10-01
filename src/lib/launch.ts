import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2BaseFeeMode,
  DammV2DynamicFeeMode,
  MigrationFeeOption,
  MigrationOption,
  MigratedCollectFeeMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithCustomSqrtPrices,
  createSqrtPrices,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { getConnection, getDbcClient } from './solana';
import { LAUNCH_FEE_CONFIG, defaultEcon, type ResolvedEcon } from './launch-fees';

/**
 * Designer-friendly launch spec → Meteora DBC SDK params.
 *
 * The visual curve designer works with plain price points (quote tokens per
 * base token, UI units). This module validates the design, converts it to
 * sqrt prices, and builds the real createConfigAndPool transaction that the
 * user's wallet signs. Nothing here touches private keys: the config and
 * base-mint keypairs are freshly generated in the browser for this launch
 * only, and the user signs the transaction in their wallet.
 */

export interface CurveDesign {
  /** Price points from launch to migration, quote UI units per base token. */
  prices: number[];
  /** Liquidity weight per segment (prices.length - 1 entries). */
  liquidityWeights: number[];
}

export interface LaunchSpec {
  name: string;
  symbol: string;
  description?: string;
  imageUrl?: string;
  metadataUri: string;
  quoteMint: string;
  quoteDecimals: number;
  quoteSymbol: string;
  baseDecimals: 6 | 9;
  /** Total base token supply, UI units. */
  totalSupply: number;
  curve: CurveDesign;
  startingFeeBps: number;
  endingFeeBps: number;
  /** Optional creator overrides for the fee schedule and migration.
   *  Anything omitted falls back to LAUNCH_FEE_CONFIG. The creator's
   *  own cuts (0.3% trading fee, 25% of the migration fee) are locked
   *  and intentionally not overridable here. */
  econ?: LaunchEconOverrides;
}

/**
 * Creator-configurable economics. Every field is optional: omitted fields
 * fall back to LAUNCH_FEE_CONFIG. Units match the DBC SDK (bps, percent,
 * slots) unless noted.
 */
export interface LaunchEconOverrides {
  /** Fee-schedule decay periods. SDK requires >= 1. */
  feeSchedulerPeriods?: number;
  /** Fee-schedule total duration, in slots. Must be >= periods. */
  feeSchedulerTotalDuration?: number;
  /** Extra dynamic fee on volatile swaps. */
  dynamicFeeEnabled?: boolean;
  /** Fee taken from migrating liquidity at graduation, whole percent 0-99. */
  migrationFeePercent?: number;
  /** DAMM v2 base fee after graduation, bps, 10-1000. */
  migratedPoolFeeBps?: number;
  /** Dynamic fee on the post-graduation DAMM v2 pool. */
  migratedPoolDynamicFee?: boolean;
}

/** Effective economics: defaults merged with the spec's overrides. */
export function resolveEcon(spec: LaunchSpec): ResolvedEcon {
  return { ...defaultEcon(), ...spec.econ };
}

export type CurvePresetId = 'flat' | 'exponential' | 'long' | 'gentle';

const PRESET_MULTIPLIERS: Record<CurvePresetId, number[]> = {
  flat: [1, 1.08, 1.18, 1.35],
  exponential: [1, 1.6, 3.2, 10],
  long: [1, 1.15, 1.4, 1.8, 2.5, 3.6],
  gentle: [1, 1.12, 1.3, 1.6, 2.1],
};

export const CURVE_PRESETS: Array<{
  id: CurvePresetId;
  name: string;
  blurb: string;
}> = [
  { id: 'flat', name: 'Flat', blurb: 'Slow, steady climb. Built for fair launches.' },
  { id: 'exponential', name: 'Exponential', blurb: 'Aggressive early curve. Rewards the earliest buyers most.' },
  { id: 'long', name: 'Long', blurb: 'Extended runway with five segments before graduation.' },
  { id: 'gentle', name: 'Gentle', blurb: 'A calm slope between flat and exponential.' },
];

/** Build a CurveDesign from a preset and a starting price (quote UI units). */
export function presetCurve(preset: CurvePresetId, startPrice: number): CurveDesign {
  const multipliers = PRESET_MULTIPLIERS[preset];
  const prices = multipliers.map((m) => startPrice * m);
  const liquidityWeights = new Array(prices.length - 1).fill(1);
  return { prices, liquidityWeights };
}

/** Target starting valuation for Quick launches: $5,000 fully-diluted at
 *  the 1B default supply, so the Quick curve (14x end-price multiple)
 *  graduates near ~$70k market cap, matching pump.fun's own $5k start and
 *  ~$69k graduation scale. */
export const QUICK_TARGET_START_FDV_USD = 5000;

/** Quick-launch curve shape, kept separate from the Pro "exponential"
 *  preset so Pro keeps its original [1, 1.6, 3.2, 10] ladder. The 14x
 *  end multiple is what takes a $5k start to ~$70k graduation. */
export const QUICK_CURVE_MULTIPLIERS = [1, 1.8, 4, 14];

/** Build the Quick-launch CurveDesign from a starting price (quote UI units). */
export function quickCurveDesign(startPrice: number): CurveDesign {
  const prices = QUICK_CURVE_MULTIPLIERS.map((m) => startPrice * m);
  const liquidityWeights = new Array(prices.length - 1).fill(1);
  return { prices, liquidityWeights };
}

/** Default token supply for Quick launches. */
export const QUICK_DEFAULT_SUPPLY = 1_000_000_000;

/**
 * Quick-launch default starting price (quote UI units per token) for a
 * quote asset priced at quoteUsdPrice USD. Scaling by the quote price
 * keeps every pair near the same starting valuation: on SOL pairs the
 * exponential preset then graduates near ~74 SOL (the curve shape is
 * unchanged, so graduation scales with the $5k start). Falls back to $1
 * per quote unit when the price is unknown.
 */
export function quickDefaultStartPrice(quoteUsdPrice?: number | null): number {
  const usd =
    quoteUsdPrice && quoteUsdPrice > 0 && Number.isFinite(quoteUsdPrice) ? quoteUsdPrice : 1;
  return QUICK_TARGET_START_FDV_USD / QUICK_DEFAULT_SUPPLY / usd;
}

/** Format a small price for input fields without scientific notation. */
export function formatPriceInput(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const s = n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' ? '0' : s;
}

export function validateLaunchSpec(spec: LaunchSpec): string[] {
  const errors: string[] = [];
  if (!spec.name.trim()) errors.push('Token name is required');
  if (spec.name.trim().length > 32) errors.push('Token name must be 32 characters or less');
  if (!spec.symbol.trim()) errors.push('Token symbol is required');
  if (!/^[A-Za-z0-9]{1,10}$/.test(spec.symbol.trim()))
    errors.push('Symbol must be 1-10 alphanumeric characters');
  try {
    new PublicKey(spec.quoteMint);
  } catch {
    errors.push('Quote mint is not a valid address');
  }
  if (!spec.metadataUri.trim()) errors.push('Metadata URI is required');
  if (!Number.isFinite(spec.totalSupply) || spec.totalSupply < 1_000 || spec.totalSupply > 1e15)
    errors.push('Total supply must be between 1,000 and 1,000,000,000,000,000');
  const { prices, liquidityWeights } = spec.curve;
  if (prices.length < 2 || prices.length > 10) errors.push('Curve needs 2-10 price points');
  if (liquidityWeights.length !== prices.length - 1)
    errors.push('Liquidity weights must match the number of curve segments');
  for (let i = 0; i < prices.length; i++) {
    if (!Number.isFinite(prices[i]) || prices[i] <= 0) {
      errors.push(`Price point ${i + 1} must be a positive number`);
      break;
    }
    if (i > 0 && prices[i] <= prices[i - 1]) {
      errors.push('Price points must strictly increase toward migration');
      break;
    }
  }
  if (liquidityWeights.some((w) => !Number.isFinite(w) || w <= 0))
    errors.push('Liquidity weights must be positive numbers');
  // The DBC SDK enforces MIN_FEE_BPS = 25 and MAX_FEE_BPS = 9900. The UI
  // validation must match the SDK exactly: anything looser lets a launch
  // fail at transaction-build time after the user already designed a curve.
  if (
    !Number.isInteger(spec.startingFeeBps) ||
    spec.startingFeeBps < 25 ||
    spec.startingFeeBps > 9900
  )
    errors.push('Starting fee must be 25-9900 bps');
  if (!Number.isInteger(spec.endingFeeBps) || spec.endingFeeBps < 25 || spec.endingFeeBps > 9900)
    errors.push('Ending fee must be 25-9900 bps');
  if (spec.endingFeeBps > spec.startingFeeBps)
    errors.push('Ending fee cannot exceed the starting fee');
  // Creator-configurable economics. Bounds mirror the DBC SDK exactly so a
  // spec that passes here never fails at transaction-build time.
  const econ = resolveEcon(spec);
  if (!Number.isInteger(econ.feeSchedulerPeriods) || econ.feeSchedulerPeriods < 1)
    errors.push('Fee decay periods must be a whole number of 1 or more');
  if (
    !Number.isInteger(econ.feeSchedulerTotalDuration) ||
    econ.feeSchedulerTotalDuration < econ.feeSchedulerPeriods
  )
    errors.push('Fee decay duration must be a whole number of slots, at least the number of periods');
  if (!Number.isInteger(econ.migrationFeePercent) || econ.migrationFeePercent < 0 || econ.migrationFeePercent > 99)
    errors.push('Migration fee must be a whole percent between 0 and 99');
  if (
    !Number.isInteger(econ.migratedPoolFeeBps) ||
    econ.migratedPoolFeeBps < 10 ||
    econ.migratedPoolFeeBps > 1000
  )
    errors.push('Post-graduation pool fee must be 10-1000 bps');
  return errors;
}

function toTokenDecimalEnum(decimals: number): TokenDecimal {
  if (decimals <= 6) return TokenDecimal.SIX;
  if (decimals === 7) return TokenDecimal.SEVEN;
  if (decimals === 8) return TokenDecimal.EIGHT;
  return TokenDecimal.NINE;
}

/** Convert a validated spec into the SDK's curve params. Throws on invalid input. */
export function buildCurveParams(
  spec: LaunchSpec,
): ReturnType<typeof buildCurveWithCustomSqrtPrices> {
  const errors = validateLaunchSpec(spec);
  if (errors.length > 0) throw new Error(errors[0]);

  const econ = resolveEcon(spec);
  const baseDecimalEnum = toTokenDecimalEnum(spec.baseDecimals);
  const sqrtPrices = createSqrtPrices(spec.curve.prices, baseDecimalEnum, spec.quoteDecimals);
  // The SDK rejects a flat fee (start == end) with nonzero scheduler
  // periods: "numberOfPeriod and totalDuration must both be zero". A flat
  // fee has no decay schedule, so both are zeroed in that case. Without
  // this, every Quick launch (119 -> 119 bps) throws inside
  // buildCurveWithCustomSqrtPrices and pool creation fails.
  const flatFee = spec.startingFeeBps === spec.endingFeeBps;

  return buildCurveWithCustomSqrtPrices({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: baseDecimalEnum,
      tokenQuoteDecimal: spec.quoteDecimals,
      tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAuthority,
      totalTokenSupply: spec.totalSupply,
      leftover: 1000,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: spec.startingFeeBps,
          endingFeeBps: spec.endingFeeBps,
          numberOfPeriod: flatFee ? 0 : econ.feeSchedulerPeriods,
          totalDuration: flatFee ? 0 : econ.feeSchedulerTotalDuration,
        },
      },
      dynamicFeeEnabled: econ.dynamicFeeEnabled,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: econ.creatorTradingFeePercent,
      poolCreationFee: econ.poolCreationFeeSol,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: {
        feePercentage: econ.migrationFeePercent,
        creatorFeePercentage: econ.creatorMigrationFeePercent,
      },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: econ.migratedPoolDynamicFee
          ? DammV2DynamicFeeMode.Enabled
          : DammV2DynamicFeeMode.Disabled,
        poolFeeBps: econ.migratedPoolFeeBps,
        baseFeeMode: DammV2BaseFeeMode.FeeTimeSchedulerLinear,
      },
    },
    liquidityDistribution: {
      // Meteora reads these four as additive shares of the graduated pool's
      // LP that must sum to exactly 100 (plus any vesting shares). The
      // claimable buckets are withdrawable after migration, so they stay 0:
      // 100% of graduated liquidity is permanently locked between Curv and
      // the creator, and neither side can ever pull it.
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage:
        econ.partnerLockedLiquidityPercent,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage:
        econ.creatorLockedLiquidityPercent,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    sqrtPrices,
    liquidityWeights: spec.curve.liquidityWeights,
  });
}

/**
 * Graduation threshold for a spec, in quote UI units (e.g. SOL): the quote
 * reserve level at which the pool migrates to DAMM v2. Computed with the
 * real DBC SDK math from the curve and effective economics, never an
 * estimate. Returns null when the spec is invalid.
 */
export function graduationThresholdQuote(spec: LaunchSpec): number | null {
  try {
    if (validateLaunchSpec(spec).length > 0) return null;
    // buildCurveParams returns the SDK's ConfigParameters at runtime, which
    // carries migrationQuoteThreshold (a BN in quote raw units).
    const params = buildCurveParams(spec) as unknown as {
      migrationQuoteThreshold: { toString(): string };
    };
    const asFloat = Number(params.migrationQuoteThreshold.toString()) / 10 ** spec.quoteDecimals;
    return Number.isFinite(asFloat) && asFloat > 0 ? asFloat : null;
  } catch {
    return null;
  }
}

/**
 * Rescale a spec's curve price ladder so its graduation threshold equals
 * `targetQuote` (quote UI units). The threshold is monotonic in a uniform
 * price scale, so a binary search on the SDK's own math converges on the
 * exact scale factor. Returns the rescaled spec; weights, supply, fees and
 * economics are untouched. Throws when the target is not positive or the
 * spec is invalid.
 */
export function scaleCurveToGraduationTarget(spec: LaunchSpec, targetQuote: number): LaunchSpec {
  if (!Number.isFinite(targetQuote) || targetQuote <= 0)
    throw new Error('Graduation target must be a positive number');
  if (validateLaunchSpec(spec).length > 0) throw new Error('Spec is not valid');
  const scaled = (s: number): LaunchSpec => ({
    ...spec,
    curve: {
      ...spec.curve,
      prices: spec.curve.prices.map((p) => p * s),
    },
  });
  // At extreme scales the SDK math can underflow to zero; treat that as a
  // zero threshold (economically true: a near-free curve needs near-zero
  // quote to fill).
  const thresholdOf = (s: number): number => {
    try {
      return graduationThresholdQuote(scaled(s)) ?? 0;
    } catch {
      return 0;
    }
  };
  // Bracket the target: threshold grows with the price scale.
  let lo = 1e-9;
  let hi = 1;
  if (thresholdOf(hi) < targetQuote) {
    while (thresholdOf(hi) < targetQuote && hi < 1e18) hi *= 2;
  } else {
    while (thresholdOf(lo) > targetQuote && lo > 1e-18) lo /= 2;
  }
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (thresholdOf(mid) < targetQuote) lo = mid;
    else hi = mid;
  }
  const result = scaled((lo + hi) / 2);
  const achieved = thresholdOf((lo + hi) / 2);
  if (achieved <= 0 || Math.abs(achieved - targetQuote) / targetQuote > 0.01)
    throw new Error('Could not match that graduation target');
  return result;
}

export interface BuiltLaunch {
  transaction: Transaction;
  configKeypair: Keypair;
  baseMintKeypair: Keypair;
  poolAddress: PublicKey;
}

export interface BuildLaunchOptions {
  /**
   * Pre-generated base mint keypair (e.g. a vanity-ground "...curv" mint).
   * A fresh random keypair is generated when omitted. The keypair is only
   * ever used to partial-sign client-side; its secret never leaves the
   * browser.
   */
  baseMintKeypair?: Keypair;
}

/** Platform fee wallet (fee claimer), or null when not configured. */
export function platformFeeWallet(): PublicKey | null {
  const raw = process.env.NEXT_PUBLIC_CURV_FEE_WALLET?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}

/**
 * Build the unsigned createConfigAndPool transaction.
 * The caller partial-signs with configKeypair + baseMintKeypair, sets the
 * fee payer + blockhash, then asks the wallet to sign.
 *
 * The fee claimer is Curv's platform wallet (NEXT_PUBLIC_CURV_FEE_WALLET):
 * it receives the partner share of trading fees, 90% of the pool creation
 * fee, and the partner share of the migration fee. When the env var is
 * unset (local dev), it falls back to the payer so launches still work,
 * with the partner share flowing to the creator instead.
 */
export async function buildLaunchTransaction(
  spec: LaunchSpec,
  payer: PublicKey,
  opts: BuildLaunchOptions = {},
): Promise<BuiltLaunch> {
  const client = getDbcClient();
  const connection = getConnection();
  const curveConfig = buildCurveParams(spec);

  const configKeypair = Keypair.generate();
  const baseMintKeypair = opts.baseMintKeypair ?? Keypair.generate();
  const quoteMint = new PublicKey(spec.quoteMint);

  const transaction: Transaction = await client.partner.createConfigAndPool({
    config: configKeypair.publicKey,
    feeClaimer: platformFeeWallet() ?? payer,
    leftoverReceiver: payer,
    payer,
    quoteMint,
    ...curveConfig,
    preCreatePoolParam: {
      baseMint: baseMintKeypair.publicKey,
      name: spec.name.trim(),
      symbol: spec.symbol.trim().toUpperCase(),
      uri: spec.metadataUri.trim(),
      poolCreator: payer,
    },
  });

  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.partialSign(configKeypair, baseMintKeypair);

  const poolAddress = deriveDbcPoolAddress(quoteMint, baseMintKeypair.publicKey, configKeypair.publicKey);

  return { transaction, configKeypair, baseMintKeypair, poolAddress };
}
