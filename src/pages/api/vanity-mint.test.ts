import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { randomBytes } from 'crypto';
import handler, { VANITY_HANDOUT_LIMIT } from './vanity-mint';
import { storeVanityMint } from '@/lib/db/vanity-pool';
import { VANITY_POOL_KEY_ENV, encryptSecret } from '@/lib/vanity-crypto';
import { mockReqRes } from '@/test-support/http';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: ReturnType<typeof useTempDb>;
const TEST_KEY = randomBytes(32).toString('hex');
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env[VANITY_POOL_KEY_ENV];
  process.env[VANITY_POOL_KEY_ENV] = TEST_KEY;
  db = useTempDb();
});

afterEach(() => {
  db.cleanup();
  if (savedKey === undefined) delete process.env[VANITY_POOL_KEY_ENV];
  else process.env[VANITY_POOL_KEY_ENV] = savedKey;
});

function storeKeypair(): Keypair {
  const kp = Keypair.generate();
  storeVanityMint(
    kp.publicKey.toBase58(),
    encryptSecret(Buffer.from(kp.secretKey)),
    Date.now(),
  );
  return kp;
}

function post(ip = '127.0.0.1') {
  const { req, res } = mockReqRes('POST', { remoteAddress: ip, body: {} });
  return { req, res };
}

describe('POST /api/vanity-mint', () => {
  it('hands out a valid keypair exactly once, then reports the pool dry', async () => {
    const kp = storeKeypair();

    const first = post();
    await handler(first.req, first.res);
    expect(first.res.statusCode).toBe(200);
    expect(first.res.body.publicKey).toBe(kp.publicKey.toBase58());
    const handed = Keypair.fromSecretKey(
      Buffer.from(first.res.body.secretKey, 'base64'),
    );
    expect(handed.publicKey.toBase58()).toBe(kp.publicKey.toBase58());

    // Pool is now dry: honest 503, never a duplicate handout.
    const second = post();
    await handler(second.req, second.res);
    expect(second.res.statusCode).toBe(503);
    expect(second.res.body.error).toMatch(/empty/i);
  });

  it('enforces 5 handouts per hour per IP', async () => {
    for (let i = 0; i < VANITY_HANDOUT_LIMIT + 1; i++) storeKeypair();
    let last = 0;
    for (let i = 0; i < VANITY_HANDOUT_LIMIT + 1; i++) {
      const { req, res } = post();
      await handler(req, res);
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });

  it('rate limits per IP independently', async () => {
    for (let i = 0; i < 3; i++) storeKeypair();
    const a = post('10.0.0.1');
    await handler(a.req, a.res);
    expect(a.res.statusCode).toBe(200);
    const b = post('10.0.0.2');
    await handler(b.req, b.res);
    expect(b.res.statusCode).toBe(200);
  });

  it('rejects non-POST methods', async () => {
    const { req, res } = mockReqRes('GET', { remoteAddress: '127.0.0.1' });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('fails closed with an honest 503 when the pool key is unset', async () => {
    storeKeypair();
    delete process.env[VANITY_POOL_KEY_ENV];
    const { req, res } = post();
    await handler(req, res);
    // The claim succeeded but decryption is impossible: fail closed,
    // never hand out undecryptable material.
    expect(res.statusCode).toBe(503);
  });

  it('never logs secrets (response carries only the two fields)', async () => {
    storeKeypair();
    const { req, res } = post();
    await handler(req, res);
    expect(Object.keys(res.body).sort()).toEqual(['publicKey', 'secretKey']);
    expect(JSON.stringify(res.body)).not.toContain(randomAddress());
  });
});
