import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import handler from '@/pages/api/pools/index';
import { getDbcClient } from '@/lib/solana';
import { buildRegistrationMessage } from '@/lib/signatures';
import { insertPool } from '@/lib/db/pools';
import { recordPoolSample } from '@/lib/db/states';
import { recordTick } from '@/lib/db/ticks';
import { getVerification } from '@/lib/db/verifications';
import { SOL_MINT } from '@/lib/quote-assets';
import { mockReqRes } from '@/test-support/http';
import { randomAddress, useTempDb } from '@/test-support/db';

vi.mock('@/lib/solana', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/solana')>();
  return { ...actual, getDbcClient: vi.fn() };
});

const mockGetDbcClient = getDbcClient as unknown as ReturnType<typeof vi.fn>;

function signRegistration(poolAddress: string, creatorKp: Keypair, timestamp: number): string {
  const message = buildRegistrationMessage(
    poolAddress,
    creatorKp.publicKey.toBase58(),
    timestamp,
  );
  return bs58.encode(nacl.sign.detached(Buffer.from(message, 'utf8'), creatorKp.secretKey));
}

function signedBody(overrides: Record<string, unknown> = {}) {
  const creatorKp = Keypair.generate();
  // The signature binds poolAddress, so resolve the override first.
  const poolAddress = (overrides.poolAddress as string | undefined) ?? randomAddress();
  const timestamp = Date.now();
  const rest = { ...overrides };
  delete rest.poolAddress;
  return {
    creatorKp,
    body: {
      poolAddress,
      configAddress: randomAddress(),
      baseMint: randomAddress(),
      quoteMint: SOL_MINT,
      creator: creatorKp.publicKey.toBase58(),
      baseSymbol: 'TEST',
      baseName: 'Test Token',
      quoteSymbol: 'SOL',
      timestamp,
      signature: signRegistration(poolAddress, creatorKp, timestamp),
      ...rest,
    },
  };
}

/** RPC double whose on-chain accounts match the submitted body. */
function mockMatchingRpc(body: Record<string, unknown>) {
  mockGetDbcClient.mockReturnValue({
    state: {
      getPool: async () => ({
        poolState: {
          config: new PublicKey(body.configAddress as string),
          creator: new PublicKey(body.creator as string),
          baseMint: new PublicKey(body.baseMint as string),
        },
      }),
      getPoolConfig: async () => ({ quoteMint: new PublicKey(body.quoteMint as string) }),
    },
  });
}

function mockRpcDown() {
  mockGetDbcClient.mockReturnValue({
    state: {
      getPool: async () => {
        throw new Error('RPC unreachable');
      },
      getPoolConfig: async () => {
        throw new Error('RPC unreachable');
      },
    },
  });
}

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
  vi.clearAllMocks();
});
afterEach(async () => { await db.cleanup(); });

async function seedPool(overrides: Record<string, unknown> = {}) {
  return await insertPool({
    poolAddress: randomAddress(),
    configAddress: randomAddress(),
    baseMint: randomAddress(),
    quoteMint: SOL_MINT,
    creator: randomAddress(),
    baseSymbol: 'SEED',
    baseName: 'Seed Token',
    quoteSymbol: 'SOL',
    verified: true,
    ...overrides,
  });
}

