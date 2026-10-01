import { PublicKey, type Connection } from '@solana/web3.js';
import { scanDammV2Pool } from './liquidity-lock';

/**
 * Post-graduation market data from the Meteora DAMM v2 (cp-amm) pool.
 *
 * When a bonding-curve pool graduates, its liquidity migrates to a DAMM v2
 * pool and the DBC curve stops moving. The indexer keeps price and history
 * live by reading the DAMM v2 pool instead:
 *
 *   1. The DAMM v2 pool is found by scanning cp-amm Pool accounts for the
 *      mint pair (see scanDammV2Pool in liquidity-lock.ts). Pure PDA
 *      derivation is not used: the SDK helper does not reproduce the
 *      on-chain migration address.
 *   2. The pool account's token vaults are read and their balances become
 *      the reserves. Migrated pools are full-range constant-product pools,
 *      so the spot price is the reserve ratio, the same quote-per-base
 *      convention the DBC reader uses.
 *
 * Byte offsets below are verified against the real devnet migration
 * (DAMM v2 pool 9Rt6KW2SY3c431mvMYAur9HnXdRiofzosLrQWGBc4qA5):
 *   tokenAMint @168, tokenBMint @200 (as in liquidity-lock.ts),
 *   tokenAVault @232 holds the base mint, tokenBVault @264 the quote mint.
 * Token A is NOT assumed to be the base token: the vaults are mapped to
 * base/quote by comparing mints, so either token order works.
 */

export const OFF_DAMM_POOL_TOKEN_A_VAULT = 232;
export const OFF_DAMM_POOL_TOKEN_B_VAULT = 264;
export const DAMM_POOL_MIN_DATA_LEN = 296;

export interface DammV2VaultMap {
  poolAddress: string;
  /** Vault holding the base mint. */
  baseVault: string;
  /** Vault holding the quote mint. */
  quoteVault: string;
}

export interface DammV2MarketSnapshot {
  /** Quote tokens per 1 base token, in UI units. Null when unreadable. */
  price: number | null;
  /** Quote reserve in UI units. */
  quoteReserve: number | null;
  /** Base reserve in UI units. */
  baseReserve: number | null;
}

/**
 * Decode the vault mapping from a raw cp-amm Pool account. Returns null
 * when the data is too short or the mint pair does not match (in either
 * order). Pure function, no RPC.
 */
export function decodeDammV2Vaults(
  poolAddress: string,
  data: Uint8Array,
  baseMint: string,
  quoteMint: string
): DammV2VaultMap | null {
  if (data.length < DAMM_POOL_MIN_DATA_LEN) return null;
  const mintAt = (offset: number) =>
    new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  // Offsets shared with liquidity-lock.ts (OFF_POOL_TOKEN_A_MINT = 168,
  // OFF_POOL_TOKEN_B_MINT = 200).
  const tokenAMint = mintAt(168);
  const tokenBMint = mintAt(200);
  const vaultAt = (offset: number) =>
    new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  const tokenAVault = vaultAt(OFF_DAMM_POOL_TOKEN_A_VAULT);
  const tokenBVault = vaultAt(OFF_DAMM_POOL_TOKEN_B_VAULT);
  if (tokenAMint === baseMint && tokenBMint === quoteMint) {
    return { poolAddress, baseVault: tokenAVault, quoteVault: tokenBVault };
  }
  if (tokenAMint === quoteMint && tokenBMint === baseMint) {
    return { poolAddress, baseVault: tokenBVault, quoteVault: tokenAVault };
  }
  return null;
}

/**
 * Spot price from vault balances: quote UI units per 1 base UI unit.
 * Null when the base side is missing, zero, or the result is not finite.
 * Pure function, no RPC.
 */
export function dammV2PriceFromReserves(
  baseUi: number | null | undefined,
  quoteUi: number | null | undefined
): number | null {
  if (typeof baseUi !== 'number' || typeof quoteUi !== 'number') return null;
  if (!Number.isFinite(baseUi) || !Number.isFinite(quoteUi)) return null;
  if (baseUi <= 0 || quoteUi < 0) return null;
  const price = quoteUi / baseUi;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Discovered DAMM v2 pool per DBC pool address. The scan is two
 * getProgramAccounts calls, so it runs at most once per graduated pool
 * per process lifetime. Misses are not cached: a pool that is mid
 * migration is retried on the next sample pass.
 */
const dammPoolCache = new Map<string, string>();

export function clearDammPoolCache(): void {
  dammPoolCache.clear();
}

async function resolveDammV2Pool(
  connection: Connection,
  dbcPoolAddress: string,
  baseMint: string,
  quoteMint: string
): Promise<string | null> {
  const cached = dammPoolCache.get(dbcPoolAddress);
  if (cached) return cached;
  const found = await scanDammV2Pool(connection, baseMint, quoteMint);
  if (found) dammPoolCache.set(dbcPoolAddress, found);
  return found;
}

async function vaultUiAmount(
  connection: Connection,
  vault: string
): Promise<number | null> {
  const res = await connection.getTokenAccountBalance(new PublicKey(vault));
  const ui = res?.value?.uiAmount;
  return typeof ui === 'number' && Number.isFinite(ui) ? ui : null;
}

/**
 * Read the live market snapshot for a graduated pool from its DAMM v2
 * pool. Returns null on any failure (pool not found yet, RPC error,
 * undecodable account) so the caller can serve the last good sample
 * as stale instead of a fabricated number.
 */
export async function fetchDammV2MarketSnapshot(
  connection: Connection,
  dbcPoolAddress: string,
  baseMint: string,
  quoteMint: string
): Promise<DammV2MarketSnapshot | null> {
  const failed: DammV2MarketSnapshot = {
    price: null,
    quoteReserve: null,
    baseReserve: null,
  };
  try {
    const dammV2Pool = await resolveDammV2Pool(
      connection,
      dbcPoolAddress,
      baseMint,
      quoteMint
    );
    if (!dammV2Pool) return failed;
    const info = await connection.getAccountInfo(new PublicKey(dammV2Pool));
    const data = info?.data;
    if (!data || data.length < DAMM_POOL_MIN_DATA_LEN) return failed;
    const vaults = decodeDammV2Vaults(
      dammV2Pool,
      data,
      baseMint,
      quoteMint
    );
    if (!vaults) return failed;
    const [baseUi, quoteUi] = await Promise.all([
      vaultUiAmount(connection, vaults.baseVault),
      vaultUiAmount(connection, vaults.quoteVault),
    ]);
    return {
      price: dammV2PriceFromReserves(baseUi, quoteUi),
      quoteReserve: quoteUi,
      baseReserve: baseUi,
    };
  } catch {
    return failed;
  }
}
