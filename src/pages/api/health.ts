import type { NextApiRequest, NextApiResponse } from 'next';
import { query } from '@/lib/db/index';
import { getConnection, getRpcStatus, SOLANA_NETWORK } from '@/lib/solana';

export interface HealthResponse {
  ok: boolean;
  network: string;
  db: { ok: boolean; latencyMs: number; pools: number };
  rpc: { ok: boolean; latencyMs: number; slot: number | null } & ReturnType<typeof getRpcStatus>;
  uptimeSec: number;
}

const STARTED_AT = Date.now();

/**
 * Public liveness probe for uptime monitoring (UptimeRobot etc.).
 * Cheap by design: one indexed COUNT, one getSlot. No auth, it exposes
 * only aggregate counts and redacted endpoint hosts, never keys.
 */
export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<HealthResponse>,
) {
  const dbStart = Date.now();
  let dbOk = false;
  let pools = 0;
  try {
    const rows = await query<{ c: number }>('SELECT COUNT(*) AS c FROM pools');
    pools = Number(rows[0]?.c ?? 0);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const dbLatencyMs = Date.now() - dbStart;

  const rpcStart = Date.now();
  let rpcOk = false;
  let slot: number | null = null;
  try {
    slot = await getConnection().getSlot();
    rpcOk = true;
  } catch {
    rpcOk = false;
  }
  const rpcLatencyMs = Date.now() - rpcStart;

  const ok = dbOk && rpcOk;
  res.status(ok ? 200 : 503).json({
    ok,
    network: SOLANA_NETWORK,
    db: { ok: dbOk, latencyMs: dbLatencyMs, pools },
    rpc: { ok: rpcOk, latencyMs: rpcLatencyMs, slot, ...getRpcStatus() },
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
  });
}
