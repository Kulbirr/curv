/**
 * Curv vanity mint pool grinder.
 *
 * Continuously generates ed25519 keypairs until the base58 public key
 * ends in "...curv" and stores winners (secrets encrypted at rest) in
 * the vanity_pool table. The handout endpoint (POST /api/vanity-mint)
 * claims them atomically, so launches are instant — the grind never
 * happens at click time, exactly like pump.fun's pre-ground pool.
 *
 * The suffix match comes from src/lib/vanity-core.ts — the same
 * definition the client-side grinder uses. The loop itself is a tight
 * Node loop (no DOM, no Web Workers needed here).
 *
 * Run:  npm run grind
 * Env:
 *   VANITY_POOL_KEY              required, 64 hex chars (openssl rand -hex 32).
 *                                Fail closed: the grinder refuses to start
 *                                without it.
 *   VANITY_POOL_TARGET           ready keypairs to keep (default 50).
 *   VANITY_GRIND_TOPUP_MS        ms between top-up checks (default 30000).
 *
 * Ops: run as a background process (see docs/vanity-pool.md for a
 * systemd sketch). Monitor with:
 *   sqlite3 data/stockcurve.db \
 *     "SELECT SUM(consumed=0), SUM(consumed=1) FROM vanity_pool;"
 * The process is idempotent: kill and restart any time; it tops up what
 * is missing. A dead database never kills the worker: DB calls retry on
 * lost connections (see queryWithRetry in src/lib/db/index.ts), a
 * keep-alive ping runs every few minutes through the long CPU-bound
 * grind, and a genuinely unreachable database just makes the loop wait
 * and retry instead of exiting.
 */

import { Keypair } from '@solana/web3.js';
import { getDb, query } from '../src/lib/db/index';
import { pruneConsumedVanityMints, storeVanityMint, vanityPoolStats } from '../src/lib/db/vanity-pool';
import { VANITY_SUFFIX, matchesVanitySuffix } from '../src/lib/vanity-core';
import { encryptSecret, getVanityPoolKey } from '../src/lib/vanity-crypto';

const TARGET = Math.max(1, parseInt(process.env.VANITY_POOL_TARGET ?? '50', 10) || 50);
const TOPUP_MS = Math.max(5_000, parseInt(process.env.VANITY_GRIND_TOPUP_MS ?? '30000', 10) || 30_000);
const CONSUMED_RETENTION_MS = 24 * 60 * 60_000;
const LOG_EVERY = 30_000;
// A managed Postgres (Aiven) terminates idle connections server-side,
// and one grind takes ~78 minutes of pure CPU with zero DB traffic.
// Ping the DB on this interval during the grind so pooled connections
// never sit idle long enough to be killed. Failures are swallowed: the
// query layer retries on dead connections anyway, and a failed ping
// simply evicts a dead client.
const KEEPALIVE_MS = 4 * 60_000;
// When the database is genuinely unreachable, wait this long between
// retries instead of crash-looping (the watchdog would restart us every
// 15 minutes anyway).
const DB_RETRY_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function dbErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface GrindResult {
  keypair: Keypair;
  attempts: number;
  durationMs: number;
}

/**
 * Single-threaded grind. Yields to the event loop every 50k attempts —
 * without this, the tight loop would starve the event loop and SIGTERM /
 * SIGINT handlers could never run (the process would be unkillable short
 * of SIGKILL). The yield also bounds shutdown latency: worst case the
 * process exits ~50k attempts after the signal (~15s at 3.3k/s, ~1-2s on
 * fast hardware).
 */
async function grindOne(
  onProgress: (attempts: number, elapsedMs: number) => void,
  isStopping: () => boolean,
): Promise<GrindResult | null> {
  const startedAt = Date.now();
  let attempts = 0;
  let lastLog = 0;
  for (;;) {
    const kp = Keypair.generate();
    attempts += 1;
    if (matchesVanitySuffix(kp.publicKey.toBase58(), VANITY_SUFFIX)) {
      return { keypair: kp, attempts, durationMs: Date.now() - startedAt };
    }
    if (attempts - lastLog >= 50_000) {
      lastLog = attempts;
      // Let the event loop run so signal handlers fire.
      await new Promise<void>((r) => setImmediate(r));
      if (isStopping()) return null;
      onProgress(attempts, Date.now() - startedAt);
    }
  }
}

