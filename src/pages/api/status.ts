import type { NextApiRequest, NextApiResponse } from 'next';
import { Connection } from '@solana/web3.js';
import { query } from '@/lib/db/index';
import { listRecentAlerts, listUnresolvedAlerts, type OpsAlert } from '@/lib/db/ops-alerts';
import {
  getConnection,
  getRpcStatus,
  RPC_TIMEOUT_MS,
  SOLANA_NETWORK,
  SOLANA_RPC_FALLBACK_URL,
} from '@/lib/solana';

const STARTED_AT = Date.now();
const COMMIT_SHA = process.env.VERCEL_GIT_COMMIT_SHA ?? null;

interface TierStatus {
  name: 'primary' | 'fallback';
  host: string;
  ok: boolean;
  latencyMs: number;
  slot: number | null;
}

/** getSlot with a hard timeout so one dead tier can't stall the status page. */
async function probeTier(conn: Connection, ms: number): Promise<{ ok: boolean; latencyMs: number; slot: number | null }> {
  const start = Date.now();
  try {
    const slot = await Promise.race([
      conn.getSlot('confirmed'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('rpc probe timeout')), ms)),
    ]);
    return { ok: true, latencyMs: Date.now() - start, slot };
  } catch {
    return { ok: false, latencyMs: Date.now() - start, slot: null };
  }
}

export interface StatusResponse {
  ok: boolean;
  network: string;
  commit: string | null;
  uptimeSec: number;
  db: {
    ok: boolean;
    latencyMs: number;
    counts: { pools: number; poolStates: number; feeSplits: number; ticks: number; notifications: number };
  };
  rpc: {
    tiers: TierStatus[];
    primaryIsPublic: boolean;
    lastFallbackAt: number | null;
  };
  alerts: {
    unresolved: OpsAlert[];
    recent: OpsAlert[];
  };
}

/**
 * GET /api/status — rich status for the ops runbook and the scheduled
 * health-check worker. Heavier than /api/health (which stays the cheap
 * liveness probe for external uptime monitors): per-tier RPC latency,
 * table counts, deploy commit, and the ops alert log.
 *
 * No auth. Exposes only aggregates and redacted endpoint hosts, never keys.
 */
export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<StatusResponse>,
) {
  const rpcMeta = getRpcStatus();

  const dbStart = Date.now();
  let dbOk = false;
  const counts = { pools: 0, poolStates: 0, feeSplits: 0, ticks: 0, notifications: 0 };
  try {
    const rows = await query<{
      pools: number;
      pool_states: number;
      fee_splits: number;
      ticks: number;
      notifications: number;
    }>(`SELECT
       (SELECT COUNT(*) FROM pools) AS pools,
       (SELECT COUNT(*) FROM pool_states) AS pool_states,
       (SELECT COUNT(*) FROM fee_splits) AS fee_splits,
       (SELECT COUNT(*) FROM ticks) AS ticks,
       (SELECT COUNT(*) FROM notifications) AS notifications`);
    const r = rows[0];
    if (r) {
      counts.pools = Number(r.pools ?? 0);
      counts.poolStates = Number(r.pool_states ?? 0);
      counts.feeSplits = Number(r.fee_splits ?? 0);
      counts.ticks = Number(r.ticks ?? 0);
      counts.notifications = Number(r.notifications ?? 0);
    }
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const dbLatencyMs = Date.now() - dbStart;

  const [primary, fallback] = await Promise.all([
    probeTier(getConnection(), RPC_TIMEOUT_MS),
    probeTier(new Connection(SOLANA_RPC_FALLBACK_URL), RPC_TIMEOUT_MS),
  ]);
  const tiers: TierStatus[] = [
    { name: 'primary', host: rpcMeta.primary, ...primary },
    { name: 'fallback', host: rpcMeta.fallback, ...fallback },
  ];

  // Alert log is best effort: if the DB is down, status still reports.
  let unresolved: OpsAlert[] = [];
  let recent: OpsAlert[] = [];
  try {
    [unresolved, recent] = await Promise.all([listUnresolvedAlerts(10), listRecentAlerts(10)]);
  } catch {
    // leave empty
  }

  const ok = dbOk && primary.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    network: SOLANA_NETWORK,
    commit: COMMIT_SHA,
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    db: { ok: dbOk, latencyMs: dbLatencyMs, counts },
    rpc: {
      tiers,
      primaryIsPublic: rpcMeta.primaryIsPublic,
      lastFallbackAt: rpcMeta.lastFallbackAt,
    },
    alerts: { unresolved, recent },
  });
}
