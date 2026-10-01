import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey, type Connection } from '@solana/web3.js';
import {
  clearDammPoolCache,
  dammV2PriceFromReserves,
  decodeDammV2Vaults,
  fetchDammV2MarketSnapshot,
  DAMM_POOL_MIN_DATA_LEN,
} from './damm-v2-state';
import { scanDammV2Pool } from './liquidity-lock';

vi.mock('./liquidity-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./liquidity-lock')>();
  return { ...actual, scanDammV2Pool: vi.fn() };
});

const mockScan = scanDammV2Pool as unknown as ReturnType<typeof vi.fn>;

/**
 * Real devnet migration, observed on chain and used here as the
 * reference fixture (read-only values, no network in tests):
 *   DAMM v2 pool 9Rt6KW2SY3c431mvMYAur9HnXdRiofzosLrQWGBc4qA5
 *   base  BZGKUxxj9apfnytAfihucw5cSXrhR1T5dPvF8BePb4dF (token A)
 *   quote ExDuXdVxERLuA9PnTP4h8WE7BcxhdSakupi4dk6d7H8M (token B)
 *   vaultA 2EyFA3BG4JDqQKW84sCj8dFDRPs9Ez7cFCHpDH9Kn2Vp holds the base mint
 *   vaultB FtDRVDbx4SU2fbNsBw6qsEk2a99DmGGPNStY1dfKegeM holds the quote mint
 *   vaultA raw 224913853773847, vaultB raw 4590800, both mints 6 decimals.
 */
const DAMM_POOL = '9Rt6KW2SY3c431mvMYAur9HnXdRiofzosLrQWGBc4qA5';
const BASE_MINT = 'BZGKUxxj9apfnytAfihucw5cSXrhR1T5dPvF8BePb4dF';
const QUOTE_MINT = 'ExDuXdVxERLuA9PnTP4h8WE7BcxhdSakupi4dk6d7H8M';
const VAULT_A = '2EyFA3BG4JDqQKW84sCj8dFDRPs9Ez7cFCHpDH9Kn2Vp';
const VAULT_B = 'FtDRVDbx4SU2fbNsBw6qsEk2a99DmGGPNStY1dfKegeM';
const BASE_UI = 224913853.773847;
const QUOTE_UI = 4.5908;

/** Synthetic cp-amm Pool account with mints/vaults at the real offsets. */
function poolBuffer(
  mintA: string,
  mintB: string,
  vaultA: string,
  vaultB: string
): Buffer {
  const buf = Buffer.alloc(DAMM_POOL_MIN_DATA_LEN);
  const put = (addr: string, offset: number) =>
    Buffer.from(new PublicKey(addr).toBytes()).copy(buf, offset);
  put(mintA, 168);
  put(mintB, 200);
  put(vaultA, 232);
  put(vaultB, 264);
  return buf;
}

function fakeConnection(poolData: Buffer | null): Connection {
  return {
    getAccountInfo: vi.fn().mockResolvedValue(
      poolData ? { data: poolData } : null
    ),
    getTokenAccountBalance: vi.fn().mockImplementation((pk: PublicKey) => {
      const a = pk.toBase58();
      if (a === VAULT_A) return Promise.resolve({ value: { uiAmount: BASE_UI } });
      if (a === VAULT_B) return Promise.resolve({ value: { uiAmount: QUOTE_UI } });
      return Promise.resolve({ value: { uiAmount: null } });
    }),
  } as unknown as Connection;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearDammPoolCache();
});

describe('decodeDammV2Vaults', () => {
  it('maps vaults to base and quote in normal token order', () => {
    const v = decodeDammV2Vaults(
      DAMM_POOL,
      poolBuffer(BASE_MINT, QUOTE_MINT, VAULT_A, VAULT_B),
      BASE_MINT,
      QUOTE_MINT
    );
    expect(v).not.toBeNull();
    expect(v!.poolAddress).toBe(DAMM_POOL);
    expect(v!.baseVault).toBe(VAULT_A);
    expect(v!.quoteVault).toBe(VAULT_B);
  });

  it('swaps the mapping when token A is the quote mint', () => {
    const v = decodeDammV2Vaults(
      DAMM_POOL,
      poolBuffer(QUOTE_MINT, BASE_MINT, VAULT_A, VAULT_B),
      BASE_MINT,
      QUOTE_MINT
    );
    expect(v).not.toBeNull();
    expect(v!.baseVault).toBe(VAULT_B);
    expect(v!.quoteVault).toBe(VAULT_A);
  });

  it('returns null for short data', () => {
    expect(
      decodeDammV2Vaults(DAMM_POOL, Buffer.alloc(100), BASE_MINT, QUOTE_MINT)
    ).toBeNull();
  });

  it('returns null when the mint pair does not match', () => {
    const other = new PublicKey(Buffer.alloc(32).fill(7)).toBase58();
    const v = decodeDammV2Vaults(
      DAMM_POOL,
      poolBuffer(BASE_MINT, other, VAULT_A, VAULT_B),
      BASE_MINT,
      QUOTE_MINT
    );
    expect(v).toBeNull();
  });
});