describe('GET /api/pools', () => {
  it('returns 200 with pool summaries including baseMint for exact matching', async () => {
    const p = await seedPool();
    const { req, res } = mockReqRes('GET');
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.network).toBe('devnet');
    expect(res.body.pools).toHaveLength(1);
    const s = res.body.pools[0];
    expect(s.poolAddress).toBe(p.poolAddress);
    expect(s.baseMint).toBe(p.baseMint);
    expect(s.quoteMint).toBe(p.quoteMint);
    expect(s.verified).toBe(true);
  });

  it('HONESTY: a pool the indexer never sampled serves honest nulls marked stale', async () => {
    await seedPool();
    const { req, res } = mockReqRes('GET');
    await handler(req, res);
    const s = res.body.pools[0];
    expect(s.price).toBeNull();
    expect(s.change24h).toBeNull();
    expect(s.volume24h).toBeNull();
    expect(s.stale).toBe(true);
  });

  it('serves indexed state without live RPC calls', async () => {
    const p = await seedPool();
    await recordPoolSample(
      p.poolAddress,
      {
        price: 0.002,
        quoteReserve: 200,
        baseReserve: 100000,
        progress: 25,
        graduated: false,
        hasSwap: true,
        marketCap: 2000,
        baseDecimals: 9,
        quoteDecimals: 9,
        migrationQuoteThreshold: 800,
      },
      Date.now(),
    );
    const { req, res } = mockReqRes('GET');
    await handler(req, res);
    const s = res.body.pools[0];
    expect(s.price).toBe(0.002);
    expect(s.progress).toBe(25);
    expect(s.stale).toBe(false);
    // Devnet USD figures are play money: always null.
    expect(s.priceUsd).toBeNull();
    expect(mockGetDbcClient).not.toHaveBeenCalled();
  });

  it('computes 24h change from real tick history', async () => {
    const p = await seedPool();
    const now = Date.now();
    await recordTick(p.poolAddress, now - 25 * 3600_000, 0.001, 100);
    await recordPoolSample(
      p.poolAddress,
      {
        price: 0.002,
        quoteReserve: 200,
        baseReserve: 100000,
        progress: 25,
        graduated: false,
        hasSwap: true,
        marketCap: 2000,
        baseDecimals: 9,
        quoteDecimals: 9,
        migrationQuoteThreshold: 800,
      },
      now,
    );
    const { req, res } = mockReqRes('GET');
    await handler(req, res);
    expect(res.body.pools[0].change24h).toBeCloseTo(100, 6);
  });

  it('rejects non-GET/POST methods', async () => {
    const { req, res } = mockReqRes('PUT');
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});

describe('POST /api/pools', () => {
  it('registers a valid signed pool: 201, verified when the chain agrees', async () => {
    const { body } = signedBody();
    mockMatchingRpc(body);
    const { req, res } = mockReqRes('POST', { body });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.pool.poolAddress).toBe(body.poolAddress);
    const rec = (await getVerification(body.poolAddress as string))!;
    expect(rec.status).toBe('verified');
  });

  it('HONESTY: RPC down -> 201 with the honest unverified label, never a fake pass', async () => {
    const { body } = signedBody();
    mockRpcDown();
    const { req, res } = mockReqRes('POST', { body });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.pool.verified).toBe(false);
    expect((await getVerification(body.poolAddress as string))!.status).toBe('unverified');
  });

  it('rejects an on-chain mismatch: 400 naming the failed verification', async () => {
    const { body } = signedBody();
    mockGetDbcClient.mockReturnValue({
      state: {
        getPool: async () => ({
          poolState: {
            config: new PublicKey(body.configAddress as string),
            creator: new PublicKey(randomAddress()), // attacker-submitted creator
            baseMint: new PublicKey(body.baseMint as string),
          },
        }),
        getPoolConfig: async () => ({ quoteMint: new PublicKey(body.quoteMint as string) }),
      },
    });
    const { req, res } = mockReqRes('POST', { body });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('verification failed');
    expect(res.body.error).toContain('creator');
  });

  it('rejects a malformed body: 400 naming the field', async () => {
    const { req, res } = mockReqRes('POST', { body: { poolAddress: 'bad' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('poolAddress');
  });

  it('rejects a cross-network quote mint: 400', async () => {
    const { body } = signedBody({
      quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // mainnet USDC
    });
    const { req, res } = mockReqRes('POST', { body });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('different network');
  });

  it('rejects an expired timestamp: 400', async () => {
    const creatorKp = Keypair.generate();
    const poolAddress = randomAddress();
    const timestamp = Date.now() - 10 * 60_000;
    const body = {
      ...signedBody().body,
      poolAddress,
      creator: creatorKp.publicKey.toBase58(),
      timestamp,
      signature: signRegistration(poolAddress, creatorKp, timestamp),
    };
    const { req, res } = mockReqRes('POST', { body });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('expired');
  });

  it('rejects a bad wallet signature: 401 (and does not consume the nonce)', async () => {
    const { body, creatorKp } = signedBody();
    const other = Keypair.generate();
    const bad = {
      ...body,
      signature: signRegistration(body.poolAddress as string, other, body.timestamp as number),
    };
    void creatorKp;
    const { req, res } = mockReqRes('POST', { body: bad });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toContain('signature');
  });

  it('rejects a replayed signature: 400', async () => {
    const { body } = signedBody();
    mockMatchingRpc(body);
    const first = mockReqRes('POST', { body });
    await handler(first.req, first.res);
    expect(first.res.statusCode).toBe(201);
    const second = mockReqRes('POST', { body });
    await handler(second.req, second.res);
    expect(second.res.statusCode).toBe(400);
    expect(second.res.body.error).toContain('already used');
  });

  it('rejects a duplicate pool with a fresh signature: 400', async () => {
    const first = signedBody();
    mockMatchingRpc(first.body);
    const r1 = mockReqRes('POST', { body: first.body });
    await handler(r1.req, r1.res);
    expect(r1.res.statusCode).toBe(201);

    // Same pool, brand-new signature: passes replay protection, fails the registry.
    const second = signedBody({ poolAddress: first.body.poolAddress });
    mockMatchingRpc(second.body);
    const r2 = mockReqRes('POST', { body: second.body });
    await handler(r2.req, r2.res);
    expect(r2.res.statusCode).toBe(400);
    expect(r2.res.body.error).toContain('already registered');
  });

  it('rate-limits an IP flood: 30 bad requests admitted, 31st gets 429', async () => {
    for (let i = 0; i < 30; i++) {
      const { req, res } = mockReqRes('POST', { body: { garbage: true } });
      await handler(req, res);
      expect(res.statusCode).toBe(400);
    }
    const { req, res } = mockReqRes('POST', { body: { garbage: true } });
    await handler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toContain('Too many');
  });

  it('rate-limits a wallet flood: 11th registration from one wallet gets 429', async () => {
    mockRpcDown(); // RPC outcome irrelevant; the wallet counter trips first
    const creatorKp = Keypair.generate();
    let last: { statusCode: number; body: { error?: string } } | null = null;
    for (let i = 0; i < 11; i++) {
      const poolAddress = randomAddress();
      const timestamp = Date.now();
      const body = {
        poolAddress,
        configAddress: randomAddress(),
        baseMint: randomAddress(),
        quoteMint: SOL_MINT,
        creator: creatorKp.publicKey.toBase58(),
        baseSymbol: 'T' + i,
        baseName: 'Token ' + i,
        quoteSymbol: 'SOL',
        timestamp,
        signature: signRegistration(poolAddress, creatorKp, timestamp),
      };
      const { req, res } = mockReqRes('POST', { body });
      await handler(req, res);
      last = res;
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.body.error).toContain('wallet');
  }, 30_000);
});
