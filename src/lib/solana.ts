import { Cluster, Connection, clusterApiUrl } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { createFailoverFetch, type RpcLane } from './rpc-failover';

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
    // Must be absolute: @solana/web3.js rejects relative endpoint URLs
    // ("Endpoint URL must start with `http:` or `https:`").
    return `${window.location.origin}/api/rpc`;
  }
  return clusterApiUrl(SOLANA_NETWORK);
}

export const SOLANA_RPC_URL = resolvePrimaryRpcUrl();

function resolveAlchemyRpcUrl(): string {
  // Server: Alchemy is the second keyed lane. A keyed URL must never ship
  // in the browser bundle (any visitor could copy the key); browser chain
  // reads go through the same-origin /api/rpc proxy instead.
  if (typeof window === 'undefined') {
    return process.env.ALCHEMY_RPC_URL || '';
  }
  return '';
}

/**
 * Second keyed lane (Alchemy). Empty string when unset or in the browser.
 * Set ALCHEMY_RPC_URL in the server environment (Vercel): the full Alchemy
 * HTTPS URL including the API key, e.g.
 * https://solana-devnet.g.alchemy.com/v2/<api-key> (devnet now; swap to the
 * mainnet URL at launch — one setting flips networks).
 */
export const ALCHEMY_RPC_URL = resolveAlchemyRpcUrl();

/** Public fallback endpoint, always keyless. Used when the keyed lanes fail. */
export const SOLANA_RPC_FALLBACK_URL = clusterApiUrl(SOLANA_NETWORK);

/** RPC tier names, in failover order. */
export type RpcTier = 'primary' | 'alchemy' | 'public';

/**
 * Ordered failover tiers: Helius primary, Alchemy secondary, public last.
 * Deduped, so a single-tier config (no keyed lanes) yields just [primary].
 */
function rpcTiers(): Array<{ name: RpcTier; url: string }> {
  const tiers: Array<{ name: RpcTier; url: string }> = [
    { name: 'primary', url: SOLANA_RPC_URL },
  ];
  if (ALCHEMY_RPC_URL && ALCHEMY_RPC_URL !== SOLANA_RPC_URL) {
    tiers.push({ name: 'alchemy', url: ALCHEMY_RPC_URL });
  }
  if (
    SOLANA_RPC_FALLBACK_URL !== SOLANA_RPC_URL &&
    SOLANA_RPC_FALLBACK_URL !== ALCHEMY_RPC_URL
  ) {
    tiers.push({ name: 'public', url: SOLANA_RPC_FALLBACK_URL });
  }
  return tiers;
}

let connectionSingleton: Connection | null = null;
let dbcClientSingleton: DynamicBondingCurveClient | null = null;

/** Per-RPC-call budget. When it fires the socket is destroyed, never leaked. */
export const RPC_TIMEOUT_MS = 8_000;

/** Last time a call fell past the primary tier (null = never). */
let lastFallbackAt: number | null = null;

/** Which RPC tier served the last successful call ('primary' until the first failover). */
let activeTier: RpcTier = 'primary';

/** For the health endpoint: which RPC tier is serving and fallback history. */
export function getRpcStatus(): {
  primary: string;
  alchemy: string | null;
  fallback: string;
  primaryIsPublic: boolean;
  activeTier: RpcTier;
  lastFallbackAt: number | null;
} {
  return {
    primary: describeEndpoint(SOLANA_RPC_URL),
    alchemy: ALCHEMY_RPC_URL ? describeEndpoint(ALCHEMY_RPC_URL) : null,
    fallback: describeEndpoint(SOLANA_RPC_FALLBACK_URL),
    primaryIsPublic: SOLANA_RPC_URL === SOLANA_RPC_FALLBACK_URL,
    activeTier,
    lastFallbackAt,
  };
}

/** Redacts any API key from an endpoint for safe logging / status output. */
function describeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    // Strip query strings and fragments (Helius-style ?api-key=...) and
    // redact long key-like path segments (Alchemy-style /v2/<api-key>).
    const path = u.pathname
      .split('/')
      .map((seg) => (looksLikeKeySegment(seg) ? '<redacted>' : seg))
      .join('/');
    const cleanPath = path === '/' ? '' : path;
    return `${u.protocol}//${u.host}${cleanPath}`;
  } catch {
    return 'unparseable-endpoint';
  }
}

/** Heuristic: a long alphanumeric path segment is treated as an API key. */
function looksLikeKeySegment(seg: string): boolean {
  return seg.length >= 20 && /^[A-Za-z0-9_-]+$/.test(seg);
}

/**
 * fetch wrapper with per-call budget AND tiered failover routing.
 * Delegates to the shared rpc-failover wrapper (Helius primary, Alchemy
 * secondary, public fallback), which additionally fails over on retryable
 * JSON-RPC errors like -32603 that ride inside HTTP 200 bodies and that
 * plain HTTP-status failover misses. Tier bookkeeping here feeds the health
 * endpoint's rpc status.
 */
function fetchWithFallback(ms: number): typeof fetch {
  const lanes: RpcLane[] = rpcTiers().map((t) => ({ name: t.name, url: t.url }));
  return createFailoverFetch(lanes, {
    timeoutMs: ms,
    onLaneUsed: (name) => {
      activeTier = name as RpcTier;
      if (name !== 'primary') lastFallbackAt = Date.now();
    },
  });
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
