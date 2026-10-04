# Curv production monitoring

Lean, server-side monitoring for https://curvpad.fun. Goal: catch outages fast, without noise.

## What is monitored

| Probe | What it checks | Where |
|---|---|---|
| `/api/health` | DB reachable + latency + pool count; primary RPC `getSlot` + latency; uptime. Returns **503** when unhealthy. | Cheap liveness probe. Point an external uptime monitor (UptimeRobot etc.) at it. |
| `/api/status` | Everything health has, plus: deploy commit SHA, per-tier RPC latency (primary **and** fallback, hosts redacted), DB table counts (pools, pool_states, fee_splits, ticks, notifications), and the ops alert log. Returns **503** when DB or primary RPC is down. | Rich status. Polled by the scheduled health-check worker. Heavier: do not point high-frequency external monitors at it. |
| Health transitions | `/api/health` writes to the `ops_alerts` table on healthy → unhealthy transitions and auto-resolves on recovery. Deduped: one row per incident, not one per poll. | `ops_alerts` table; surfaced in `/api/status` under `alerts`. |

## Where alerts go

1. **HTTP status**: `/api/health` and `/api/status` return 503 when unhealthy. This is the primary signal for external monitors.
2. **`ops_alerts` table**: every transition is logged with kind + message + timestamps. Read via `GET /api/status` → `alerts.unresolved` / `alerts.recent`.
3. **Server logs**: new alerts also log `console.error('[ops-alert] <kind>: <message>')`, visible in Vercel → Logs.
4. **Optional webhook**: set `OPS_ALERT_WEBHOOK_URL` (Vercel env, server-only) to a Discord/Slack incoming-webhook URL and new alerts POST `{ text }` there. Best effort, 5s timeout, never breaks the request. Unset by default.
5. **Vercel deployment failures**: not detectable from inside the app. Enable natively in Vercel → Project → Settings → Notifications (email/Slack/Discord) for failed deployments.

The in-app notifications system (`/api/notifications/emit`) is a per-wallet inbox for fee events; it is **not** an ops channel and health alerts are deliberately not wired into it.

## How to check status

```bash
# Liveness (cheap, for uptime monitors)
curl -s https://curvpad.fun/api/health | python3 -m json.tool

# Rich status: commit, RPC tiers, counts, alert log
curl -s https://curvpad.fun/api/status | python3 -m json.tool

# Recent alerts straight from the DB (Neon)
psql "$DATABASE_URL" -c "SELECT id, kind, message, to_timestamp(created_at/1000), to_timestamp(resolved_at/1000) FROM curv.ops_alerts ORDER BY created_at DESC LIMIT 10;"
```

Healthy looks like: `ok: true`, `db.ok: true`, `rpc.ok: true`, `alerts.unresolved: []`.

## How to silence

- Alerts **auto-resolve** when `/api/health` recovers; no manual step needed.
- To stop webhook noise: unset `OPS_ALERT_WEBHOOK_URL` in Vercel and redeploy (or point it at a muted channel).
- To stop external pings: pause the uptime monitor / the scheduled health-check worker. The alert log keeps working regardless.
- There is no ack/mute API by design; if alert fatigue becomes real, add one rather than disabling the probe.

## Scheduled workers (this runtime)

- **Production health check**: polls `/api/health`, retries once on empty reply, reports failures. Should also read `/api/status` → `alerts.unresolved` so DB-logged incidents surface even when the probe itself is flaky.
- **Buyback keeper** (every 30 min): logs its own sweep results; failures are reported by the worker, not through the ops alert log.

## Adding a new alert kind

```ts
import { raiseAlert, resolveAlerts } from '@/lib/db/ops-alerts';
await raiseAlert('grinder', 'vanity grinder produced 0 addresses in 1h'); // deduped while unresolved
await resolveAlerts('grinder'); // on recovery
```

Keep kinds stable and coarse (`health`, `grinder`, `keeper`); fine-grained per-pool noise belongs in logs, not the alert table.
