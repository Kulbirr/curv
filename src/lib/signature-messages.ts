/**
 * Domain-separated wallet-signed message builders.
 *
 * Pure functions with no Node imports, so both the browser bundle and the
 * server can import them. The server verifies these with ed25519 in
 * src/lib/signatures.ts; the browser builds the identical strings before
 * calling wallet.signMessage(). Keeping both sides in one module means the
 * formats cannot drift apart.
 */

/** Wallet-signed backend writes expire after 5 minutes to prevent replays. */
export const SIGNATURE_TTL_MS = 5 * 60 * 1000;

export function buildRegistrationMessage(
  poolAddress: string,
  creator: string,
  timestamp: number,
): string {
  return [
    'StockCurve pool registration',
    `pool: ${poolAddress}`,
    `creator: ${creator}`,
    `timestamp: ${timestamp}`,
  ].join('\n');
}

/**
 * Binds a metadata/R2 upload to the wallet that is about to launch the
 * token, so anonymous clients cannot use Curv's bucket as free storage.
 * Signed during the launch flow, before the on-chain transaction.
 */
export function buildMetadataUploadMessage(wallet: string, timestamp: number): string {
  return ['Curv metadata upload', `wallet: ${wallet}`, `timestamp: ${timestamp}`].join(
    '\n',
  );
}

export function isFreshTimestamp(timestamp: number): boolean {
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) <= SIGNATURE_TTL_MS;
}
