import type { NextApiRequest, NextApiResponse } from 'next';
import {
  parseProxyRequest,
  resolveProxyUpstreams,
  RPC_PROXY_TIMEOUT_MS,
} from '@/lib/rpc-proxy';
import { getClientIp } from '@/lib/api-validation';
import { hitRateLimit } from '@/lib/db/rate-limits';
import { SOLANA_RPC_FALLBACK_URL } from '@/lib/solana';

/**
 * sendTransaction is the one allowlisted method that spends paid RPC quota
 * per call and can be abused by anonymous visitors to burn the keyed lane.
 * Reads stay unlimited; transaction submission gets a strict per-IP budget
 * (60/hour is far above real trading: one trade is one send).
 */
const SEND_TX_LIMIT = 60;
const SEND_TX_WINDOW_MS = 60 * 60_000;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '256kb',
    },
  },
};

/**
 * POST /api/rpc — same-origin JSON-RPC proxy for browser chain reads.
 *
 * The browser never sees a keyed RPC URL. This route forwards an allowlisted
 * set of Solana JSON-RPC methods from the server's keyed lanes (Helius
 * primary, Alchemy secondary via ALCHEMY_RPC_URL; RPC_PROXY_UPSTREAM_URL
 * overrides both) and falls back to the public endpoint on transport
 * failure, mirroring the server routing in lib/solana. The upstream URLs
 * are never logged or returned to the client.
 */
async function forward(upstream: string, body: unknown): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_PROXY_TIMEOUT_MS);
  try {
    return await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function passthrough(res: NextApiResponse, upstreamRes: Response, text: string) {
  res.setHeader('content-type', 'application/json');
  return res.status(upstreamRes.status).send(text);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = parseProxyRequest(req.body);
  // Note: strictNullChecks is off in this repo; `parsed.ok === false`
  // narrows the union where `!parsed.ok` does not.
  if (parsed.ok === false) {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: parsed.error },
    });
  }

  const body = {
    jsonrpc: '2.0',
    id: parsed.req.id,
    method: parsed.req.method,
    params: parsed.req.params ?? [],
  };

  // Tight per-IP budget on transaction submission; see SEND_TX_LIMIT.
  if (parsed.req.method === 'sendTransaction') {
    const hit = await hitRateLimit(
      `rpc:send:${getClientIp(req)}`,
      SEND_TX_LIMIT,
      SEND_TX_WINDOW_MS,
      Date.now()
    );
    if (!hit.allowed) {
      return res.status(429).json({
        jsonrpc: '2.0',
        id: parsed.req.id,
        error: {
          code: -32000,
          message:
            'Transaction submission rate limit exceeded. Wait a little and try again.',
        },
      });
    }
  }

  // Keyed tiers in failover order: RPC_PROXY_UPSTREAM_URL override, the
  // Helius primary lane, then the Alchemy secondary lane. Transport failure,
  // timeout, 429 or 5xx falls through to the next tier; valid RPC errors
  // ride inside HTTP 200 bodies and are returned as-is. When no keyed
  // upstream is configured the loop is skipped and the allowlist still
  // guards the public endpoint, so this route is never an open relay.
  const upstreams = resolveProxyUpstreams();
  for (const upstream of upstreams) {
    try {
      const r = await forward(upstream, body);
      if (r.status !== 429 && r.status < 500) {
        return passthrough(res, r, await r.text());
      }
      // Degraded: try the next keyed tier.
    } catch {
      // Transport failure or timeout: try the next keyed tier.
    }
  }

  try {
    const r = await forward(SOLANA_RPC_FALLBACK_URL, body);
    return passthrough(res, r, await r.text());
  } catch {
    return res.status(502).json({
      jsonrpc: '2.0',
      id: parsed.req.id,
      error: { code: -32000, message: 'Upstream RPC unreachable' },
    });
  }
}
