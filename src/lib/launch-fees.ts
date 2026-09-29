/**
 * Canonical fee/economics constants for Curv launches.
 *
 * Single source of truth: buildCurveParams() in launch.ts builds the
 * on-chain DBC config from these values, and the launch review page's
 * fee-disclosure box renders them. Change a number here and both move.
 *
 * Every unit was verified against the Meteora DBC SDK and docs:
 * - poolCreationFeeSol: the SDK runs convertToLamports(poolCreationFee),
 *   so the config value is denominated in SOL. 0.02 matches pump.fun.
 *   Meteora requires 0.001-100 SOL and splits it 10% protocol / 90%
 *   to the fee claimer (Curv). This is a per-config setting chosen by
 *   Curv, not a Meteora protocol mandate.
 * - Trading fees: every swap pays Base Fee + Dynamic Fee (capped at 99%).
 *   Meteora takes 20% of the trading fee for the protocol, then the
 *   remaining 80% is split between creator and the fee claimer (Curv)
 *   by creatorTradingFeePercentage.
 * - creatorTradingFeePercent: percent of the non-protocol trading fee
 *   that goes to the creator. 31.51% of 80% of a 1.19% fee = 0.30% of
 *   trade volume to the creator (pump.fun parity); Curv keeps ~0.652%.
 *   The creator claims with a signed transaction via claimCreatorTradingFee.
 * - migrationFeePercent / creatorMigrationFeePercent: the SDK divides
 *   feePercentage by 100 (percent), and creatorFeePercentage is a
 *   percent of the migration fee (max 100). Both must be whole numbers.
 * - migratedPoolFeeBps: basis points.
 */
export const LAUNCH_FEE_CONFIG = {
  /** Pool creation fee baked into Curv's DBC config (SOL), matching
   *  pump.fun's 0.02 SOL. 90% goes to Curv as fee claimer. */
  poolCreationFeeSol: 0.02,
  /** Flat 1.19% trading fee: 60 periods with start == end. */
  feeSchedulerPeriods: 60,
  feeSchedulerTotalDuration: 60,
  /** Extra dynamic fee on top of the scheduled base fee. */
  dynamicFeeEnabled: true,
  /** Creator's cut of the non-protocol trading fee, in percent.
   *  31.51 here = exactly 0.30% of each trade's volume at the 1.19%
   *  flat fee (pump.fun creator parity). */
  creatorTradingFeePercent: 31.51,
  /** Which token trade fees are collected in. */
  collectFeeMode: 'quote token',
  /** Where the pool migrates at graduation. */
  migrationOption: 'DAMM v2',
  /** Fee taken from the migrating liquidity at graduation (percent). */
  migrationFeePercent: 10,
  /** Creator's share of the migration fee (percent of the fee). */
  creatorMigrationFeePercent: 50,
  /** Base fee of the DAMM v2 pool after graduation (basis points). */
  migratedPoolFeeBps: 120,
  /** The DAMM v2 pool also charges a dynamic fee on top. */
  migratedPoolDynamicFee: true,
} as const;

export interface FeeDisclosureInput {
  startingFeeBps: number;
  endingFeeBps: number;
  quoteSymbol: string;
  /** Effective economics (defaults merged with the creator's overrides).
   *  When omitted, LAUNCH_FEE_CONFIG is used. */
  econ?: ResolvedEcon;
}

/** Effective economics: LAUNCH_FEE_CONFIG merged with creator overrides.
 *  Widened from the `as const` literal types so overrides typecheck. */
export interface ResolvedEcon {
  poolCreationFeeSol: number;
  feeSchedulerPeriods: number;
  feeSchedulerTotalDuration: number;
  dynamicFeeEnabled: boolean;
  creatorTradingFeePercent: number;
  collectFeeMode: string;
  migrationOption: string;
  migrationFeePercent: number;
  creatorMigrationFeePercent: number;
  migratedPoolFeeBps: number;
  migratedPoolDynamicFee: boolean;
}

/** The defaults as a mutable effective-economics object. */
export function defaultEcon(): ResolvedEcon {
  return { ...LAUNCH_FEE_CONFIG };
}

export interface FeeDisclosureRow {
  label: string;
  value: string;
  hint: string;
}

