/**
 * Shared Solana RPC failover wrapper.
 *
 * Every server-side RPC call in the app and in the ops scripts goes through
 * here. Lanes are tried in order (Helius primary, then Alchemy). A lane is
 * skipped on transport failure, timeout, HTTP 429/5xx, or a retryable
 * JSON-RPC error. The JSON-RPC case matters: a degraded lane can answer
 * HTTP 200 while every method fails, e.g. Helius returning
 * {"error": {"code": -32603, "message": "Internal error"}} for
 * getSignaturesForAddress on all pools. Plain HTTP-status failover misses
 * that; this wrapper does not.
 *
 * Only when every lane fails does the call throw. Failovers are logged with
 * lane names, never URLs (the URLs carry API keys). The Alchemy lane is
 * skipped gracefully when ALCHEMY_RPC_URL is unset.
 *
 * Dependency-free by design (only @solana/web3.js, an npm package; no repo
 * imports), so plain-node scripts (scripts/*.ts, run with Node 24 type
 * stripping) can import it via a relative '../src/lib/rpc-failover.ts' path.
 */

import { Connection, type Commitment } from '@solana/web3.js';

/**
 * One RPC endpoint in the failover order. `url` may carry an API key:
 * never log it raw, only the `name`.
 */
export interface RpcLane {
  /** Short label for logs, e.g. 'primary', 'alchemy'. */
  name: string;
  /** Full endpoint URL. */
  url: string;
}

/**
 * JSON-RPC error codes treated as lane degradation (retry on the next lane).
 * -32603 is the observed Helius failure mode; the -3200x codes are Solana's
 * documented "node unhealthy / behind / skipped slot" signals. Deliberately
 * excludes -32002 (transaction simulation failed) and friends: those are
 * legitimate answers, not lane problems, and must be returned as-is.
 */
export const RETRYABLE_RPC_ERROR_CODES: ReadonlySet<number> = new Set([
  -32603, // Internal error
  -32005, // Node is unhealthy
  -32007, // Slot was skipped, or missing in long-term storage
  -32009, // Slot was skipped
  -32011, // Blockhash not found (lane lagging behind)
]);

export interface RpcFailoverEvent {
  from: string;
  to: string;
  reason: string;
}

export interface FailoverOptions {
  /** Per-lane timeout in ms. Default 8000. */
  timeoutMs?: number;
  /** Override the retryable JSON-RPC error codes. */
  retryableCodes?: ReadonlySet<number>;
  /** Fired when a lane serves a call (including degraded responses). */
  onLaneUsed?: (laneName: string) => void;
  /** Fired each time a lane fails and the call moves to the next one. */
  onFailover?: (event: RpcFailoverEvent) => void;
  /** Log failovers to console.warn with lane names only. Default true. */
  logFailovers?: boolean;
}

/**
 * Primary (SOLANA_RPC_URL, else RPC_URL) then Alchemy (ALCHEMY_RPC_URL).
 * The Alchemy lane is omitted when unset, so single-lane setups keep
 * working unchanged. Server-side only: the URLs carry API keys and must
 * never reach the browser bundle.
 */