describe('dammV2PriceFromReserves', () => {
  it('derives quote per base from the real devnet vault balances', () => {
    // 4.5908 / 224913853.773847, matches the frozen DBC sqrtPrice to 6dp.
    expect(dammV2PriceFromReserves(BASE_UI, QUOTE_UI)).toBeCloseTo(
      2.041137050017422e-8,
      14
    );
  });

  it('returns null for missing, zero, or negative reserves', () => {
    expect(dammV2PriceFromReserves(0, QUOTE_UI)).toBeNull();
    expect(dammV2PriceFromReserves(null, QUOTE_UI)).toBeNull();
    expect(dammV2PriceFromReserves(BASE_UI, null)).toBeNull();
    expect(dammV2PriceFromReserves(-1, QUOTE_UI)).toBeNull();
    expect(dammV2PriceFromReserves(NaN, QUOTE_UI)).toBeNull();
  });
});

describe('fetchDammV2MarketSnapshot', () => {
  it('reads price and reserves from the vaults', async () => {
    mockScan.mockResolvedValue(DAMM_POOL);
    const s = await fetchDammV2MarketSnapshot(
      fakeConnection(poolBuffer(BASE_MINT, QUOTE_MINT, VAULT_A, VAULT_B)),
      'dbc-pool-address',
      BASE_MINT,
      QUOTE_MINT
    );
    expect(s.price).toBeCloseTo(2.041137050017422e-8, 14);
    expect(s.quoteReserve).toBeCloseTo(QUOTE_UI, 6);
    expect(s.baseReserve).toBeCloseTo(BASE_UI, 3);
  });

  it('HONESTY: scan miss yields nulls, never invented numbers', async () => {
    mockScan.mockResolvedValue(null);
    const s = await fetchDammV2MarketSnapshot(
      fakeConnection(poolBuffer(BASE_MINT, QUOTE_MINT, VAULT_A, VAULT_B)),
      'dbc-pool-address',
      BASE_MINT,
      QUOTE_MINT
    );
    expect(s.price).toBeNull();
    expect(s.quoteReserve).toBeNull();
    expect(s.baseReserve).toBeNull();
  });

  it('HONESTY: undecodable pool account yields nulls', async () => {
    mockScan.mockResolvedValue(DAMM_POOL);
    const s = await fetchDammV2MarketSnapshot(
      fakeConnection(null),
      'dbc-pool-address',
      BASE_MINT,
      QUOTE_MINT
    );
    expect(s.price).toBeNull();
  });

  it('HONESTY: unreadable vault balance yields null price', async () => {
    mockScan.mockResolvedValue(DAMM_POOL);
    const conn = {
      getAccountInfo: vi
        .fn()
        .mockResolvedValue({ data: poolBuffer(BASE_MINT, QUOTE_MINT, VAULT_A, VAULT_B) }),
      getTokenAccountBalance: vi
        .fn()
        .mockResolvedValue({ value: { uiAmount: null } }),
    } as unknown as Connection;
    const s = await fetchDammV2MarketSnapshot(
      conn,
      'dbc-pool-address',
      BASE_MINT,
      QUOTE_MINT
    );
    expect(s.price).toBeNull();
  });

  it('caches the discovered pool so the scan runs once per process', async () => {
    mockScan.mockResolvedValue(DAMM_POOL);
    const conn = fakeConnection(
      poolBuffer(BASE_MINT, QUOTE_MINT, VAULT_A, VAULT_B)
    );
    await fetchDammV2MarketSnapshot(conn, 'dbc-pool', BASE_MINT, QUOTE_MINT);
    await fetchDammV2MarketSnapshot(conn, 'dbc-pool', BASE_MINT, QUOTE_MINT);
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it('does not cache a scan miss, so a mid-migration pool is retried', async () => {
    mockScan.mockResolvedValue(null);
    const conn = fakeConnection(
      poolBuffer(BASE_MINT, QUOTE_MINT, VAULT_A, VAULT_B)
    );
    await fetchDammV2MarketSnapshot(conn, 'dbc-pool', BASE_MINT, QUOTE_MINT);
    await fetchDammV2MarketSnapshot(conn, 'dbc-pool', BASE_MINT, QUOTE_MINT);
    expect(mockScan).toHaveBeenCalledTimes(2);
  });
});
