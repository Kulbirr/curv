import { execute, query, transaction } from './index';

/**
 * Coin duels: head to head graduation races. First coin to graduate
 * wins; the winner takes the loser's creator fee remainder for the
 * forfeit window. Terms are locked at accept time and immutable after.
 *
 * Settlement reads `pool_states.graduated_at` only, never the chain.
 * The fee forfeit is realized inside the loser's claim transaction
 * (see planDuelForfeit in fee-split-claim.ts); this module owns the
 * duel lifecycle and the forfeit payout ledger.
 */

export type DuelStatus =
  | 'challenged'
  | 'active'
  | 'settled'
  | 'expired'
  | 'cancelled'
  | 'drawn';

export interface Duel {
  id: number;
  poolA: string;
  poolB: string;
  challengerWallet: string;
  challengedWallet: string;
  status: DuelStatus;
  forfeitScope: string;
  forfeitDays: number;
  createdAt: number;
  activatedAt: number | null;
  expiresAt: number | null;
  settledAt: number | null;
  forfeitEndsAt: number | null;
  winnerPool: string | null;
  loserPool: string | null;
}

export interface DuelForfeitPayout {
  id: number;
  duelId: number;
  poolAddress: string;
  winnerWallet: string;
  baseAmountRaw: string;
  quoteAmountRaw: string;
  quoteMint: string;
  txSignature: string;
  paidAt: number;
}

/** Locked duel terms (user decisions): 90 day forfeit window, 30 day expiry. */
export const DUEL_FORFEIT_DAYS = 90;
export const DUEL_EXPIRY_DAYS = 30;
/** Both pools graduating inside this window is a draw, no fees move. */
export const DUEL_DRAW_WINDOW_MS = 60_000;

function rowToDuel(r: Record<string, any>): Duel {
  return {
    id: Number(r.id),
    poolA: String(r.pool_a),
    poolB: String(r.pool_b),
    challengerWallet: String(r.challenger_wallet),
    challengedWallet: String(r.challenged_wallet),
    status: r.status as DuelStatus,
    forfeitScope: String(r.forfeit_scope),
    forfeitDays: Number(r.forfeit_days),
    createdAt: Number(r.created_at),
    activatedAt: r.activated_at == null ? null : Number(r.activated_at),
    expiresAt: r.expires_at == null ? null : Number(r.expires_at),
    settledAt: r.settled_at == null ? null : Number(r.settled_at),
    forfeitEndsAt: r.forfeit_ends_at == null ? null : Number(r.forfeit_ends_at),
    winnerPool: r.winner_pool == null ? null : String(r.winner_pool),
    loserPool: r.loser_pool == null ? null : String(r.loser_pool),
  };
}

function rowToForfeitPayout(r: Record<string, any>): DuelForfeitPayout {
  return {
    id: Number(r.id),
    duelId: Number(r.duel_id),
    poolAddress: String(r.pool_address),
    winnerWallet: String(r.winner_wallet),
    baseAmountRaw: String(r.base_amount_raw),
    quoteAmountRaw: String(r.quote_amount_raw),
    quoteMint: String(r.quote_mint),
    txSignature: String(r.tx_signature),
    paidAt: Number(r.paid_at),
  };
}

// ---------------------------------------------------------------------------
// Pure settlement helpers (unit-tested, no DB)
// ---------------------------------------------------------------------------

export type DuelOutcome = 'a' | 'b' | 'draw' | 'none';

/**
 * Decide a duel from the two pools' first-graduation timestamps.
 * - Only A graduated → 'a'; only B → 'b'.
 * - Both graduated >= 60s apart → the earlier one wins.
 * - Both graduated within 60s → 'draw' (indexer sample ordering is arbitrary).
 * - Neither → 'none'.
 */
export function decideDuelOutcome(
  graduatedAtA: number | null,
  graduatedAtB: number | null,
): DuelOutcome {
  if (graduatedAtA == null && graduatedAtB == null) return 'none';
  if (graduatedAtA != null && graduatedAtB == null) return 'a';
  if (graduatedAtA == null && graduatedAtB != null) return 'b';
  const diff = Math.abs((graduatedAtA as number) - (graduatedAtB as number));
  if (diff < DUEL_DRAW_WINDOW_MS) return 'draw';
  return (graduatedAtA as number) < (graduatedAtB as number) ? 'a' : 'b';
}

/**
 * True when the forfeit redirect applies to a claim on `poolAddress`
 * right now: the duel is settled, this pool lost, and the forfeit
 * window is still open.
 */
export function forfeitApplies(poolAddress: string, duel: Duel, now: number): boolean {
  return (
    duel.status === 'settled' &&
    duel.loserPool === poolAddress &&
    duel.forfeitEndsAt != null &&
    now < duel.forfeitEndsAt
  );
}

