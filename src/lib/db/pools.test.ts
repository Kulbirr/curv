import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool, getPoolByMint, insertPool, listPools, updatePoolImage } from './pools';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
});
afterEach(async () => { await db.cleanup(); });

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    poolAddress: randomAddress(),
    configAddress: randomAddress(),
    baseMint: randomAddress(),
    quoteMint: randomAddress(),
    creator: randomAddress(),
    baseSymbol: 'TEST',
    baseName: 'Test Token',
    quoteSymbol: 'SOL',
    ...overrides,
  };
}

describe('insertPool', () => {
  it('inserts and normalizes a pool', async () => {
    const entry = await insertPool(validInput({ baseSymbol: ' test ', baseName: '  Test Token  ' }));
    expect(entry.baseSymbol).toBe('TEST');
    expect(entry.baseName).toBe('Test Token');
    expect(entry.verified).toBe(false);
    expect(entry.createdAt).toBeGreaterThan(0);
    const fetched = await getPool(entry.poolAddress);
    expect(fetched?.poolAddress).toBe(entry.poolAddress);
    expect(fetched?.baseMint).toBe(entry.baseMint);
  });

  it('rejects a duplicate poolAddress (transactional check-and-insert)', async () => {
    const input = validInput();
    await insertPool(input);
    await expect(insertPool(validInput({ poolAddress: input.poolAddress }))).rejects.toThrow(
      'Pool is already registered',
    );
    // Still exactly one row: the failed insert left nothing behind.
    expect(await listPools()).toHaveLength(1);
  });

  it('validates every address field', async () => {
    for (const field of ['poolAddress', 'configAddress', 'baseMint', 'quoteMint', 'creator']) {
      await expect(insertPool(validInput({ [field]: 'not-an-address' }))).rejects.toThrow(
        `${field} is not a valid Solana address`,
      );
      await expect(insertPool(validInput({ [field]: '' }))).rejects.toThrow(
        `${field} is required`,
      );
    }
  });

  it('requires symbol and name', async () => {
    await expect(insertPool(validInput({ baseSymbol: '   ' }))).rejects.toThrow(
      'baseSymbol is required',
    );
    await expect(insertPool(validInput({ baseName: '' }))).rejects.toThrow(
      'baseName is required',
    );
  });

  it('rejects non-http image urls', async () => {
    await expect(insertPool(validInput({ imageUrl: 'ftp://evil/x.png' }))).rejects.toThrow(
      'imageUrl must be http(s)',
    );
    const ok = await insertPool(validInput({ imageUrl: 'https://example.com/x.png' }));
    expect(ok.imageUrl).toBe('https://example.com/x.png');
  });

  it('truncates overlong text fields instead of failing', async () => {
    const entry = await insertPool(
      validInput({ baseSymbol: 'averylongsymbolname', description: 'x'.repeat(600) }),
    );
    expect(entry.baseSymbol.length).toBeLessThanOrEqual(12);
    expect(entry.description!.length).toBe(500);
  });

  it('stores the verified flag only when explicitly true', async () => {
    const v = await insertPool(validInput({ verified: true }));
    expect((await getPool(v.poolAddress))?.verified).toBe(true);
    const u = await insertPool(validInput({ verified: false }));
    expect((await getPool(u.poolAddress))?.verified).toBe(false);
  });
});

describe('getPool / listPools', () => {
  it('returns null for unknown or malformed addresses', async () => {
    expect(await getPool(randomAddress())).toBeNull();
    expect(await getPool('garbage')).toBeNull();
  });

  it('lists newest first', async () => {
    const a = await insertPool(validInput({ createdAt: 1000 }));
    const b = await insertPool(validInput({ createdAt: 2000 }));
    const list = await listPools();
    expect(list.map((p) => p.poolAddress)).toEqual([b.poolAddress, a.poolAddress]);
  });

  it('maps null optionals to undefined', async () => {
    const e = await insertPool(validInput());
    const f = (await getPool(e.poolAddress))!;
    expect(f.description).toBeUndefined();
    expect(f.launchedAt).toBeUndefined();
  });
});

describe('getPoolByMint', () => {
  it('finds the pool by its base token mint', async () => {
    const e = await insertPool(validInput());
    const found = await getPoolByMint(e.baseMint);
    expect(found?.poolAddress).toBe(e.poolAddress);
  });

  it('returns null for unknown or malformed mints', async () => {
    expect(await getPoolByMint(randomAddress())).toBeNull();
    expect(await getPoolByMint('garbage')).toBeNull();
  });
});

describe('updatePoolImage', () => {
  it('fills a missing image and returns true', async () => {
    const e = await insertPool(validInput());
    expect((await getPool(e.poolAddress))?.imageUrl).toBeUndefined();
    const ok = await updatePoolImage(e.poolAddress, 'https://example.com/img.png');
    expect(ok).toBe(true);
    expect((await getPool(e.poolAddress))?.imageUrl).toBe('https://example.com/img.png');
  });

  it('does not overwrite an existing image', async () => {
    const e = await insertPool(validInput({ imageUrl: 'https://example.com/old.png' }));
    const ok = await updatePoolImage(e.poolAddress, 'https://example.com/new.png');
    expect(ok).toBe(false);
    expect((await getPool(e.poolAddress))?.imageUrl).toBe('https://example.com/old.png');
  });

  it('rejects non-https URLs', async () => {
    const e = await insertPool(validInput());
    await expect(updatePoolImage(e.poolAddress, 'http://example.com/img.png')).rejects.toThrow();
    await expect(updatePoolImage(e.poolAddress, 'not-a-url')).rejects.toThrow();
  });
});
