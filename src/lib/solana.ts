import { Cluster, Connection, clusterApiUrl } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

export type SolanaNetwork = 'devnet' | 'mainnet-beta';

function resolveNetwork(): SolanaNetwork {
  const raw = (process.env.NEXT_PUBLIC_SOLANA_NETWORK || 'devnet').toLowerCase();
  return raw === 'mainnet-beta' || raw === 'mainnet' ? 'mainnet-beta' : 'devnet';
}

export const SOLANA_NETWORK: SolanaNetwork = resolveNetwork();

function resolveRpcUrl(): string {
  // Server: private RPC (may carry an API key) stays server-side.
  if (typeof window === 'undefined') {
    if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
    if (process.env.RPC_URL) return process.env.RPC_URL;
  } else {
    // Client: only a public, keyless endpoint may be exposed here.
    if (process.env.NEXT_PUBLIC_SOLANA_RPC_URL) return process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  }
  return clusterApiUrl(SOLANA_NETWORK);
}

export const SOLANA_RPC_URL = resolveRpcUrl();

let connectionSingleton: Connection | null = null;
let dbcClientSingleton: DynamicBondingCurveClient | null = null;

/** Per-RPC-call budget. When it fires the socket is destroyed, never leaked. */
export const RPC_TIMEOUT_MS = 8_000;

/**
 * fetch wrapper that aborts the request (and its socket) after `ms`.
 * A dead RPC endpoint must fail fast; a hung request that only rejects at
 * the application level would leak the socket and degrade every later call.
 */
function fetchWithBudget(ms: number): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('RPC request timed out')), ms);
    try {
      return await fetch(input, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

/**
 * Shared RPC connection. Always REST-based: no websocket subscriptions,
 * because websocket transports are unreliable in several deployment
 * environments (and confirmed broken in our sandbox).
 */
export function getConnection(): Connection {
  if (!connectionSingleton) {
    connectionSingleton = new Connection(SOLANA_RPC_URL, {
      commitment: 'confirmed',
      fetch: fetchWithBudget(RPC_TIMEOUT_MS),
    });
  }
  return connectionSingleton;
}

export function getDbcClient(): DynamicBondingCurveClient {
  if (!dbcClientSingleton) {
    dbcClientSingleton = new DynamicBondingCurveClient(getConnection(), 'confirmed');
  }
  return dbcClientSingleton;
}

/** True while we are pointed at devnet (prices are play money, no USD conversion). */
export function isDevnet(): boolean {
  return SOLANA_NETWORK === 'devnet';
}
