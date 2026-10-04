import { execute, query } from './index';

export interface OpsAlert {
  id: number;
  kind: string;
  message: string;
  createdAt: number;
  resolvedAt: number | null;
}

function rowToAlert(r: {
  id: number | string;
  kind: string;
  message: string;
  created_at: number;
  resolved_at: number | null;
}): OpsAlert {
  return {
    id: Number(r.id),
    kind: r.kind,
    message: r.message,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/**
 * Raise an ops alert. Deduped: no-ops when an unresolved alert of the same
 * kind already exists, so a flapping probe writes one row, not one per poll.
 * Returns true when a new alert row was created.
 *
 * Side effects on a new alert only: a server log line (visible in Vercel
 * logs) and, when OPS_ALERT_WEBHOOK_URL is set, a best-effort POST
 * { text } to that webhook (Discord/Slack compatible). Both are
 * fire-and-forget safe: failures never throw.
 */
export async function raiseAlert(kind: string, message: string): Promise<boolean> {
  const inserted = await execute(
    `INSERT INTO ops_alerts (kind, message, created_at, resolved_at)
     SELECT $1, $2, $3, NULL
     WHERE NOT EXISTS (
       SELECT 1 FROM ops_alerts WHERE kind = $1 AND resolved_at IS NULL
     )`,
    [kind, message, Date.now()],
  );
  if (inserted === 0) return false;

  console.error(`[ops-alert] ${kind}: ${message}`);
  const webhook = process.env.OPS_ALERT_WEBHOOK_URL;
  if (webhook) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `[curv ops-alert] ${kind}: ${message}` }),
          signal: ctrl.signal,
        });
      } catch {
        // Delivery is best effort; ignore network errors.
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Best effort: alert delivery must never break the request.
    }
  }
  return true;
}

/** Mark every unresolved alert of a kind resolved. Returns rows resolved. */
export async function resolveAlerts(kind: string): Promise<number> {
  return execute(
    'UPDATE ops_alerts SET resolved_at = $1 WHERE kind = $2 AND resolved_at IS NULL',
    [Date.now(), kind],
  );
}

/** Unresolved alerts, newest first. What the health-check worker polls. */
export async function listUnresolvedAlerts(limit = 20): Promise<OpsAlert[]> {
  const rows = await query<{
    id: number;
    kind: string;
    message: string;
    created_at: number;
    resolved_at: number | null;
  }>(
    'SELECT id, kind, message, created_at, resolved_at FROM ops_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT $1',
    [limit],
  );
  return rows.map(rowToAlert);
}

/** Recent alerts including resolved ones, newest first. */
export async function listRecentAlerts(limit = 20): Promise<OpsAlert[]> {
  const rows = await query<{
    id: number;
    kind: string;
    message: string;
    created_at: number;
    resolved_at: number | null;
  }>(
    'SELECT id, kind, message, created_at, resolved_at FROM ops_alerts ORDER BY created_at DESC LIMIT $1',
    [limit],
  );
  return rows.map(rowToAlert);
}
