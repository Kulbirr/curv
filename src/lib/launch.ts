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
import { LAUNCH_FEE_CONFIG } from './launch-fees';

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
  { id: 'long', name: 'Long', blurb: 'Extended runway with six segments before graduation.' },
  { id: 'gentle', name: 'Gentle', blurb: 'A calm slope between flat and exponential.' },
];

/** Build a CurveDesign from a preset and a starting price (quote UI units). */
export function presetCurve(preset: CurvePresetId, startPrice: number): CurveDesign {
  const multipliers = PRESET_MULTIPLIERS[preset];
  const prices = multipliers.map((m) => startPrice * m);
  const liquidityWeights = new Array(prices.length - 1).fill(1);
  return { prices, liquidityWeights };
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

  const baseDecimalEnum = toTokenDecimalEnum(spec.baseDecimals);
  const sqrtPrices = createSqrtPrices(spec.curve.prices, baseDecimalEnum, spec.quoteDecimals);

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
          numberOfPeriod: LAUNCH_FEE_CONFIG.feeSchedulerPeriods,
          totalDuration: LAUNCH_FEE_CONFIG.feeSchedulerTotalDuration,
        },
      },
      dynamicFeeEnabled: LAUNCH_FEE_CONFIG.dynamicFeeEnabled,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: LAUNCH_FEE_CONFIG.creatorTradingFeePercent,
      poolCreationFee: LAUNCH_FEE_CONFIG.poolCreationFeeSol,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: {
        feePercentage: LAUNCH_FEE_CONFIG.migrationFeePercent,
        creatorFeePercentage: LAUNCH_FEE_CONFIG.creatorMigrationFeePercent,
      },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: LAUNCH_FEE_CONFIG.migratedPoolDynamicFee
          ? DammV2DynamicFeeMode.Enabled
          : DammV2DynamicFeeMode.Disabled,
        poolFeeBps: LAUNCH_FEE_CONFIG.migratedPoolFeeBps,
        baseFeeMode: DammV2BaseFeeMode.FeeTimeSchedulerLinear,
      },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
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

/**
 * Build the unsigned createConfigAndPool transaction.
 * The caller partial-signs with configKeypair + baseMintKeypair, sets the
 * fee payer + blockhash, then asks the wallet to sign.
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
    feeClaimer: payer,
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
