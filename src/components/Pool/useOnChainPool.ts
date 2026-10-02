import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { getConnection, getDbcClient } from '@/lib/solana';

/**
 * On-chain pool + config accounts, read directly via the DBC SDK.
 * Used by the trade panel (quoting, swaps) and the details section
 * (config address, mints). Refreshed every 30s; trading always re-reads
 * fresh state at execution time.
 */
export interface OnChainPool {
  poolAddress: string;
  /** The raw VirtualPool account (has nested poolState struct). */
  virtualPool: unknown;
  /** The raw PoolConfig account. */
  config: unknown;
  configAddress: string;
  baseMint: string;
  quoteMint: string;
}

export async function fetchOnChainPool(poolAddress: string): Promise<OnChainPool> {
  const client = getDbcClient();
  const poolPubkey = new PublicKey(poolAddress);
  const virtualPool = await client.state.getPool(poolPubkey);
  if (!virtualPool) throw new Error('Pool account not found on-chain');

  const ps = (virtualPool as { poolState?: Record<string, unknown> }).poolState;
  if (!ps || typeof ps !== 'object') throw new Error('Malformed pool account');

  const configAddress = (ps['config'] as { toBase58?: () => string })?.toBase58?.();
  const baseMint = (ps['baseMint'] as { toBase58?: () => string })?.toBase58?.();
  if (!configAddress || !baseMint) throw new Error('Malformed pool account');

  const config = await client.state.getPoolConfig(new PublicKey(configAddress));
  if (!config) throw new Error('Pool config not found on-chain');
  const quoteMint = (config as { quoteMint?: { toBase58?: () => string } }).quoteMint?.toBase58?.();
  if (!quoteMint) throw new Error('Malformed pool config');

  return { poolAddress, virtualPool, config, configAddress, baseMint, quoteMint };
}

export function useOnChainPool(poolAddress: string | null) {
  return useQuery<OnChainPool>({
    queryKey: ['pool-onchain', poolAddress],
    queryFn: () => fetchOnChainPool(poolAddress as string),
    enabled: !!poolAddress,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: 1,
    staleTime: 20000,
  });
}

/** Mint decimals with an in-memory cache (decimals are immutable). */
const decimalsCache = new Map<string, number>();

export async function getMintDecimalsCached(mint: string): Promise<number> {
  const hit = decimalsCache.get(mint);
  if (hit !== undefined) return hit;
  const { getTokenDecimals } = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  const d = await getTokenDecimals(getConnection(), new PublicKey(mint));
  decimalsCache.set(mint, d);
  return d;
}
