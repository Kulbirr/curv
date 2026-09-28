/**
 * "Paste an address to preview" — header search helper.
 *
 * A pasted base58 address is checked against our own pool registry via
 * the indexed state endpoint (zero live RPC per visitor). Outcomes:
 * - invalid: not a plausible Solana address at all.
 * - pool: a tracked Curv pool — jump straight to its page.
 * - unknown: valid address, but not a Curv pool — said honestly.
 * - error: the check itself failed (network/API) — never mislabeled
 *   as "unknown".
 */

/** Base58, 32-44 chars: the same shape check the launch form uses. */
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type AddressPreviewResult =
  | { kind: 'invalid' }
  | { kind: 'pool'; poolAddress: string }
  | { kind: 'unknown'; address: string }
  | { kind: 'error' };

/** Trim and validate; returns the canonical address or null. */
export function parsePreviewAddress(input: string): string | null {
  const trimmed = input.trim();
  return ADDRESS_RE.test(trimmed) ? trimmed : null;
}

export async function previewAddress(
  input: string,
  fetchFn: typeof fetch = fetch,
): Promise<AddressPreviewResult> {
  const address = parsePreviewAddress(input);
  if (!address) return { kind: 'invalid' };
  let res: Response;
  try {
    res = await fetchFn(`/api/pools/${encodeURIComponent(address)}/state`);
  } catch {
    return { kind: 'error' };
  }
  if (res.status === 404) return { kind: 'unknown', address };
  if (!res.ok) return { kind: 'error' };
  return { kind: 'pool', poolAddress: address };
}
