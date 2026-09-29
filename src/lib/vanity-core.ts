/**
 * Dependency-free vanity mint core: the suffix constant, the exact
 * case-sensitive matcher, and the difficulty estimate.
 *
 * Kept free of browser/Node APIs so both the client-side grinder
 * (src/lib/vanity-mint.ts) and the server-side pool grinder
 * (scripts/grind-pool.ts) share one definition of "ends in curv".
 */

export const VANITY_SUFFIX = 'curv';

/** Base58 alphabet size (excludes 0, O, I, l). */
const BASE58_ALPHABET_SIZE = 58;

/**
 * Exact, case-sensitive suffix match on a base58 address.
 * "curv" must be the literal tail, "CURV", "Curv" or a mid-string
 * occurrence do not count.
 */
export function matchesVanitySuffix(address: string, suffix: string): boolean {
  if (!suffix) return false;
  return address.endsWith(suffix);
}

/**
 * Expected number of attempts to grind a suffix (mean of the geometric
 * distribution). 58^4 = 11,316,496 for a 4-character suffix.
 */
export function estimateVanityMintAttempts(suffix: string): number {
  return Math.pow(BASE58_ALPHABET_SIZE, suffix.length);
}