/** The wallet the forfeit redirects to for a claim on the losing pool. */
export function forfeitWinnerWallet(duel: Duel): string | null {
  if (duel.status !== 'settled' || !duel.winnerPool) return null;
  return duel.winnerPool === duel.poolA ? duel.challengerWallet : duel.challengedWallet;
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export async function getDuel(id: number): Promise<Duel | null> {
  const rows = await query<Record<string, any>>('SELECT * FROM duels WHERE id = $1', [id]);
  return rows.length ? rowToDuel(rows[0]) : null;
}

/**
 * The pool's current live duel (challenged or active), or null. A pool
 * may be in at most one non-terminal duel at a time.
 */
export async function getActiveDuelForPool(poolAddress: string): Promise<Duel | null> {
  const rows = await query<Record<string, any>>(
    `SELECT * FROM duels
     WHERE (pool_a = $1 OR pool_b = $1) AND status IN ('challenged','active')
     ORDER BY created_at DESC LIMIT 1`,
    [poolAddress],
  );
  return rows.length ? rowToDuel(rows[0]) : null;
}

export interface CreateDuelInput {
  poolA: string;
  poolB: string;
  challengerWallet: string;
  challengedWallet: string;
}

export async function createDuel(input: CreateDuelInput): Promise<Duel> {
  if (!input.poolA || !input.poolB) throw new Error('Both pools are required');
  if (input.poolA === input.poolB) throw new Error('A pool cannot duel itself');
  return transaction(async (db) => {
    for (const pool of [input.poolA, input.poolB]) {
      const existing = await db.query(
        `SELECT id FROM duels
         WHERE (pool_a = $1 OR pool_b = $1) AND status IN ('challenged','active')
         LIMIT 1`,
        [pool],
      );
      if (existing.rows.length > 0) {
        throw new Error('One of the pools is already in a live duel');
      }
    }
    const now = Date.now();
    const rows = await db.query(
      `INSERT INTO duels
       (pool_a, pool_b, challenger_wallet, challenged_wallet, status,
        forfeit_scope, forfeit_days, created_at)
       VALUES ($1,$2,$3,$4,'challenged','creator_remainder_window',$5,$6)
       RETURNING *`,
      [input.poolA, input.poolB, input.challengerWallet, input.challengedWallet, DUEL_FORFEIT_DAYS, now],
    );
    return rowToDuel(rows.rows[0]);
  });
}

/**
 * Accept a challenge. Transactional: re-checks that both pools are still
 * ungraduated and that no competing duel appeared since the challenge.
 * Locks the terms (activated_at, expires_at) on accept.
 */
export async function acceptDuel(
  id: number,
  isGraduated: (poolAddress: string) => Promise<boolean>,
): Promise<Duel> {
  return transaction(async (db) => {
    const rows = await db.query('SELECT * FROM duels WHERE id = $1', [id]);
    if (rows.rows.length === 0) throw new Error('Duel not found');
    const duel = rowToDuel(rows.rows[0]);
    if (duel.status !== 'challenged') throw new Error('Duel is not awaiting accept');
    for (const pool of [duel.poolA, duel.poolB]) {
      if (await isGraduated(pool)) throw new Error('One of the pools has already graduated');
      const competing = await db.query(
        `SELECT id FROM duels
         WHERE id <> $2 AND (pool_a = $1 OR pool_b = $1)
           AND status IN ('challenged','active') LIMIT 1`,
        [pool, id],
      );
      if (competing.rows.length > 0) throw new Error('One of the pools entered another duel');
    }
    const now = Date.now();
    const updated = await db.query(
      `UPDATE duels SET status = 'active', activated_at = $2,
        expires_at = $3 WHERE id = $1 AND status = 'challenged' RETURNING *`,
      [id, now, now + DUEL_EXPIRY_DAYS * 24 * 3600_000],
    );
    if (updated.rows.length === 0) throw new Error('Duel was already accepted or cancelled');
    return rowToDuel(updated.rows[0]);
  });
}

async function setDuelStatus(id: number, status: DuelStatus, from: DuelStatus[]): Promise<Duel> {
  const rows = await query<Record<string, any>>(
    `UPDATE duels SET status = $2 WHERE id = $1 AND status = ANY($3) RETURNING *`,
    [id, status, from],
  );
  if (rows.length === 0) throw new Error('Duel not found or not in a cancellable state');
  return rowToDuel(rows[0]);
}

/** Challenger cancels before accept; challenged creator declines. Both → cancelled. */
export function cancelDuel(id: number): Promise<Duel> {
  return setDuelStatus(id, 'cancelled', ['challenged']);
}

export function declineDuel(id: number): Promise<Duel> {
  return setDuelStatus(id, 'cancelled', ['challenged']);
}

/**
 * Settle a duel. Idempotent: the UPDATE only fires on active duels, so
 * settling twice is a no-op returning the already-settled row.
 */
export async function settleDuel(
  id: number,
  winnerPool: string,
  loserPool: string,
): Promise<Duel | null> {
  const now = Date.now();
  const rows = await query<Record<string, any>>(
    `UPDATE duels SET status = 'settled', winner_pool = $2, loser_pool = $3,
       settled_at = $4, forfeit_ends_at = $5
     WHERE id = $1 AND status = 'active' RETURNING *`,
    [id, winnerPool, loserPool, now, now + DUEL_FORFEIT_DAYS * 24 * 3600_000],
  );
  if (rows.length === 0) {
    // Already settled/drawn/expired/cancelled: return current state.
    return getDuel(id);
  }
  return rowToDuel(rows[0]);
}

export async function drawDuel(id: number): Promise<Duel | null> {
  const rows = await query<Record<string, any>>(
    `UPDATE duels SET status = 'drawn', settled_at = $2
     WHERE id = $1 AND status = 'active' RETURNING *`,
    [id, Date.now()],
  );
  return rows.length ? rowToDuel(rows[0]) : getDuel(id);
}

/** Expire every active duel past its expiry. Returns the expired ids. */
export async function expireDuels(now: number): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `UPDATE duels SET status = 'expired'
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < $1
     RETURNING id`,
    [now],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * The pool's most recent settled duel, or null. Used by the claim
 * builder to decide whether a forfeit redirect applies.
 */
export async function getSettledDuelForPool(poolAddress: string): Promise<Duel | null> {
  const rows = await query<Record<string, any>>(
    `SELECT * FROM duels WHERE (pool_a = $1 OR pool_b = $1)
     AND status = 'settled' ORDER BY settled_at DESC LIMIT 1`,
    [poolAddress],
  );
  return rows.length ? rowToDuel(rows[0]) : null;
}
export async function listActiveDuels(): Promise<Duel[]> {
  const rows = await query<Record<string, any>>(
    `SELECT * FROM duels WHERE status = 'active' ORDER BY activated_at ASC`,
  );
  return rows.map(rowToDuel);
}

/** Fight card lineup: active first, then recently settled, then the rest. */
export async function listDuels(limit = 20): Promise<Duel[]> {
  const rows = await query<Record<string, any>>(
    `SELECT * FROM duels
     ORDER BY
       CASE status WHEN 'active' THEN 0 WHEN 'challenged' THEN 1
         WHEN 'settled' THEN 2 WHEN 'drawn' THEN 3 ELSE 4 END,
       COALESCE(settled_at, activated_at, created_at) DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map(rowToDuel);
}

export interface ForfeitPayoutInput {
  duelId: number;
  poolAddress: string;
  winnerWallet: string;
  baseAmountRaw: string;
  quoteAmountRaw: string;
  quoteMint: string;
  txSignature: string;
}

/** Append one verified forfeit payout to the ledger. Idempotent on tx signature. */
export async function recordForfeitPayout(input: ForfeitPayoutInput): Promise<void> {
  await execute(
    `INSERT INTO duel_forfeit_payouts
     (duel_id, pool_address, winner_wallet, base_amount_raw, quote_amount_raw,
      quote_mint, tx_signature, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tx_signature) DO NOTHING`,
    [
      input.duelId,
      input.poolAddress,
      input.winnerWallet,
      input.baseAmountRaw,
      input.quoteAmountRaw,
      input.quoteMint,
      input.txSignature,
      Date.now(),
    ],
  );
}

export async function getForfeitPayouts(duelId: number): Promise<DuelForfeitPayout[]> {
  const rows = await query<Record<string, any>>(
    `SELECT * FROM duel_forfeit_payouts WHERE duel_id = $1 ORDER BY paid_at DESC`,
    [duelId],
  );
  return rows.map(rowToForfeitPayout);
}

/** Total forfeited quote (raw) so far, for the "redirected to the winner" figure. */
export async function getForfeitTotals(duelId: number): Promise<{ baseRaw: string; quoteRaw: string }> {
  const rows = await query<{ base_raw: string | null; quote_raw: string | null }>(
    `SELECT SUM(base_amount_raw::numeric) AS base_raw,
            SUM(quote_amount_raw::numeric) AS quote_raw
     FROM duel_forfeit_payouts WHERE duel_id = $1`,
    [duelId],
  );
  return {
    baseRaw: rows[0]?.base_raw ? BigInt(rows[0].base_raw).toString() : '0',
    quoteRaw: rows[0]?.quote_raw ? BigInt(rows[0].quote_raw).toString() : '0',
  };
}
