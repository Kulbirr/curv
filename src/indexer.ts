/**
 * StockCurve pool-state indexer, the single process that reads the chain.
 *
 * Every INDEXER_POLL_MS (default 10s) it iterates all registered pools and
 * calls fetchPoolLiveState ONCE per pool, then persists:
 *   - the full sample into pool_states (the read model all user-facing
 *     APIs serve from, zero live RPC per user request), and
 *   - a price/reserve tick into ticks (chart history + estimates).
 *
 * When INDEXER_WS_PORT is set, the indexer also runs a WebSocket push
 * server (see src/indexer-ws.ts): after each successful sample it
 * broadcasts the fresh state to browsers subscribed to that pool, so pool
 * pages update without polling the REST API. Pushes arrive at the
 * indexer sample cadence (INDEXER_POLL_MS, default 10s). When the env var
 * is unset, push is fully disabled and nothing else changes.
 *
 * A failed sample never overwrites the last good one; the API keeps
 * serving the most recent real values with stale: true.
 *
 * Run:  npm run indexer
 * Env:  INDEXER_POLL_MS (default 10000)
 *       INDEXER_STALE_AFTER_MS (default 30000, used by API routes)
 *       INDEXER_TICK_RETENTION_MS (default 7 days)
 *       INDEXER_WS_PORT (unset by default; set to enable push, e.g. 8787)
 *       SOLANA_RPC_URL / RPC_URL, NEXT_PUBLIC_SOLANA_NETWORK (as elsewhere)
 *
 * Production: run this as a separate process/container from the Next.js
 * app, pointed at the same Postgres database (swap the db layer; the SQL
 * is portable). Scale by sharding pools across indexer replicas; the
 * ON CONFLICT upserts make overlapping coverage idempotent.
 *
 * Solana data access is REST polling only, never WebSocket subscriptions.
 */

import { ensureSchema } from './lib/db';
import { INDEXER_POLL_MS, INDEXER_WS_PORT, TICK_RETENTION_MS } from './lib/db/config';
import { listPools } from './lib/db/pools';
import { recordPoolSample, type PoolStateSample } from './lib/db/states';
import { pruneTicks, recordTick } from './lib/db/ticks';
import { fetchPoolLiveState } from './lib/pool-state';
import { buildBroadcastState } from './lib/pool-state-broadcast';
import { SOLANA_NETWORK, SOLANA_RPC_URL } from './lib/solana';
import { PoolStateBroadcaster } from './indexer-ws';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactRpc(url: string): string {
  return url.replace(/api-key=[^&]*/i, 'api-key=***');
}

/** Sample every registered pool once. Exported for tests; main() loops it. */
export async function sampleAllPools(): Promise<void> {  const pools = await listPools();
  const now = Date.now();
  if (pools.length === 0) return;

  for (const pool of pools) {
    try {
      const state = await fetchPoolLiveState(pool);
      if (state.stale) {
        // Failed read: preserve the last good sample, record the attempt.
        await recordPoolSample(pool.poolAddress, null, now);
        console.log(
          new Date(now).toISOString(),
          pool.baseSymbol || pool.poolAddress,
          'SAMPLE FAILED (last good values kept, served as stale)',
        );
        continue;
      }
      const sample: PoolStateSample = {
        price: state.price,
        quoteReserve: state.quoteReserve,
        baseReserve: state.baseReserve,
        progress: state.progress,
        graduated: state.graduated,
        hasSwap: state.hasSwap,
        marketCap: state.marketCap,
        baseDecimals: state.baseDecimals,
        quoteDecimals: state.quoteDecimals,
        migrationQuoteThreshold: state.migrationQuoteThreshold,
        creatorBaseFeeRaw: state.creatorBaseFeeRaw,
        creatorQuoteFeeRaw: state.creatorQuoteFeeRaw,
      };
      await recordPoolSample(pool.poolAddress, sample, now);
      if (state.price !== null) {
        await recordTick(pool.poolAddress, now, state.price, state.quoteReserve);
      }
      // Push the fresh state to subscribed browsers when the WS server is on.
      // A push failure must never break the sampling loop.
      if (stateBroadcaster) {
        try {
          const pushed = await buildBroadcastState(pool, sample, now);
          stateBroadcaster.broadcast(pool.poolAddress, pushed);
        } catch (err) {
          console.log(
            new Date(now).toISOString(),
            pool.baseSymbol || pool.poolAddress,
            'PUSH FAILED:',
            err instanceof Error ? err.message : err,
          );
        }
      }
      console.log(
        new Date(now).toISOString(),
        pool.baseSymbol || pool.poolAddress,
        `price=${state.price}`,
        `quoteReserve=${state.quoteReserve}`,
        `progress=${state.progress}`,
      );
    } catch (err) {
      await recordPoolSample(pool.poolAddress, null, now);
      console.log(
        new Date(now).toISOString(),
        pool.baseSymbol || pool.poolAddress,
        'SAMPLE ERROR:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  await pruneTicks(now - TICK_RETENTION_MS);
}

/**
 * Optional push broadcaster; null unless INDEXER_WS_PORT was set at startup.
 * Exported so tests can inject a fake without starting a real server.
 */
let stateBroadcaster: PoolStateBroadcaster | null = null;
export function setStateBroadcaster(b: PoolStateBroadcaster | null): void {
  stateBroadcaster = b;
}

async function main(): Promise<void> {
  // Open the DB eagerly so the schema exists before the first sample pass.
  await ensureSchema();
  console.log(
    `stockcurve indexer started network=${SOLANA_NETWORK} rpc=${redactRpc(SOLANA_RPC_URL)} poll=${INDEXER_POLL_MS}ms`,
  );
  if (INDEXER_WS_PORT !== null) {
    try {
      setStateBroadcaster(
        new PoolStateBroadcaster(INDEXER_WS_PORT, {
          onError: (err) =>
            console.log(`indexer push websocket error: ${err.message}`),
        }),
      );
      console.log(`indexer pool-state push websocket listening on port ${INDEXER_WS_PORT}`);
    } catch (err) {
      console.log(
        'indexer push websocket failed to start:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  for (;;) {
    await sampleAllPools().catch((err) =>
      console.log('sample pass failed:', err instanceof Error ? err.message : err),
    );
    await sleep(INDEXER_POLL_MS);
  }
}

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`indexer received ${signal}, shutting down`);
  const done = stateBroadcaster ? stateBroadcaster.close() : Promise.resolve();
  done
    .catch((): void => undefined)
    .finally((): void => {
      process.exit(0);
    });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * Only run the daemon loop when this file is the entry point
 * (node dist-indexer/indexer.js). Importing it (e.g. in tests) must not
 * start the infinite sampling loop as a side effect.
 */
const invokedDirectly =
  typeof process.argv[1] === 'string' && /(^|\/)indexer\.js$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('indexer crashed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { main };
