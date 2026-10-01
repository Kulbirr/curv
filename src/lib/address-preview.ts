/**
 * "Paste an address to preview", header search helper.
 *
 * A pasted base58 address is checked against our own pool registry via
 * the resolve endpoint (zero live RPC per visitor). Outcomes:
 * - invalid: not a plausible Solana address at all.
 * - pool: a tracked Curv pool, jump straight to its page.
 * - mint: a tracked base token mint, jump to its pool's page.
 * - unknown: valid address, but not a Curv pool or coin, said honestly.
 * - error: the check itself failed (network/API), never mislabeled
 *   as "unknown".
 */

/** Base58, 32-44 chars: the same shape check the launch form uses. */
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type AddressPreviewResult =
  | { kind: 'invalid' }
  | { kind: 'pool'; poolAddress: string }
  | { kind: 'mint'; poolAddress: string }
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
    res = await fetchFn(`/api/pools/resolve/${encodeURIComponent(address)}`);
  } catch {
    return { kind: 'error' };
  }
  if (res.status === 404) return { kind: 'unknown', address };
  if (!res.ok) return { kind: 'error' };
  const json = (await res.json()) as { kind?: string; poolAddress?: string };
  if (json.kind === 'mint' && typeof json.poolAddress === 'string') {
    return { kind: 'mint', poolAddress: json.poolAddress };
  }
  if (json.kind === 'pool' && typeof json.poolAddress === 'string') {
    return { kind: 'pool', poolAddress: json.poolAddress };
  }
  return { kind: 'error' };
}
