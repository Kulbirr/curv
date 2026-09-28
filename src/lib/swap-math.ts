import { BN } from '@coral-xyz/anchor';

/**
 * Pure integer math for the trade panel.
 *
 * Every conversion here stays in integer (BN) space: JavaScript floats
 * cannot represent token raw amounts exactly (e.g. 0.1 + 0.2 !== 0.3),
 * and a rounding error in a swap amount is real money. The only places
 * floats appear are display-only (price impact %), never in amounts that
 * reach a transaction.
 */

/**
 * Parse a UI decimal string into raw integer units without float math.
 * Null = invalid input (not a number, too many decimals, zero).
 */
export function parseUiAmountToRaw(input: string, decimals: number): BN | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [w = '', f = ''] = s.split('.');
  if (f.length > decimals) return null;
  const whole = w === '' ? '0' : w;
  const digits = whole + f.padEnd(decimals, '0');
  const normalized = digits.replace(/^0+/, '') || '0';
  const bn = new BN(normalized);
  return bn.isZero() ? null : bn;
}

/** Format raw integer units back to a UI decimal string (display only). */
export function rawToUi(raw: BN, decimals: number): string {
  const s = raw.toString(10);
  if (decimals === 0) return s;
  const padded = s.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '');
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Minimum acceptable output after slippage, in raw units.
 * Floors the result: the user is guaranteed *at least* this much.
 * Throws on out-of-range slippage (defense against UI bugs).
 */
export function applySlippageBps(amount: BN, slippageBps: number): BN {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('slippageBps must be an integer 0-10000');
  }
  return amount.muln(10_000 - slippageBps).divn(10_000);
}

export type SwapSide = 'buy' | 'sell';

/**
 * Price impact vs the live spot price (quote tokens per base token),
 * in percent. Positive = worse than spot (you paid/received through the
 * curve). Null when it cannot be computed honestly (no spot price, or
 * zero amounts). Display only — never used in a transaction.
 */
export function priceImpactPct(
  side: SwapSide,
  amountInRaw: BN,
  inDecimals: number,
  outputRaw: BN,
  outDecimals: number,
  spotPrice: number | null | undefined,
): number | null {
  if (!spotPrice || spotPrice <= 0) return null;
  // Display-only float conversion; amounts themselves stay in BN.
  const inUi = Number(amountInRaw.toString()) / 10 ** inDecimals;
  const outUi = Number(outputRaw.toString()) / 10 ** outDecimals;
  if (!(inUi > 0) || !(outUi > 0)) return null;
  if (side === 'buy') {
    const eff = inUi / outUi; // quote per base paid
    return ((eff - spotPrice) / spotPrice) * 100;
  }
  const eff = outUi / inUi; // quote per base received
  return ((spotPrice - eff) / spotPrice) * 100;
}
