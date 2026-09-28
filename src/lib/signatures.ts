import { createPublicKey, verify } from 'crypto';
import bs58 from 'bs58';

/**
 * Wallet signature verification for backend writes.
 *
 * The frontend asks the user's wallet to signMessage() a domain-separated
 * string; the server verifies the ed25519 signature with Node's built-in
 * crypto (no new dependencies). This gates all backend writes (pool
 * registration, preset publishing) so random clients cannot inject data.
 *
 * Money and ownership always stay on-chain; this only protects our index.
 */

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyWalletSignature(
  messageText: string,
  signatureBase58: string,
  signerBase58: string,
): boolean {
  try {
    const rawKey = bs58.decode(signerBase58);
    if (rawKey.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(rawKey)]),
      format: 'der',
      type: 'spki',
    });
    const signature = bs58.decode(signatureBase58);
    if (signature.length !== 64) return false;
    return verify(null, Buffer.from(messageText, 'utf8'), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Registration messages expire after 5 minutes to prevent replays. */
export const REGISTRATION_TTL_MS = 5 * 60 * 1000;

export function buildRegistrationMessage(poolAddress: string, creator: string, timestamp: number): string {
  return [`StockCurve pool registration`, `pool: ${poolAddress}`, `creator: ${creator}`, `timestamp: ${timestamp}`].join('\n');
}

export function isFreshTimestamp(timestamp: number): boolean {
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) <= REGISTRATION_TTL_MS;
}
