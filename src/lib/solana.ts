import { Cluster, Connection, clusterApiUrl } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

export type SolanaNetwork = 'devnet' | 'mainnet-beta';

function resolveNetwork(): SolanaNetwork {
  const raw = (process.env.NEXT_PUBLIC_SOLANA_NETWORK || 'devnet').toLowerCase();
  return raw === 'mainnet-beta' || raw === 'mainnet' ? 'mainnet-beta' : 'devnet';
}

export const SOLANA_NETWORK: SolanaNetwork = resolveNetwork();

function resolvePrimaryRpcUrl(): string {
  // Server: private RPC (may carry an API key) stays server-side.
  if (typeof window === 'undefined') {
    if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
    if (process.env.RPC_URL) return process.env.RPC_URL;
  } else {
    // Client: a keyed RPC URL must never ship in the browser bundle (any
    // visitor could copy it). Browser chain reads go through the same-origin
    // /api/rpc proxy, which forwards from the server's keyed lane.
    return '/api/rpc';
  }
  return clusterApiUrl(SOLANA_NETWORK);
}

export const SOLANA_RPC_URL = resolvePrimaryRpcUrl();

/** Public fallback endpoint, always keyless. Used when the primary RPC fails. */
export const SOLANA_RPC_FALLBACK_URL = clusterApiUrl(SOLANA_NETWORK);

let connectionSingleton: Connection | null = null;
let dbcClientSingleton: DynamicBondingCurveClient | null = null;

/** Per-RPC-call budget. When it fires the socket is destroyed, never leaked. */
export const RPC_TIMEOUT_MS = 8_000;

/** Last time a call fell back to the public endpoint (null = never). */
let lastFallbackAt: number | null = null;

/** For the health endpoint: which RPC tier is serving and fallback history. */
export function getRpcStatus(): {
  primary: string;
  fallback: string;
  primaryIsPublic: boolean;
  lastFallbackAt: number | null;
} {
  return {
    primary: describeEndpoint(SOLANA_RPC_URL),
    fallback: describeEndpoint(SOLANA_RPC_FALLBACK_URL),
    primaryIsPublic: SOLANA_RPC_URL === SOLANA_RPC_FALLBACK_URL,
    lastFallbackAt,
  };
}

/** Redacts any API key from an endpoint for safe logging / status output. */
function describeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return 'unparseable-endpoint';
  }
}

async function attemptFetch(
  endpoint: string,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  ms: number,
): Promise<Response> {
  const target =
    typeof input === 'string' && input.startsWith(SOLANA_RPC_URL)
      ? endpoint + input.slice(SOLANA_RPC_URL.length)
      : input;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('RPC request timed out')), ms);
  try {
    return await fetch(target, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch wrapper with per-call budget AND primary/fallback routing.
 * Tries the primary RPC (Helius when configured); on network failure,
 * timeout, HTTP 429 or 5xx it retries once against the public fallback
 * endpoint. Solana RPC errors ride inside HTTP 200 bodies, so only
 * transport-level failures trigger the fallback, a valid RPC error
 * response is returned as-is.
 * A dead RPC endpoint must fail fast; a hung request that only rejects at
 * the application level would leak the socket and degrade every later call.
 */
function fetchWithFallback(ms: number): typeof fetch {
  const singleTier = SOLANA_RPC_URL === SOLANA_RPC_FALLBACK_URL;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try {
      const res = await attemptFetch(SOLANA_RPC_URL, input, init, ms);
      if (!singleTier && (res.status === 429 || res.status >= 500)) {
        try {
          const fb = await attemptFetch(SOLANA_RPC_FALLBACK_URL, input, init, ms);
          lastFallbackAt = Date.now();
          return fb;
        } catch {
          return res;
        }
      }
      return res;
    } catch {
      if (singleTier) throw new Error('RPC request failed');
      lastFallbackAt = Date.now();
      return attemptFetch(SOLANA_RPC_FALLBACK_URL, input, init, ms);
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
      fetch: fetchWithFallback(RPC_TIMEOUT_MS),
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
