/**
 * Trading mode helpers for the trade panel.
 *
 * The panel has exactly two modes, derived from exactly one boolean
 * (`state.graduated`). DBC mode is the bonding curve flow. Jupiter mode
 * takes over after graduation and routes swaps through the Jupiter
 * aggregator. A failed Jupiter quote can never flip the mode: the mode
 * comes from pool state, never from quote results.
 */

export type TradeMode = 'dbc' | 'jupiter';

/** Pure mode derivation. graduated === true -> 'jupiter', else 'dbc'. */
export function deriveTradeMode(graduated: boolean | undefined): TradeMode {
  return graduated === true ? 'jupiter' : 'dbc';
}

/**
 * Referral fee bps to request on Jupiter quotes. Returns 0 (fee disabled)
 * when there is no fee account configured, so trading is never blocked
 * by missing fee plumbing.
 */
export function resolveJupiterFeeBps(feeAccount: string | null): number {
  return feeAccount ? 25 : 0;
}

/** Human friendly fee label, e.g. 25 -> "Curv fee 0.25%". Dash free. */
export function formatFeeLabel(feeBps: number): string {
  return `Curv fee ${feeBps / 100}%`;
}

/** Deep link fallback when Jupiter has no route or is unreachable. */
export function jupiterDeepLink(inputMint: string, outputMint: string): string {
  return `https://jup.ag/swap?inputMint=${inputMint}&outputMint=${outputMint}`;
}
