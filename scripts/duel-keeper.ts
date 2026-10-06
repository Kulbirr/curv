/**
 * Coin duel keeper.
 *
 * Every 5 minutes:
 *   1. Expires active duels past their expiry (30 days, neither graduated).
 *   2. Settles active duels from pool_states.graduated_at:
 *      earlier graduation wins; both within 60s is a draw; neither
 *      graduated yet stays active.
 *   3. Writes notifications to both creators on settle/draw/expire.
 *
 * Reads the database only. No chain calls, no secrets, no payouts:
 * the forfeit is realized inside the loser's own claim transaction,
 * never by the keeper. Idempotent: settling an already-settled duel
 * is a no-op.
 *
 * Runs with plain `node` (Node 24 type stripping).
 *
 * Usage:
 *   DATABASE_URL=<redacted> node scripts/duel-keeper.ts
 */

import { randomUUID } from 'crypto';
import {
  decideDuelOutcome,
  drawDuel,
  expireDuels,
  listActiveDuels,
  settleDuel,
  type Duel,
} from '../src/lib/db/duels.ts';
import { getPoolState } from '../src/lib/db/states.ts';
import { insertNotification } from '../src/lib/db/notifications.ts';

async function notify(wallet: string, type: string, title: string, body: string, link: string) {
  try {
    await insertNotification({ id: randomUUID(), wallet, type, title, body, link });
  } catch (e) {
    console.error(`[duel-keeper] notify failed for ${wallet}:`, (e as Error).message);
  }
}

async function settleOne(duel: Duel): Promise<void> {
  const [stateA, stateB] = await Promise.all([
    getPoolState(duel.poolA),
    getPoolState(duel.poolB),
  ]);
  const outcome = decideDuelOutcome(
    stateA?.graduatedAt ?? null,
    stateB?.graduatedAt ?? null,
  );
  const link = `/duels/${duel.id}`;

  if (outcome === 'none') return; // Still racing.

  if (outcome === 'draw') {
    const drawn = await drawDuel(duel.id);
    if (drawn?.status === 'drawn') {
      console.log(`[duel-keeper] duel ${duel.id} drawn: both pools graduated within 60s`);
      await notify(duel.challengerWallet, 'duel_draw', 'Duel drawn',
        'Both coins graduated within a minute of each other. No fees move.', link);
      await notify(duel.challengedWallet, 'duel_draw', 'Duel drawn',
        'Both coins graduated within a minute of each other. No fees move.', link);
    }
    return;
  }

  const winnerPool = outcome === 'a' ? duel.poolA : duel.poolB;
  const loserPool = outcome === 'a' ? duel.poolB : duel.poolA;
  const winnerWallet = outcome === 'a' ? duel.challengerWallet : duel.challengedWallet;
  const settled = await settleDuel(duel.id, winnerPool, loserPool);
  if (settled?.status === 'settled') {
    console.log(`[duel-keeper] duel ${duel.id} settled: winner ${winnerPool}`);
    await notify(winnerWallet, 'duel_won', 'Duel won',
      'Your coin graduated first. The loser\u2019s creator fees come to you for 90 days.', link);
    const loserWallet = outcome === 'a' ? duel.challengedWallet : duel.challengerWallet;
    await notify(loserWallet, 'duel_lost', 'Duel lost',
      'The rival coin graduated first. Your creator fees go to the winner for 90 days.', link);
  }
}

async function main(): Promise<void> {
  const now = Date.now();

  const expired = await expireDuels(now);
  for (const id of expired) {
    console.log(`[duel-keeper] duel ${id} expired: 30 days, neither graduated`);
    // Notify both creators. Fetch the duel for wallet addresses.
    const { getDuel } = await import('../src/lib/db/duels.ts');
    const duel = await getDuel(id);
    if (duel) {
      const link = `/duels/${duel.id}`;
      await notify(duel.challengerWallet, 'duel_expired', 'Duel expired',
        'Neither coin graduated in 30 days. No fees move.', link);
      await notify(duel.challengedWallet, 'duel_expired', 'Duel expired',
        'Neither coin graduated in 30 days. No fees move.', link);
    }
  }

  const active = await listActiveDuels();
  for (const duel of active) {
    try {
      await settleOne(duel);
    } catch (e) {
      console.error(`[duel-keeper] duel ${duel.id} failed:`, (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error('[duel-keeper] fatal:', e);
  process.exit(1);
});