export function resolveRpcLanes(): RpcLane[] {
  const lanes: RpcLane[] = [];
  const primary = process.env.SOLANA_RPC_URL || process.env.RPC_URL || '';
  if (primary) lanes.push({ name: 'primary', url: primary });
  const alchemy = process.env.ALCHEMY_RPC_URL || '';
  if (alchemy && !lanes.some((l) => l.url === alchemy)) {
    lanes.push({ name: 'alchemy', url: alchemy });
  }
  return lanes;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('RPC request timed out')), ms);
  try {
    // The socket must never leak: a hung lane fails fast into the next one.
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** JSON-RPC error code of one response item, or null when it is not an error. */
function rpcErrorCode(item: unknown): number | null {
  if (!item || typeof item !== 'object') return null;
  const err = (item as { error?: unknown }).error;
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

/**
 * True when the response body carries only retryable JSON-RPC errors. A
 * batch containing any non-retryable (legitimate) error is NOT retried: the
 * failure is the answer, not the lane. Non-JSON bodies are returned as-is.
 * Reads a clone, so the original response stays consumable by the caller.
 */
async function isRetryableRpcError(
  res: Response,
  retryableCodes: ReadonlySet<number>,
): Promise<boolean> {
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return false;
  }
  const items = Array.isArray(body) ? body : [body];
  let sawRetryable = false;
  for (const item of items) {
    const code = rpcErrorCode(item);
    if (code === null) continue;
    if (retryableCodes.has(code)) sawRetryable = true;
    else return false;
  }
  return sawRetryable;
}

/**
 * A fetch-compatible function that walks the lanes in order. web3.js posts
 * to the Connection's endpoint (lanes[0].url); the URL is rewritten per
 * lane so a single Connection transparently fans out across all of them.
 *
 * When every lane is merely degraded (429/5xx/retryable RPC error) the last
 * degraded response is returned so callers see the real upstream answer.
 * Only total transport failure across all lanes throws.
 */
export function createFailoverFetch(lanes: RpcLane[], opts: FailoverOptions = {}): typeof fetch {
  if (lanes.length === 0) {
    throw new Error('[rpc-failover] no RPC lanes configured');
  }
  const {
    timeoutMs = 8_000,
    retryableCodes = RETRYABLE_RPC_ERROR_CODES,
    onLaneUsed,
    onFailover,
    logFailovers = true,
  } = opts;
  const primaryUrl = lanes[0].url;

  const noteFailover = (from: string, to: string, reason: string) => {
    if (logFailovers) {
      console.warn(`[rpc-failover] lane "${from}" failed (${reason}); trying "${to}"`);
    }
    onFailover?.({ from, to, reason });
  };

  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let lastDegraded: { lane: RpcLane; res: Response } | null = null;
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i];
      const next = lanes[i + 1];
      const target =
        typeof input === 'string' && input.startsWith(primaryUrl)
          ? lane.url + input.slice(primaryUrl.length)
          : lane.url;
      try {
        const res = await fetchWithTimeout(target, init, timeoutMs);
        if (res.status === 429 || res.status >= 500) {
          lastDegraded = { lane, res };
          if (next) noteFailover(lane.name, next.name, `HTTP ${res.status}`);
          continue;
        }
        if (await isRetryableRpcError(res, retryableCodes)) {
          lastDegraded = { lane, res };
          if (next) noteFailover(lane.name, next.name, 'retryable JSON-RPC error');
          continue;
        }
        onLaneUsed?.(lane.name);
        return res;
      } catch (err) {
        if (next) {
          noteFailover(lane.name, next.name, err instanceof Error ? err.message : 'transport error');
        }
      }
    }
    if (lastDegraded) {
      onLaneUsed?.(lastDegraded.lane.name);
      return lastDegraded.res;
    }
    throw new Error(
      `[rpc-failover] all ${lanes.length} RPC lane(s) failed (${lanes.map((l) => l.name).join(', ')})`,
    );
  }) as typeof fetch;
}

/**
 * A web3.js Connection whose transport fails over across the lanes.
 * Drop-in replacement for `new Connection(url, 'confirmed')`.
 */
export function createFailoverConnection(
  opts: FailoverOptions & { lanes?: RpcLane[]; commitment?: Commitment } = {},
): Connection {
  const { lanes, commitment, ...fetchOpts } = opts;
  const resolved = lanes ?? resolveRpcLanes();
  if (resolved.length === 0) {
    throw new Error(
      '[rpc-failover] no RPC lanes configured: set SOLANA_RPC_URL (and optionally ALCHEMY_RPC_URL)',
    );
  }
  return new Connection(resolved[0].url, {
    commitment: commitment ?? 'confirmed',
    fetch: createFailoverFetch(resolved, fetchOpts),
  });
}
