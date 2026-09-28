import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  REGISTRATION_TTL_MS,
  buildRegistrationMessage,
  isFreshTimestamp,
  verifyWalletSignature,
} from './signatures';

function sign(message: string, secretKey: Uint8Array): string {
  return bs58.encode(nacl.sign.detached(Buffer.from(message, 'utf8'), secretKey));
}

describe('verifyWalletSignature', () => {
  it('accepts a genuine ed25519 signature from the claimed signer', async () => {
    const kp = Keypair.generate();
    const msg = buildRegistrationMessage('pool111', kp.publicKey.toBase58(), Date.now());
    const sig = sign(msg, kp.secretKey);
    expect(verifyWalletSignature(msg, sig, kp.publicKey.toBase58())).toBe(true);
  });

  it('rejects a tampered message', async () => {
    const kp = Keypair.generate();
    const msg = buildRegistrationMessage('pool111', kp.publicKey.toBase58(), 123);
    const sig = sign(msg, kp.secretKey);
    expect(verifyWalletSignature(msg + 'tampered', sig, kp.publicKey.toBase58())).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const kp = Keypair.generate();
    const other = Keypair.generate();
    const msg = 'hello';
    const sig = sign(msg, other.secretKey);
    expect(verifyWalletSignature(msg, sig, kp.publicKey.toBase58())).toBe(false);
  });

  it('rejects malformed signatures and signers without throwing', async () => {
    const kp = Keypair.generate();
    expect(verifyWalletSignature('m', 'not-base58!!!', kp.publicKey.toBase58())).toBe(false);
    expect(verifyWalletSignature('m', bs58.encode(Buffer.alloc(32)), kp.publicKey.toBase58())).toBe(
      false,
    );
    expect(verifyWalletSignature('m', bs58.encode(Buffer.alloc(64)), 'bad-signer')).toBe(false);
    expect(verifyWalletSignature('m', bs58.encode(Buffer.alloc(64)), bs58.encode(Buffer.alloc(31)))).toBe(
      false,
    );
  });
});

describe('buildRegistrationMessage', () => {
  it('is domain-separated and deterministic', async () => {
    const m = buildRegistrationMessage('P', 'C', 42);
    expect(m).toBe(
      ['StockCurve pool registration', 'pool: P', 'creator: C', 'timestamp: 42'].join('\n'),
    );
    expect(buildRegistrationMessage('P', 'C', 42)).toBe(m);
  });

  it('binds the pool, creator and timestamp (no cross-message replay)', async () => {
    const a = buildRegistrationMessage('P1', 'C', 1);
    expect(buildRegistrationMessage('P2', 'C', 1)).not.toBe(a);
    expect(buildRegistrationMessage('P1', 'C2', 1)).not.toBe(a);
    expect(buildRegistrationMessage('P1', 'C', 2)).not.toBe(a);
  });
});

describe('isFreshTimestamp', () => {
  it('accepts timestamps inside the 5-minute TTL', async () => {
    const now = Date.now();
    expect(isFreshTimestamp(now)).toBe(true);
    expect(isFreshTimestamp(now - REGISTRATION_TTL_MS + 1000)).toBe(true);
    expect(isFreshTimestamp(now + REGISTRATION_TTL_MS - 1000)).toBe(true); // clock skew
  });

  it('rejects expired timestamps', async () => {
    const now = Date.now();
    expect(isFreshTimestamp(now - REGISTRATION_TTL_MS - 1000)).toBe(false);
    expect(isFreshTimestamp(now + REGISTRATION_TTL_MS + 1000)).toBe(false);
    expect(isFreshTimestamp(NaN)).toBe(false);
    expect(isFreshTimestamp(Infinity)).toBe(false);
  });

  it('TTL is 5 minutes', async () => {
    expect(REGISTRATION_TTL_MS).toBe(5 * 60_000);
  });
});
