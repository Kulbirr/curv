/**
 * Canonical fee/economics constants for Curv launches.
 *
 * Single source of truth: buildCurveParams() in launch.ts builds the
 * on-chain DBC config from these values, and the launch review page's
 * fee-disclosure box renders them. Change a number here and both move.
 *
 * Every unit was verified against the Meteora DBC SDK:
 * - poolCreationFeeSol: the SDK runs convertToLamports(poolCreationFee),
 *   so the config value is denominated in SOL. 0 is valid (the SDK
 *   accepts zero) and means no creation fee. This is a per-config
 *   setting chosen by Curv, not a Meteora protocol mandate.
 * - migrationFeePercent / creatorMigrationFeePercent: the SDK divides
 *   feePercentage by 100 (percent), and creatorFeePercentage is a
 *   percent of the migration fee (max 100).
 * - creatorTradingFeePercent: passed straight into the SDK's
 *   `creatorTradingFeePercentage` field, which the SDK validates as
 *   0-100 (percent) and divides by 100 on-chain. 0.3 here = 0.3%.
 * - migratedPoolFeeBps: basis points.
 */
export const LAUNCH_FEE_CONFIG = {
  /** Pool creation fee baked into Curv's DBC config (SOL). This is our
   *  own setting, not a Meteora protocol charge: the DBC program lets it
   *  be zero. 0 keeps launching free apart from Solana network fees. */
  poolCreationFeeSol: 0,
  /** Exponential fee-scheduler shape (matches the DBC config). */
  feeSchedulerPeriods: 60,
  feeSchedulerTotalDuration: 60,
  /** Extra dynamic fee on top of the scheduled base fee. */
  dynamicFeeEnabled: true,
  /** Creator's cut of per-trade fees, in percent. 0.3 = 0.3% of every
   *  bonding-curve trade, matching pump.fun. Accrues to the creator's
   *  wallet (feeClaimer) in the traded tokens; the creator claims it
   *  with a signed transaction via claimCreatorTradingFee. */
  creatorTradingFeePercent: 0.3,
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
 * Rows for the launch review page's fee-disclosure box. Every number
 * comes from LAUNCH_FEE_CONFIG (the same constants the on-chain config
 * is built from) or from the user's own fee-schedule inputs, nothing
 * is invented here.
 */
export function buildFeeDisclosureRows(input: FeeDisclosureInput): FeeDisclosureRow[] {
  const c = input.econ ?? LAUNCH_FEE_CONFIG;
  const dyn = (on: boolean) => (on ? ', plus a dynamic fee on volatile swaps' : '');
  return [
    {
      label: 'Pool creation fee',
      value: `${c.poolCreationFeeSol} SOL`,
      hint:
        c.poolCreationFeeSol === 0
          ? 'There is no pool creation fee on Curv. This figure is our own config setting, not a Meteora protocol charge, and the DBC program allows it to be zero. You only pay Solana network fees for the launch transaction, a few cents.'
          : `A ${c.poolCreationFeeSol} SOL creation fee set in Curv's own pool config, not a Meteora protocol charge. Network fees for the launch transaction are on top, a few cents.`,
    },
    {
      label: 'Trading fees',
      value: `${pct(input.startingFeeBps)} → ${pct(input.endingFeeBps)}`,
      hint:
        `Your schedule: decays exponentially over ${c.feeSchedulerPeriods} periods` +
        dyn(c.dynamicFeeEnabled) +
        `. Collected in ${input.quoteSymbol || 'the quote token'}.`,
    },
    {
      label: 'Your share of trading fees',
      value: `${c.creatorTradingFeePercent}%`,
      hint: `You earn ${c.creatorTradingFeePercent}% of every bonding-curve trade, accrued in the traded tokens. Claim it any time with your creator wallet, claiming is a small Solana transaction you sign.`,
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
