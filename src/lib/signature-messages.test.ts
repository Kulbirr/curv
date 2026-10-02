import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  buildMetadataUploadMessage,
  buildRegistrationMessage,
  isFreshTimestamp,
  SIGNATURE_TTL_MS,
} from './signature-messages';
import { verifyWalletSignature } from './signatures';
import { checkUploadAuthorization } from '../pages/api/metadata';

function sign(message: string, secretKey: Uint8Array): string {
  return bs58.encode(nacl.sign.detached(Buffer.from(message, 'utf8'), secretKey));
}

function signedBody(kp: Keypair, timestamp = Date.now()) {
  const wallet = kp.publicKey.toBase58();
  return {
    name: 'Test',
    symbol: 'TST',
    wallet,
    timestamp,
    signature: sign(buildMetadataUploadMessage(wallet, timestamp), kp.secretKey),
  };
}

describe('buildMetadataUploadMessage', () => {
  it('is domain-separated and deterministic', () => {
    const m = buildMetadataUploadMessage('W', 42);
    expect(m).toBe(['Curv metadata upload', 'wallet: W', 'timestamp: 42'].join('\n'));
    expect(buildMetadataUploadMessage('W', 42)).toBe(m);
  });

  it('binds wallet and timestamp (no cross-message replay)', () => {
    const a = buildMetadataUploadMessage('W1', 1);
    expect(buildMetadataUploadMessage('W2', 1)).not.toBe(a);
    expect(buildMetadataUploadMessage('W1', 2)).not.toBe(a);
    // Cannot be confused with a registration message.
    expect(a).not.toBe(buildRegistrationMessage('W1', 'W1', 1));
  });
});

describe('checkUploadAuthorization', () => {
  it('accepts a fresh valid wallet signature', () => {
    expect(checkUploadAuthorization(signedBody(Keypair.generate()))).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(checkUploadAuthorization({})).not.toBeNull();
    expect(checkUploadAuthorization({ wallet: 'W' })).not.toBeNull();
  });

  it('rejects stale timestamps', () => {
    const kp = Keypair.generate();
    const body = signedBody(kp, Date.now() - SIGNATURE_TTL_MS - 1000);
    expect(checkUploadAuthorization(body)).toMatch(/expired/i);
  });

  it('rejects signatures from a different wallet', () => {
    const kp = Keypair.generate();
    const other = Keypair.generate();
    const wallet = other.publicKey.toBase58();
    const ts = Date.now();
    const body = {
      wallet,
      timestamp: ts,
      signature: sign(buildMetadataUploadMessage(wallet, ts), kp.secretKey),
    };
    expect(checkUploadAuthorization(body)).toMatch(/invalid/i);
  });

  it('the signed message verifies with verifyWalletSignature', () => {
    const kp = Keypair.generate();
    const ts = Date.now();
    const wallet = kp.publicKey.toBase58();
    const message = buildMetadataUploadMessage(wallet, ts);
    expect(verifyWalletSignature(message, sign(message, kp.secretKey), wallet)).toBe(true);
    expect(isFreshTimestamp(ts)).toBe(true);
  });
});

describe('buildRegistrationMessage with fee splits', () => {
  const alice = Keypair.generate().publicKey.toBase58();
  const bob = Keypair.generate().publicKey.toBase58();

  it('keeps the historical format when no splits are given', () => {
    const msg = buildRegistrationMessage('pool1', 'creator1', 123);
    expect(msg).toBe(
      ['StockCurve pool registration', 'pool: pool1', 'creator: creator1', 'timestamp: 123'].join(
        '\n',
      ),
    );
  });

  it('appends canonical split terms sorted by wallet', () => {
    const msg = buildRegistrationMessage('pool1', 'creator1', 123, [
      { wallet: bob, bps: 1000, handle: 'bob' },
      { wallet: alice, bps: 2500 },
    ]);
    const terms = [alice, bob].sort().map((w) => (w === alice ? `${w}:2500` : `${w}:1000:bob`)).join(',');
    expect(msg.endsWith(`fee splits: ${terms}`)).toBe(true);
  });

  it('binds the signed terms so any tampering breaks verification', () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const splits = [{ wallet: alice, bps: 2500 }];
    const message = buildRegistrationMessage('pool1', wallet, Date.now(), splits);
    const sig = sign(message, kp.secretKey);
    expect(verifyWalletSignature(message, sig, wallet)).toBe(true);
    const tampered = message.replace('2500', '9000');
    expect(verifyWalletSignature(tampered, sig, wallet)).toBe(false);
  });
});
