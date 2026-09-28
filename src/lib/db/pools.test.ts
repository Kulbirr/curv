import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool, insertPool, listPools } from './pools';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: ReturnType<typeof useTempDb>;
beforeEach(() => {
  db = useTempDb();
});
afterEach(() => db.cleanup());

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
  it('inserts and normalizes a pool', () => {
    const entry = insertPool(validInput({ baseSymbol: ' test ', baseName: '  Test Token  ' }));
    expect(entry.baseSymbol).toBe('TEST');
    expect(entry.baseName).toBe('Test Token');
    expect(entry.verified).toBe(false);
    expect(entry.createdAt).toBeGreaterThan(0);
    const fetched = getPool(entry.poolAddress);
    expect(fetched?.poolAddress).toBe(entry.poolAddress);
    expect(fetched?.baseMint).toBe(entry.baseMint);
  });

  it('rejects a duplicate poolAddress (transactional check-and-insert)', () => {
    const input = validInput();
    insertPool(input);
    expect(() => insertPool(validInput({ poolAddress: input.poolAddress }))).toThrow(
      'Pool is already registered',
    );
    // Still exactly one row: the failed insert left nothing behind.
    expect(listPools()).toHaveLength(1);
  });

  it('validates every address field', () => {
    for (const field of ['poolAddress', 'configAddress', 'baseMint', 'quoteMint', 'creator']) {
      expect(() => insertPool(validInput({ [field]: 'not-an-address' }))).toThrow(
        `${field} is not a valid Solana address`,
      );
      expect(() => insertPool(validInput({ [field]: '' }))).toThrow(`${field} is required`);
    }
  });

  it('requires symbol and name', () => {
    expect(() => insertPool(validInput({ baseSymbol: '   ' }))).toThrow('baseSymbol is required');
    expect(() => insertPool(validInput({ baseName: '' }))).toThrow('baseName is required');
  });

  it('rejects non-http image urls', () => {
    expect(() => insertPool(validInput({ imageUrl: 'ftp://evil/x.png' }))).toThrow(
      'imageUrl must be http(s)',
    );
    const ok = insertPool(validInput({ imageUrl: 'https://example.com/x.png' }));
    expect(ok.imageUrl).toBe('https://example.com/x.png');
  });

  it('truncates overlong text fields instead of failing', () => {
    const entry = insertPool(
      validInput({ baseSymbol: 'averylongsymbolname', description: 'x'.repeat(600) }),
    );
    expect(entry.baseSymbol.length).toBeLessThanOrEqual(12);
    expect(entry.description!.length).toBe(500);
  });

  it('stores the verified flag only when explicitly true', () => {
    const v = insertPool(validInput({ verified: true }));
    expect(getPool(v.poolAddress)?.verified).toBe(true);
    const u = insertPool(validInput({ verified: false }));
    expect(getPool(u.poolAddress)?.verified).toBe(false);
  });
});

describe('getPool / listPools', () => {
  it('returns null for unknown or malformed addresses', () => {
    expect(getPool(randomAddress())).toBeNull();
    expect(getPool('garbage')).toBeNull();
  });

  it('lists newest first', () => {
    const a = insertPool(validInput({ createdAt: 1000 }));
    const b = insertPool(validInput({ createdAt: 2000 }));
    const list = listPools();
    expect(list.map((p) => p.poolAddress)).toEqual([b.poolAddress, a.poolAddress]);
  });

  it('maps null optionals to undefined', () => {
    const e = insertPool(validInput());
    const f = getPool(e.poolAddress)!;
    expect(f.description).toBeUndefined();
    expect(f.launchedAt).toBeUndefined();
  });
});
