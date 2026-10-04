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

async function attemptFetch(
  endpoint: string,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  ms: number,
): Promise<Response> {
  let target = input;
  if (typeof input === 'string') {
    // Rewrite the request to the tier being tried: web3.js always posts to
    // the connection's primary endpoint, so strip any tier's URL prefix.
    for (const tier of rpcTiers()) {
      if (input.startsWith(tier.url)) {
        target = endpoint + input.slice(tier.url.length);
        break;
      }
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('RPC request timed out')), ms);
  try {
    return await fetch(target, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch wrapper with per-call budget AND tiered failover routing.
 * Walks the tiers in order (Helius primary, Alchemy secondary, public
 * fallback): on network failure, timeout, HTTP 429 or 5xx it tries the next
 * tier. Solana RPC errors ride inside HTTP 200 bodies, so only
 * transport-level failures trigger the failover; a valid RPC error response
 * is returned as-is. If every tier degrades, the last degraded response is
 * returned; if every tier fails transport, it throws.
 * A dead RPC endpoint must fail fast; a hung request that only rejects at
 * the application level would leak the socket and degrade every later call.
 */
function fetchWithFallback(ms: number): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const tiers = rpcTiers();
    let lastDegraded: { tier: RpcTier; res: Response } | null = null;
    for (const tier of tiers) {
      try {
        const res = await attemptFetch(tier.url, input, init, ms);
        if (res.status === 429 || res.status >= 500) {
          // Degraded: remember it and try the next tier.
          lastDegraded = { tier: tier.name, res };
          continue;
        }
        activeTier = tier.name;
        if (tier.name !== 'primary') lastFallbackAt = Date.now();
        return res;
      } catch {
        // Transport failure or timeout: try the next tier.
      }
    }
    if (lastDegraded) {
      activeTier = lastDegraded.tier;
      if (tiers.length > 1) lastFallbackAt = Date.now();
      return lastDegraded.res;
    }
    throw new Error('RPC request failed');
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
