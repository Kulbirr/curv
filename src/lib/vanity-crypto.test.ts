import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import {
  VANITY_POOL_KEY_ENV,
  decryptSecret,
  encryptSecret,
  getVanityPoolKey,
} from './vanity-crypto';

const TEST_KEY = randomBytes(32).toString('hex');
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[VANITY_POOL_KEY_ENV];
  process.env[VANITY_POOL_KEY_ENV] = TEST_KEY;
});

afterEach(() => {
  if (saved === undefined) delete process.env[VANITY_POOL_KEY_ENV];
  else process.env[VANITY_POOL_KEY_ENV] = saved;
});

describe('getVanityPoolKey', () => {
  it('fails closed when the env var is unset', async () => {
    delete process.env[VANITY_POOL_KEY_ENV];
    expect(() => getVanityPoolKey()).toThrow(/not set/);
  });

  it('fails closed on malformed keys', async () => {
    for (const bad of ['short', 'zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33)]) {
      process.env[VANITY_POOL_KEY_ENV] = bad;
      expect(() => getVanityPoolKey()).toThrow(/64 hex/);
    }
  });

  it('accepts a valid 64-hex-char key', async () => {
    expect(getVanityPoolKey()).toHaveLength(32);
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a 64-byte secret key', async () => {
    const secret = randomBytes(64);
    const blob = encryptSecret(secret);
    expect(blob.length).toBe(12 + 16 + 64);
    expect(decryptSecret(blob).equals(secret)).toBe(true);
  });

  it('uses a fresh IV per encryption (no deterministic blobs)', async () => {
    const secret = randomBytes(64);
    expect(encryptSecret(secret).equals(encryptSecret(secret))).toBe(false);
  });

  it('fails with the wrong key', async () => {
    const blob = encryptSecret(randomBytes(64));
    process.env[VANITY_POOL_KEY_ENV] = randomBytes(32).toString('hex');
    expect(() => decryptSecret(blob)).toThrow();
  });

  it('fails on tampered ciphertext', async () => {
    const blob = encryptSecret(randomBytes(64));
    blob[blob.length - 1] ^= 0xff;
    expect(() => decryptSecret(blob)).toThrow();
  });

  it('refuses to encrypt non-secret-key material', async () => {
    expect(() => encryptSecret(randomBytes(32))).toThrow(/non-secret-key/);
  });

  it('rejects malformed blobs', async () => {
    expect(() => decryptSecret(randomBytes(10))).toThrow(/malformed/);
  });
});
