import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * At-rest encryption for the pre-ground vanity mint pool.
 *
 * The grinder (scripts/grind-pool.ts) generates single-use mint keypairs
 * whose secrets are stored in the vanity_pool table. Those secrets are
 * encrypted with AES-256-GCM under a 32-byte key supplied as hex in the
 * VANITY_POOL_KEY environment variable. Everything fails closed when the
 * variable is unset or malformed — the grinder refuses to start and the
 * handout endpoint returns 503.
 *
 * Blob layout: 12-byte IV || 32-byte auth tag || ciphertext (64 bytes for
 * an ed25519 secret key). One blob per row, no key reuse across rows
 * (fresh random IV each time).
 */

export const VANITY_POOL_KEY_ENV = 'VANITY_POOL_KEY';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_BYTES = 64; // ed25519 secret key length

function failClosed(reason: string): never {
  throw new Error(
    `[vanity-pool] ${reason}. Set ${VANITY_POOL_KEY_ENV} to 64 hex characters ` +
      `(generate with: openssl rand -hex 32). Refusing to run without it.`,
  );
}

/** Parse and validate the pool encryption key. Throws (fail closed) on any problem. */
export function getVanityPoolKey(): Buffer {
  const hex = process.env[VANITY_POOL_KEY_ENV];
  if (!hex) failClosed(`${VANITY_POOL_KEY_ENV} is not set`);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    failClosed(`${VANITY_POOL_KEY_ENV} must be exactly 64 hex characters (32 bytes)`);
  }
  return Buffer.from(hex, 'hex');
}

/** Encrypt a 64-byte ed25519 secret key. Returns the IV||tag||ciphertext blob. */
export function encryptSecret(secretKey: Buffer | Uint8Array): Buffer {
  const key = getVanityPoolKey();
  const plain = Buffer.from(secretKey);
  if (plain.length !== SECRET_BYTES) {
    throw new Error(`[vanity-pool] refusing to encrypt non-secret-key material (${plain.length} bytes)`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/** Decrypt a blob produced by encryptSecret. Throws on wrong key or tampering. */
export function decryptSecret(blob: Buffer | Uint8Array): Buffer {
  const key = getVanityPoolKey();
  const data = Buffer.from(blob);
  if (data.length !== IV_BYTES + TAG_BYTES + SECRET_BYTES) {
    throw new Error('[vanity-pool] malformed encrypted secret blob');
  }
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = data.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