async function main(): Promise<void> {
  // Fail closed before doing any work: no key, no pool.
  getVanityPoolKey();
  getDb();
  console.log(
    `[grind-pool] starting — suffix "...${VANITY_SUFFIX}", target ${TARGET} ready keypair(s)`,
  );

  let stopping = false;
  const stop = () => {
    if (!stopping) {
      stopping = true;
      console.log('[grind-pool] stopping after current grind…');
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  for (;;) {
    if (stopping) break;
    // A dead database must never kill the worker: log, wait, retry the
    // loop. The watchdog restarts actually-dead processes; a DB blip is
    // not a reason to exit.
    let stats;
    try {
      stats = await vanityPoolStats();
    } catch (e) {
      console.error(`[grind-pool] db error on stats, retrying in 60s: ${dbErrorMessage(e)}`);
      await sleep(DB_RETRY_MS);
      continue;
    }
    if (stats.ready >= TARGET) {
      try {
        await pruneConsumedVanityMints(Date.now() - CONSUMED_RETENTION_MS);
      } catch (e) {
        console.error(`[grind-pool] db error on prune, skipping: ${dbErrorMessage(e)}`);
      }
      await sleep(TOPUP_MS);
      continue;
    }
    const need = TARGET - stats.ready;
    console.log(`[grind-pool] ready=${stats.ready} consumed=${stats.consumed} — grinding ${need} more`);
    let lastLogAt = 0;
    let lastKeepaliveAt = 0;
    const res = await grindOne(
      (attempts, elapsedMs) => {
        const now = Date.now();
        if (now - lastLogAt >= LOG_EVERY) {
          lastLogAt = now;
          const rate = elapsedMs > 0 ? Math.round((attempts / elapsedMs) * 1000) : 0;
          console.log(
            `[grind-pool] ${attempts.toLocaleString('en-US')} attempts (${rate.toLocaleString('en-US')}/s)`,
          );
        }
        // Keep one pooled connection warm through the long CPU-bound
        // grind. Fire-and-forget with a swallow: a failure just evicts a
        // dead client, the query layer retries on the real calls anyway.
        if (now - lastKeepaliveAt >= KEEPALIVE_MS) {
          lastKeepaliveAt = now;
          query('SELECT 1').catch(() => {});
        }
      },
      () => stopping,
    );
    if (!res || stopping) break;
    const pubkey = res.keypair.publicKey.toBase58();
    const encrypted = encryptSecret(Buffer.from(res.keypair.secretKey));
    // The keypair cost ~78 minutes of CPU: never drop it on a DB blip.
    // Retry the store until it lands or we are asked to stop.
    for (;;) {
      try {
        await storeVanityMint(pubkey, encrypted, Date.now());
        break;
      } catch (e) {
        console.error(
          `[grind-pool] db error on store of ${pubkey}, retrying in 60s: ${dbErrorMessage(e)}`,
        );
        await sleep(DB_RETRY_MS);
        if (stopping) break;
      }
    }
    if (stopping) break;
    const rate = res.durationMs > 0 ? Math.round((res.attempts / res.durationMs) * 1000) : 0;
    console.log(
      `[grind-pool] stored ${pubkey} — ${res.attempts.toLocaleString('en-US')} attempts ` +
        `in ${(res.durationMs / 1000).toFixed(1)}s (${rate.toLocaleString('en-US')}/s)`,
    );
    // Wipe the plaintext secret from memory as soon as it is stored.
    res.keypair.secretKey.fill(0);
  }
  console.log('[grind-pool] stopped');
}

main().catch((e) => {
  console.error('[grind-pool] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
