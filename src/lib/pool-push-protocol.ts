import type { PoolStateResponse } from '@/components/Pool/types';

/**
 * Wire protocol for pool-state push (indexer -> browser).
 *
 * The indexer samples every registered pool every INDEXER_POLL_MS
 * (default 10s); after each successful sample it broadcasts the fresh
 * state to every WebSocket client subscribed to that pool. Browsers that
 * cannot reach the push server keep the existing REST polling path.
 *
 * Client -> server frames (JSON):
 *   { "type": "subscribe",   "pools": ["<base58>", ...] }
 *   { "type": "unsubscribe", "pools": ["<base58>", ...] }
 *
 * Server -> client frames (JSON):
 *   { "type": "pool-state", "poolAddress": "<base58>", "state": { ... } }
 * where `state` is the exact JSON shape GET /api/pools/[address]/state
 * returns, so pushed states drop straight into the react-query cache.
 *
 * This module is dependency-free on purpose: it is imported by both the
 * node indexer and the browser bundle.
 */

/** Browser -> indexer push URL. Unset means push is disabled; the UI polls. */
export const PUSH_WS_URL: string | undefined =
  typeof process !== 'undefined' && process.env
    ? process.env.NEXT_PUBLIC_CURV_WS_URL || undefined
    : undefined;

/** REST poll cadence for pool state when push is unavailable. */
export const POOL_STATE_POLL_MS = 2000;

/** Max pool addresses accepted in a single subscribe/unsubscribe frame. */
export const MAX_SUBSCRIBE_POOLS = 200;

/** Base delay for reconnect backoff (ms). */
export const PUSH_RECONNECT_BASE_MS = 1000;

/** Cap for reconnect backoff (ms). */
export const PUSH_RECONNECT_MAX_MS = 30_000;

export type PushClientMessage =
  | { type: 'subscribe'; pools: string[] }
  | { type: 'unsubscribe'; pools: string[] };

export interface PushServerMessage {
  type: 'pool-state';
  poolAddress: string;
  state: PoolStateResponse;
}

function isPlausibleAddress(p: unknown): p is string {
  return typeof p === 'string' && p.length >= 32 && p.length <= 64;
}

/** Parse a client frame. Returns null for anything malformed (never throws). */
export function parsePushClientMessage(raw: string): PushClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.type !== 'subscribe' && o.type !== 'unsubscribe') return null;
  if (!Array.isArray(o.pools)) return null;
  const pools = (o.pools as unknown[])
    .filter(isPlausibleAddress)
    .slice(0, MAX_SUBSCRIBE_POOLS);
  return { type: o.type, pools };
}

export function buildSubscribeFrame(pools: string[]): string {
  return JSON.stringify({ type: 'subscribe', pools });
}

export function buildUnsubscribeFrame(pools: string[]): string {
  return JSON.stringify({ type: 'unsubscribe', pools });
}

/** Parse a server frame. Returns null for anything malformed (never throws). */
export function parsePushServerMessage(raw: string): PushServerMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.type !== 'pool-state') return null;
  if (typeof o.poolAddress !== 'string' || !o.poolAddress) return null;
  const s = o.state;
  if (!s || typeof s !== 'object') return null;
  // Minimal shape check: the live fields the UI renders must be present.
  const st = s as Record<string, unknown>;
  if (typeof st.poolAddress !== 'string') return null;
  if (typeof st.stale !== 'boolean') return null;
  return { type: 'pool-state', poolAddress: o.poolAddress, state: st as unknown as PoolStateResponse };
}

/**
 * Exponential backoff with jitter for reconnects. `attempt` starts at 0
 * (first reconnect waits ~0.5-1s); capped at PUSH_RECONNECT_MAX_MS.
 * `rand` is injectable for deterministic tests.
 */
export function computePushReconnectDelay(
  attempt: number,
  rand: () => number = Math.random,
): number {
  const safe = Math.max(0, Math.floor(attempt));
  const exp = Math.min(PUSH_RECONNECT_BASE_MS * 2 ** safe, PUSH_RECONNECT_MAX_MS);
  return Math.floor(exp / 2 + rand() * (exp / 2));
}

/**
 * REST refetch cadence for the pool-state query. While the push socket is
 * connected, polling is disabled entirely (react-query treats `false` as
 * off); otherwise the UI keeps the existing 2s poll.
 */
export function resolvePoolStateRefetchInterval(args: {
  wsUrl: string | undefined;
  wsConnected: boolean;
}): number | false {
  return args.wsUrl && args.wsConnected ? false : POOL_STATE_POLL_MS;
}
