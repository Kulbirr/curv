/**
 * Strategy track-record resolver. Runs every 30 minutes (agent cron).
 *
 * For each published signal still awaiting a verdict, pulls 1-minute
 * Coinbase spot candles for the signal's live window and scores first
 * touch: target[0] high tags a win, stop low breaks a loss, expiry with
 * neither is neutral. Idempotent: resolveSignal only flips pending rows.
 *
 * DB creds come from the mode-600 grinder env file (same database, curv
 * schema), never from the command line.
 *
 * Usage: tsx scripts/resolve-strategy-signals.ts
 */
import { ensureSchema, getPool } from '../src/lib/db/index';
import {
  listSignalsAwaitingResolution,
  resolveSignal,
} from '../src/lib/db/strategies';
import { fetchKlines, resolveOutcome } from '../src/lib/strategies/resolution';

async function main(): Promise<void> {
  await ensureSchema();
  const now = Date.now();
  const pending = await listSignalsAwaitingResolution(now);
  console.log(`[resolver] ${pending.length} signal(s) awaiting resolution`);
  for (const s of pending) {
    const klines = await fetchKlines(s.baseSymbol, s.createdAt, Math.min(now, s.expiresAt));
    if (klines === null) {
      console.log(`[resolver] ${s.id} (${s.baseSymbol}): no candle feed, skipping`);
      continue;
    }
    const r = resolveOutcome(s, klines, now);
    if (r.outcome === 'pending') {
      console.log(`[resolver] ${s.id} (${s.baseSymbol}): still pending`);
      continue;
    }
    const flipped = await resolveSignal(s.id, r.outcome, r.resolvedAt, r.resolvedPrice);
    console.log(
      `[resolver] ${s.id} (${s.baseSymbol}): ${r.outcome}` +
        (r.resolvedPrice !== null ? ` @ ${r.resolvedPrice}` : '') +
        (flipped ? '' : ' (already resolved)'),
    );
  }
  await getPool().end();
}

main().catch((e) => {
  console.error('[resolver] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
