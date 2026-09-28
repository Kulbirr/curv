import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { getDbcClient } from '@/lib/solana';
import { verifyAndRecord, verifyPoolRegistration } from './pool-verification';
import { getVerification } from './db/verifications';
import { randomAddress, useTempDb } from '@/test-support/db';

// Mock only the DBC client factory; everything else in solana.ts stays real.
vi.mock('@/lib/solana', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/solana')>();
  return { ...actual, getDbcClient: vi.fn() };
});

const mockGetDbcClient = getDbcClient as unknown as ReturnType<typeof vi.fn>;

function fields() {
  return {
    poolAddress: randomAddress(),
    configAddress: randomAddress(),
    baseMint: randomAddress(),
    quoteMint: randomAddress(),
    creator: randomAddress(),
  };
}

function matchingPool(f: ReturnType<typeof fields>) {
  return {
    poolState: {
      config: new PublicKey(f.configAddress),
      creator: new PublicKey(f.creator),
      baseMint: new PublicKey(f.baseMint),
    },
  };
}

function matchingConfig(f: ReturnType<typeof fields>) {
  return { quoteMint: new PublicKey(f.quoteMint) };
}

function mockClient(pool: unknown, config: unknown) {
  mockGetDbcClient.mockReturnValue({
    state: {
      getPool: vi.fn().mockResolvedValue(pool),
      getPoolConfig: vi.fn().mockResolvedValue(config),
    },
  });
}

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
  vi.clearAllMocks();
});
afterEach(async () => { await db.cleanup(); });

describe('verifyPoolRegistration', () => {
  it('verifies when every submitted field matches the on-chain accounts', async () => {
    const f = fields();
    mockClient(matchingPool(f), matchingConfig(f));
    const out = await verifyPoolRegistration(f);
    expect(out.status).toBe('verified');
    expect(out.detail).toContain('match');
  });

  it('handles the unwrapped pool account shape too', async () => {
    const f = fields();
    mockClient(
      {
        config: new PublicKey(f.configAddress),
        creator: new PublicKey(f.creator),
        baseMint: new PublicKey(f.baseMint),
      },
      matchingConfig(f),
    );
    expect((await verifyPoolRegistration(f)).status).toBe('verified');
  });

  it('accepts raw base58 strings from the account (Anchor shape variance)', async () => {
    const f = fields();
    mockClient(
      {
        poolState: {
          config: f.configAddress,
          creator: f.creator,
          baseMint: f.baseMint,
        },
      },
      { quoteMint: f.quoteMint },
    );
    expect((await verifyPoolRegistration(f)).status).toBe('verified');
  });

  it.each(['config', 'creator', 'baseMint'] as const)(
    'rejects and names a mismatched %s',
    async (field) => {
      const f = fields();
      const pool = matchingPool(f);
      (pool.poolState as Record<string, unknown>)[field] = new PublicKey(randomAddress());
      mockClient(pool, matchingConfig(f));
      const out = await verifyPoolRegistration(f);
      expect(out.status).toBe('rejected');
      expect(out.detail).toContain(field);
    },
  );

  it('rejects and names a mismatched quoteMint', async () => {
    const f = fields();
    mockClient(matchingPool(f), { quoteMint: new PublicKey(randomAddress()) });
    const out = await verifyPoolRegistration(f);
    expect(out.status).toBe('rejected');
    expect(out.detail).toContain('quoteMint');
  });

  it('names every mismatched field at once', async () => {
    const f = fields();
    mockClient(
      {
        poolState: {
          config: new PublicKey(randomAddress()),
          creator: new PublicKey(randomAddress()),
          baseMint: new PublicKey(randomAddress()),
        },
      },
      { quoteMint: new PublicKey(randomAddress()) },
    );
    const out = await verifyPoolRegistration(f);
    expect(out.status).toBe('rejected');
    for (const name of ['config', 'creator', 'baseMint', 'quoteMint']) {
      expect(out.detail).toContain(name);
    }
  });

  it('HONESTY: RPC failure is inconclusive -> unverified, never a pass', async () => {
    const f = fields();
    mockGetDbcClient.mockReturnValue({
      state: {
        getPool: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')),
        getPoolConfig: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')),
      },
    });
    const out = await verifyPoolRegistration(f);
    expect(out.status).toBe('unverified');
    expect(out.detail).toContain('RPC unreachable');
  });

  it('HONESTY: pool account not visible yet -> unverified (RPC lag), not rejected', async () => {
    const f = fields();
    mockClient(null, matchingConfig(f));
    const out = await verifyPoolRegistration(f);
    expect(out.status).toBe('unverified');
    expect(out.detail).toContain('not found');
  });

  it('HONESTY: config account not visible yet -> unverified, not rejected', async () => {
    const f = fields();
    mockClient(matchingPool(f), null);
    const out = await verifyPoolRegistration(f);
    expect(out.status).toBe('unverified');
  });
});

describe('verifyAndRecord', () => {
  it('persists a verified outcome', async () => {
    const f = fields();
    mockClient(matchingPool(f), matchingConfig(f));
    const out = await verifyAndRecord(f);
    expect(out.status).toBe('verified');
    const rec = (await getVerification(f.poolAddress))!;
    expect(rec.status).toBe('verified');
    expect(rec.checkedAt).toBeGreaterThan(0);
  });

  it('records rejections as unverified with the reason in the detail', async () => {
    const f = fields();
    mockClient(matchingPool(f), { quoteMint: new PublicKey(randomAddress()) });
    const out = await verifyAndRecord(f);
    expect(out.status).toBe('rejected');
    const rec = (await getVerification(f.poolAddress))!;
    expect(rec.status).toBe('unverified');
    expect(rec.detail).toContain('rejected:');
    expect(rec.detail).toContain('quoteMint');
  });

  it('records RPC outages as unverified', async () => {
    const f = fields();
    mockGetDbcClient.mockImplementation(() => {
      throw new Error('network down');
    });
    const out = await verifyAndRecord(f);
    expect(out.status).toBe('unverified');
    expect((await getVerification(f.poolAddress))!.status).toBe('unverified');
  });
});