function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Effective per-trade fee split for a starting fee schedule, following
 * Meteora's documented DBC math: the protocol takes 20% of the trading
 * fee, then creatorTradingFeePercent of the remaining 80% goes to the
 * creator and the rest to Curv as fee claimer. All figures are percent
 * of trade volume.
 */
export function effectiveTradeFeeSplit(
  startingFeeBps: number,
  econ: Pick<ResolvedEcon, 'creatorTradingFeePercent'> = LAUNCH_FEE_CONFIG,
): { trader: number; protocol: number; creator: number; platform: number } {
  const trader = startingFeeBps / 100;
  const protocol = trader * 0.2;
  const nonProtocol = trader - protocol;
  const creator = (nonProtocol * econ.creatorTradingFeePercent) / 100;
  const platform = nonProtocol - creator;
  return { trader, protocol, creator, platform };
}

function two(n: number): string {
  return n.toFixed(2);
}

/**
 * Rows for the launch review page's fee-disclosure box. Every number
 * comes from LAUNCH_FEE_CONFIG (the same constants the on-chain config
 * is built from) or from the user's own fee-schedule inputs, nothing
 * is invented here.
 */
export function buildFeeDisclosureRows(input: FeeDisclosureInput): FeeDisclosureRow[] {
  const c = input.econ ?? LAUNCH_FEE_CONFIG;
  const dyn = (on: boolean) => (on ? ', plus a dynamic fee on volatile swaps' : '');
  const split = effectiveTradeFeeSplit(input.startingFeeBps, c);
  const flatFee = input.startingFeeBps === input.endingFeeBps;
  return [
    {
      label: 'Pool creation fee',
      value: `${c.poolCreationFeeSol} SOL`,
      hint:
        `A ${c.poolCreationFeeSol} SOL creation fee set in Curv's own pool config, matching pump.fun, not a Meteora protocol charge. ` +
        `Meteora takes 10% of it and Curv receives 90%. Network fees for the launch transaction are on top, a few cents.`,
    },
    {
      label: 'Trading fees',
      value: flatFee ? `${pct(input.startingFeeBps)} flat` : `${pct(input.startingFeeBps)} → ${pct(input.endingFeeBps)}`,
      hint:
        `Every bonding-curve trade pays about ${two(split.trader)}% in fees` +
        (flatFee
          ? ''
          : `, easing from ${pct(input.startingFeeBps)} to ${pct(input.endingFeeBps)}`) +
        dyn(c.dynamicFeeEnabled) +
        `. Meteora takes 20% of the fee for the protocol; the rest splits between you and Curv. Collected in ${input.quoteSymbol || 'the quote token'}.`,
    },
    {
      label: 'Your share of trading fees',
      value: `~${two(split.creator)}% of volume`,
      hint: `You earn about ${two(split.creator)}% of every bonding-curve trade's volume, like pump.fun creators. Claim it any time with your creator wallet, claiming is a small Solana transaction you sign.`,
    },
    {
      label: 'Platform fee',
      value: `~${two(split.platform)}% of volume`,
      hint: `Curv keeps about ${two(split.platform)}% of every bonding-curve trade's volume as the launchpad fee, claimed to the Curv fee wallet. This is how the platform is funded.`,
    },
    {
      label: 'Graduation',
      value: c.migrationOption,
      hint: 'When quote reserves reach your graduation threshold, liquidity migrates automatically.',
    },
    {
      label: 'Migration fee',
      value: `${c.migrationFeePercent}% (you keep ${c.creatorMigrationFeePercent}%)`,
      hint: `At graduation, ${c.migrationFeePercent}% of the migrating liquidity is taken as a fee, half of that fee goes to you as the creator.`,
    },
    {
      label: 'After graduation',
      value: `${pct(c.migratedPoolFeeBps)}${c.migratedPoolDynamicFee ? ' + dynamic' : ''}`,
      hint: `The ${c.migrationOption} pool charges a ${pct(c.migratedPoolFeeBps)} base fee` +
        (c.migratedPoolDynamicFee ? ' plus a dynamic fee' : '') +
        ' on swaps.',
    },
    {
      label: 'Network fees',
      value: 'Small',
      hint: 'You also pay Solana network fees for the launch transaction itself, a few cents, varying with the accounts created.',
    },
  ];
}
