# StockCurve data layer (`src/lib/db`)

Centralized read model for the launchpad. A single background indexer
(`src/indexer.ts`, run via `npm run indexer`) samples every registered
pool's on-chain state once per interval and persists it here. All
user-facing APIs serve these indexed rows and make **zero live Solana RPC
calls per request**.

## Tables

| Table | Purpose | Written by |
|---|---|---|
| `pools` | Registry: which pools belong to the launchpad + off-chain metadata (replaces `data/pools.json`) | API `POST /api/pools` (transactional) |
| `pool_states` | Latest successfully sampled on-chain state per pool (price, reserves, progress, market cap) | Indexer only |
| `ticks` | Price/reserve samples for charts + derived estimates (24h change, EST VOL) | Indexer only |
| `nonces` | Single-use registration signatures (replay protection) | API `POST /api/pools` |
| `pool_verifications` | Per-pool verification state (`verified`/`unverified`) + detail | API `POST /api/pools` |
| `rate_limits` | Fixed-window registration throttle counters (per IP, per wallet) | API `POST /api/pools` |

Legacy one-time migrations run automatically on first DB open (only when
the destination table is empty):
- `data/pools.json` → `pools` (file renamed to `pools.json.migrated`)
- `data/prices.db` → `ticks` via `ATTACH` (file renamed to `prices.db.migrated`)

## Honesty rules enforced here

- A failed indexer sample **never overwrites** the last good row — it only
  advances `last_attempt_at` / `consecutive_failures`. APIs serve the last
  real values with `stale: true`.
- `sampled_at` older than `STALE_AFTER_MS` (default 30s) ⇒ `stale: true`.
- `ticks` are real samples only: no interpolation, gaps stay gaps
  (`complete: false` from `getHistory`).
- Reserve-movement "volume" is an estimate (`EST VOL`), never exact volume.

## Postgres port

The SQL is kept in the portable subset shared by SQLite and Postgres:

- `INSERT ... ON CONFLICT (...) DO UPDATE` upserts (no `INSERT OR REPLACE`)
- `INTEGER` unix-millisecond timestamps, `INTEGER` 0/1 booleans
- `TEXT` primary keys, no `AUTOINCREMENT` / `SERIAL`
- No SQLite-only date functions, no `RETURNING`

Type mapping: `TEXT` → `TEXT`, `INTEGER` → `BIGINT`, `REAL` → `DOUBLE PRECISION`.
Drop the two `PRAGMA` statements in `db/index.ts` (`journal_mode = WAL`,
`busy_timeout`) — they are SQLite-only. Replace `DatabaseSync` with a
`pg` pool behind the same repository function signatures in
`pools.ts`, `states.ts`, `ticks.ts`, `nonces.ts`, `verifications.ts`;
call sites (`src/pages/api/**`, `src/indexer.ts`) do not change.

## Running the indexer

```sh
npm run indexer          # compile (tsconfig.indexer.json) + run dist-indexer/indexer.js
```

Env: `INDEXER_POLL_MS` (default 10000), `INDEXER_STALE_AFTER_MS`
(default 30000), `INDEXER_TICK_RETENTION_MS` (default 7 days),
`SOLANA_RPC_URL`, `NEXT_PUBLIC_SOLANA_NETWORK` (default devnet).

In production run it as a separate process/container from Next.js,
pointed at the same Postgres. RPC access is REST polling only — never
WebSocket subscriptions.
