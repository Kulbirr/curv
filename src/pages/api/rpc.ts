import type { NextApiRequest, NextApiResponse } from 'next';
import {
  parseProxyRequest,
  resolveProxyUpstream,
  RPC_PROXY_TIMEOUT_MS,
} from '@/lib/rpc-proxy';
import { SOLANA_RPC_FALLBACK_URL } from '@/lib/solana';

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
 * set of Solana JSON-RPC methods from the server's keyed lane (Helius today;
 * set RPC_PROXY_UPSTREAM_URL to use Alchemy) and falls back to the public
 * endpoint on transport failure, mirroring the server routing in lib/solana.
 * The upstream URL is never logged or returned to the client.
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

  // Primary: keyed lane. Transport failure, timeout, 429 or 5xx falls
  // through to the public endpoint; valid RPC errors ride inside HTTP 200
  // bodies and are returned as-is.
  const upstream = resolveProxyUpstream();
  if (upstream) {
    try {
      const r = await forward(upstream, body);
      if (r.status !== 429 && r.status < 500) {
        return passthrough(res, r, await r.text());
      }
    } catch {
      // fall through to the public fallback
    }
  } else {
    // No keyed upstream configured; still enforce the allowlist in front
    // of the public endpoint so this route is never an open relay.
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
