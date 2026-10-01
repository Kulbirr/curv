/**
 * Shared logic for the same-origin /api/rpc JSON-RPC proxy.
 *
 * Why this exists: browser chain reads used to hit Solana's public devnet
 * endpoint directly (slow, shared, rate-limited). A keyed RPC URL must never
 * ship in the browser bundle (any visitor could copy the key), so the
 * browser now talks to /api/rpc and the server forwards from its keyed lane.
 *
 * Security: only an allowlist of read/write methods the app actually uses
 * is forwarded. Everything else (including admin methods) is rejected, so
 * the proxy cannot be used as a generic key-burning relay.
 */

/** JSON-RPC methods the Curv frontend is allowed to call through the proxy. */
export const RPC_PROXY_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo',
  'getBalance',
  'getLatestBlockhash',
  'getParsedAccountInfo',
  'getParsedTokenAccountsByOwner',
  'getTokenAccountsByOwner',
  'getProgramAccounts',
  'getSignatureStatus',
  'getSignatureStatuses',
  'getTokenAccountBalance',
  'getTokenLargestAccounts',
  'getTokenSupply',
  'simulateTransaction',
  'sendTransaction',
]);

export const RPC_PROXY_MAX_BODY_BYTES = 256 * 1024;
export const RPC_PROXY_TIMEOUT_MS = 8000;

export interface RpcProxyRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

export type ParsedProxyRequest =
  | { ok: true; req: RpcProxyRequest }
  | { ok: false; error: string };

/** Validate a parsed JSON body as a single allowlisted JSON-RPC request. */
export function parseProxyRequest(body: unknown): ParsedProxyRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Expected a single JSON-RPC request object' };
  }
  const b = body as Record<string, unknown>;
  if (b.jsonrpc !== '2.0') return { ok: false, error: 'jsonrpc must be "2.0"' };
  if (typeof b.method !== 'string' || !RPC_PROXY_ALLOWED_METHODS.has(b.method)) {
    return { ok: false, error: `Method not allowed: ${String(b.method)}` };
  }
  if (!('id' in b)) return { ok: false, error: 'Missing id' };
  const id = b.id;
  // Note: strictNullChecks is off in this repo, so narrow via a positive
  // check plus a cast; the runtime validation above is what enforces it.
  const idOk = typeof id === 'string' || typeof id === 'number' || id === null;
  if (!idOk) {
    return { ok: false, error: 'Invalid id' };
  }
  const reqId = id as string | number | null;
  return { ok: true, req: { jsonrpc: '2.0', id: reqId, method: b.method, params: b.params } };
}

/**
 * Keyed upstream for the proxy. Set RPC_PROXY_UPSTREAM_URL to point it at
 * Alchemy (or any keyed endpoint) without a code change; otherwise it uses
 * the existing server Helius lane. Empty string means "no keyed upstream".
 */
export function resolveProxyUpstream(): string {
  return (
    process.env.RPC_PROXY_UPSTREAM_URL ||
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_URL ||
    ''
  );
}
