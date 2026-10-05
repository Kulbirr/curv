import { createHash } from 'crypto';
import { execute, query, transaction } from './index';
import type { DbClient } from './index';

/**
 * Shill-to-Earn bounties: creators fund prize pools from their fee
 * share; anyone posts about the token on X with a hashtag, gets ranked
 * by engagement, and winners are paid to their X handle through the
 * existing handle-claim flow.
 *
 * Funding: `bounty_bps` is an immutable launch parameter on pools,
 * exactly like `buyback_bps`. At claim time the claim builder diverts
 * the bounty slice to the bounty vault atomically, and the deposit API
 * records it here (verified on-chain). Prize budgets are caps: actual
 * payouts are min(budget, accrued balance).
 */

export interface BountyWeights {
  likes: number;
  retweets: number;
  replies: number;
  views: number;
}

export interface Bounty {
  id: number;
  poolAddress: string;
  creatorWallet: string;
  title: string;
  description: string | null;
  hashtag: string;
  keyword: string | null;
  prizeBudgetRaw: string;
  prizeMint: string;
  winnerCount: number;
  prizeSplits: number[];
  weights: BountyWeights;
  startsAt: number;
  endsAt: number;
  status: 'active' | 'finalizing' | 'finalized' | 'cancelled';
  createdAt: number;
  finalizedAt: number | null;
}

export interface BountyEntry {
  id: number;
  bountyId: number;
  tweetId: string;
  authorHandle: string;
  authorHandleDisplay: string;
  tweetText: string;
  submittedAt: number;
  disqualified: boolean;
  disqualifyReason: string | null;
}

export interface BountySnapshot {
  id: number;
  entryId: number;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  score: string;
  takenAt: number;
  source: string;
}

export interface BountyWinner {
  id: number;
  bountyId: number;
  entryId: number;
  authorHandle: string;
  rank: number;
  prizeRaw: string;
  boundWallet: string | null;
  claimedAt: number | null;
  payoutTx: string | null;
}

export interface LeaderboardRow {
  entry: BountyEntry;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  score: string;
  takenAt: number | null;
}

/** Engagement score: likes*1 + retweets*3 + replies*2 + floor(views/100)*viewsWeight. */
export function engagementScore(
  e: { likes: number; retweets: number; replies: number; views: number },
  w: BountyWeights,
): string {
  const s =
    BigInt(Math.max(0, Math.floor(e.likes))) * BigInt(w.likes) +
    BigInt(Math.max(0, Math.floor(e.retweets))) * BigInt(w.retweets) +
    BigInt(Math.max(0, Math.floor(e.replies))) * BigInt(w.replies) +
    BigInt(Math.floor(Math.max(0, e.views) / 100)) * BigInt(w.views);
  return s.toString();
}

/** Compare two score strings: >0 when a ranks above b. */
export function compareScores(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x > y ? 1 : x < y ? -1 : 0;
}

/** Normalize a hashtag: lowercase, no leading #, must match [a-z0-9_]{2,40}. */
export function normalizeHashtag(raw: string): string | null {
  const h = String(raw || '').trim().toLowerCase().replace(/^#+/, '');
  return /^[a-z0-9_]{2,40}$/.test(h) ? h : null;
}

/** True when the tweet text contains #hashtag (case-insensitive). */
export function tweetHasHashtag(text: string, hashtag: string): boolean {
  return new RegExp(`#${hashtag}\\b`, 'i').test(String(text || ''));
}

export interface CreateBountyInput {
  poolAddress: string;
  creatorWallet: string;
  title: string;
  description?: string;
  hashtag: string;
  keyword?: string;
  prizeBudgetRaw: string;
  prizeMint: string;
  winnerCount: number;
  prizeSplits: number[];
  weights: BountyWeights;
  startsAt: number;
  endsAt: number;
}

function rowToBounty(r: Record<string, unknown>): Bounty {
  return {
    id: r.id as number,
    poolAddress: r.pool_address as string,
    creatorWallet: r.creator_wallet as string,
    title: r.title as string,
    description: (r.description as string) ?? null,
    hashtag: r.hashtag as string,
    keyword: (r.keyword as string) ?? null,
    prizeBudgetRaw: r.prize_budget_raw as string,
    prizeMint: r.prize_mint as string,
    winnerCount: r.winner_count as number,
    prizeSplits: JSON.parse(r.prize_splits as string) as number[],
    weights: {
      likes: r.weight_likes as number,
      retweets: r.weight_retweets as number,
      replies: r.weight_replies as number,
      views: r.weight_views as number,
    },
    startsAt: r.starts_at as number,
    endsAt: r.ends_at as number,
    status: r.status as Bounty['status'],
    createdAt: r.created_at as number,
    finalizedAt: (r.finalized_at as number) ?? null,
  };
}

function rowToEntry(r: Record<string, unknown>): BountyEntry {
  return {
    id: r.id as number,
    bountyId: r.bounty_id as number,
    tweetId: r.tweet_id as string,
    authorHandle: r.author_handle as string,
    authorHandleDisplay: r.author_handle_display as string,
    tweetText: r.tweet_text as string,
    submittedAt: r.submitted_at as number,
    disqualified: !!r.disqualified,
    disqualifyReason: (r.disqualify_reason as string) ?? null,
  };
}

function rowToWinner(r: Record<string, unknown>): BountyWinner {
  return {
    id: r.id as number,
    bountyId: r.bounty_id as number,
    entryId: r.entry_id as number,
    authorHandle: r.author_handle as string,
    rank: r.rank as number,
    prizeRaw: r.prize_raw as string,
    boundWallet: (r.bound_wallet as string) ?? null,
    claimedAt: (r.claimed_at as number) ?? null,
    payoutTx: (r.payout_tx as string) ?? null,
  };
}

export async function createBounty(input: CreateBountyInput): Promise<Bounty> {
  if (!input.title || input.title.trim().length === 0) throw new Error('title is required');
  const hashtag = normalizeHashtag(input.hashtag);
  if (!hashtag) throw new Error('hashtag must be 2-40 chars of letters, numbers, or underscores');
  if (!Number.isInteger(input.winnerCount) || input.winnerCount < 1 || input.winnerCount > 20) {
    throw new Error('winnerCount must be an integer between 1 and 20');
  }
  if (!Array.isArray(input.prizeSplits) || input.prizeSplits.length !== input.winnerCount) {
    throw new Error('prizeSplits must have one entry per winner');
  }
  const splitSum = input.prizeSplits.reduce((s, n) => s + n, 0);
  if (input.prizeSplits.some((n) => !Number.isInteger(n) || n <= 0) || splitSum !== 10000) {
    throw new Error('prizeSplits must be positive integers summing to 10000');
  }
  if (!/^[1-9][0-9]*$/.test(input.prizeBudgetRaw)) throw new Error('prizeBudgetRaw must be a positive integer');
  if (input.endsAt <= input.startsAt) throw new Error('endsAt must be after startsAt');
  if (input.endsAt - input.startsAt > 30 * 24 * 3600_000) throw new Error('Bounty duration is capped at 30 days');

  const rows = await query<Record<string, unknown>>(
    `INSERT INTO bounties
     (pool_address, creator_wallet, title, description, hashtag, keyword,
      prize_budget_raw, prize_mint, winner_count, prize_splits,
      weight_likes, weight_retweets, weight_replies, weight_views,
      starts_at, ends_at, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active',$17)
     RETURNING *`,
    [
      input.poolAddress,
      input.creatorWallet,
      input.title.trim().slice(0, 120),
      input.description?.trim().slice(0, 2000) ?? null,
      hashtag,
      input.keyword?.trim().slice(0, 120) || null,
      input.prizeBudgetRaw,
      input.prizeMint,
      input.winnerCount,
      JSON.stringify(input.prizeSplits),
      input.weights.likes,
      input.weights.retweets,
      input.weights.replies,
      input.weights.views,
      input.startsAt,
      input.endsAt,
      Date.now(),
    ],
  );
  return rowToBounty(rows[0]);
}

export async function getBounty(id: number): Promise<Bounty | null> {
  const rows = await query<Record<string, unknown>>('SELECT * FROM bounties WHERE id = $1', [id]);
  return rows.length ? rowToBounty(rows[0]) : null;
}

export async function listBounties(poolAddress: string): Promise<Bounty[]> {
  const rows = await query<Record<string, unknown>>(
    'SELECT * FROM bounties WHERE pool_address = $1 ORDER BY created_at DESC',
    [poolAddress],
  );
  return rows.map(rowToBounty);
}

/** True when the pool has an active (not final) round. */
export async function hasActiveBounty(poolAddress: string): Promise<boolean> {
  const rows = await query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM bounties WHERE pool_address = $1 AND status IN ('active','finalizing')",
    [poolAddress],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

/** Bounty ids with ends_at passed and still active, for the keeper. */
export async function listBountiesDueForFinalize(nowMs: number): Promise<Bounty[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM bounties WHERE status = 'active' AND ends_at <= $1 ORDER BY ends_at ASC",
    [nowMs],
  );
  return rows.map(rowToBounty);
}

/** Active bounties needing engagement snapshots. */
export async function listActiveBounties(): Promise<Bounty[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM bounties WHERE status = 'active' ORDER BY ends_at ASC",
  );
  return rows.map(rowToBounty);
}

export async function setBountyStatus(id: number, status: Bounty['status']): Promise<void> {
  await execute(
    'UPDATE bounties SET status = $1, finalized_at = CASE WHEN $1 IN (\'finalized\',\'cancelled\') THEN $2 ELSE finalized_at END WHERE id = $3',
    [status, Date.now(), id],
  );
}

/**
 * Submit a tweet. Upserts on (bounty_id, author_handle): one entry per
 * handle, the second tweet replaces the first but keeps the earliest
 * submitted_at. Returns the entry row.
 */
export async function upsertEntry(bountyId: number, v: {
  tweetId: string;
  authorHandle: string;
  authorHandleDisplay: string;
  tweetText: string;
}): Promise<BountyEntry> {
  const now = Date.now();
  const handle = v.authorHandle.toLowerCase();
  const rows = await query<Record<string, unknown>>(
    `INSERT INTO bounty_entries
     (bounty_id, tweet_id, author_handle, author_handle_display, tweet_text, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (bounty_id, author_handle) DO UPDATE SET
       tweet_id = EXCLUDED.tweet_id,
       author_handle_display = EXCLUDED.author_handle_display,
       tweet_text = EXCLUDED.tweet_text,
       disqualified = FALSE,
       disqualify_reason = NULL
     RETURNING *`,
    [bountyId, v.tweetId, handle, v.authorHandleDisplay, v.tweetText.slice(0, 4000), now],
  );
  return rowToEntry(rows[0]);
}

/** On conflict with an existing tweet_id (resubmitted tweet), update the handle entry. */
export async function findEntryByTweet(bountyId: number, tweetId: string): Promise<BountyEntry | null> {
  const rows = await query<Record<string, unknown>>(
    'SELECT * FROM bounty_entries WHERE bounty_id = $1 AND tweet_id = $2',
    [bountyId, tweetId],
  );
  return rows.length ? rowToEntry(rows[0]) : null;
}

export async function listEntries(bountyId: number): Promise<BountyEntry[]> {
  const rows = await query<Record<string, unknown>>(
    'SELECT * FROM bounty_entries WHERE bounty_id = $1 ORDER BY submitted_at ASC',
    [bountyId],
  );
  return rows.map(rowToEntry);
}

export async function disqualifyEntry(entryId: number, reason: string): Promise<void> {
  await execute('UPDATE bounty_entries SET disqualified = TRUE, disqualify_reason = $1 WHERE id = $2', [
    reason,
    entryId,
  ]);
}

export async function recordSnapshot(
  entryId: number,
  e: { likes: number; retweets: number; replies: number; views: number },
  score: string,
  source = 'fxtwitter',
): Promise<void> {
  await execute(
    `INSERT INTO bounty_snapshots (entry_id, likes, retweets, replies, views, score, taken_at, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entryId, e.likes, e.retweets, e.replies, e.views, score, Date.now(), source],
  );
}

/** Leaderboard: latest snapshot per entry, ordered by score desc, submitted_at tie-break. */
export async function getLeaderboard(bountyId: number, limit = 50, offset = 0): Promise<LeaderboardRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT e.*, s.likes, s.retweets, s.replies, s.views, s.score, s.taken_at
     FROM bounty_entries e
     LEFT JOIN LATERAL (
       SELECT likes, retweets, replies, views, score, taken_at
       FROM bounty_snapshots WHERE entry_id = e.id ORDER BY taken_at DESC LIMIT 1
     ) s ON TRUE
     WHERE e.bounty_id = $1 AND e.disqualified = FALSE
     ORDER BY COALESCE(s.score::numeric, 0) DESC, e.submitted_at ASC
     LIMIT $2 OFFSET $3`,
    [bountyId, limit, offset],
  );
  return rows.map((r) => ({
    entry: rowToEntry(r),
    likes: (r.likes as number) ?? 0,
    retweets: (r.retweets as number) ?? 0,
    replies: (r.replies as number) ?? 0,
    views: (r.views as number) ?? 0,
    score: (r.score as string) ?? '0',
    takenAt: (r.taken_at as number) ?? null,
  }));
}

export async function countEntries(bountyId: number): Promise<number> {
  const rows = await query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM bounty_entries WHERE bounty_id = $1 AND disqualified = FALSE',
    [bountyId],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Finalize: rank non-disqualified entries, compute prizes, write
 * winners. Idempotent: returns existing winners when already
 * finalized. Runs in one transaction.
 */
export async function finalizeBounty(
  bounty: Bounty,
  snap: (entry: BountyEntry) => Promise<{ likes: number; retweets: number; replies: number; views: number } | null>,
  availableRaw: string,
): Promise<BountyWinner[]> {
  return transaction(async (db) => {
    const existing = await db.query('SELECT * FROM bounty_winners WHERE bounty_id = $1 ORDER BY rank ASC', [
      bounty.id,
    ]);
    if (existing.rowCount && existing.rowCount > 0) {
      return (existing.rows as Record<string, unknown>[]).map(rowToWinner);
    }
    await db.query("UPDATE bounties SET status = 'finalizing' WHERE id = $1", [bounty.id]);

    const entryRows = (await db.query('SELECT * FROM bounty_entries WHERE bounty_id = $1', [bounty.id]))
      .rows as Record<string, unknown>[];
    const entries = entryRows.map(rowToEntry);

    // Final snapshot pass; unavailable tweets are disqualified.
    for (const entry of entries) {
      if (entry.disqualified) continue;
      const eng = await snap(entry);
      if (!eng) {
        await db.query('UPDATE bounty_entries SET disqualified = TRUE, disqualify_reason = $1 WHERE id = $2', [
          'tweet_unavailable',
          entry.id,
        ]);
        continue;
      }
      const score = engagementScore(eng, bounty.weights);
      await db.query(
        `INSERT INTO bounty_snapshots (entry_id, likes, retweets, replies, views, score, taken_at, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'fxtwitter')`,
        [entry.id, eng.likes, eng.retweets, eng.replies, eng.views, score, Date.now()],
      );
    }

    // Creator's own handle cannot win.
    const creatorHandle = await creatorHandleForPool(db, bounty.poolAddress);
    const ranked = (
      await db.query(
        `SELECT e.*, s.score FROM bounty_entries e
         JOIN LATERAL (
           SELECT score FROM bounty_snapshots WHERE entry_id = e.id ORDER BY taken_at DESC LIMIT 1
         ) s ON TRUE
         WHERE e.bounty_id = $1 AND e.disqualified = FALSE
         ORDER BY s.score::numeric DESC, e.submitted_at ASC`,
        [bounty.id],
      )
    ).rows as Record<string, unknown>[];

    const winners: BountyWinner[] = [];
    const budget = BigInt(availableRaw);
    const cap = BigInt(bounty.prizeBudgetRaw) > budget ? budget : BigInt(bounty.prizeBudgetRaw);
    const slots = Math.min(bounty.winnerCount, ranked.length);
    for (let i = 0; i < slots; i++) {
      const r = ranked[i];
      const entry = rowToEntry(r);
      if (creatorHandle && entry.authorHandle === creatorHandle) {
        await db.query('UPDATE bounty_entries SET disqualified = TRUE, disqualify_reason = $1 WHERE id = $2', [
          'creator_self_entry',
          entry.id,
        ]);
        continue;
      }
      const prizeRaw = ((cap * BigInt(bounty.prizeSplits[winners.length])) / BigInt(10000)).toString();
      const rank = winners.length + 1;
      const wrows = (await db.query(
        `INSERT INTO bounty_winners (bounty_id, entry_id, author_handle, rank, prize_raw)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [bounty.id, entry.id, entry.authorHandle, rank, prizeRaw],
      )).rows as Record<string, unknown>[];
      winners.push(rowToWinner(wrows[0]));
    }
    await db.query("UPDATE bounties SET status = 'finalized', finalized_at = $1 WHERE id = $2", [
      Date.now(),
      bounty.id,
    ]);
    return winners;
  });
}

/** Creator's linked X handle for a pool, lowercase, or null. Best-effort. */
async function creatorHandleForPool(db: DbClient, poolAddress: string): Promise<string | null> {
  try {
    const res = await db.query('SELECT twitter FROM pools WHERE pool_address = $1', [poolAddress]);
    const t = (res.rows[0] as { twitter: string | null } | undefined)?.twitter;
    if (!t) return null;
    const m = String(t).match(/(?:x\.com|twitter\.com)\/(\w{1,15})/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function getWinners(bountyId: number): Promise<BountyWinner[]> {
  const rows = await query<Record<string, unknown>>(
    'SELECT * FROM bounty_winners WHERE bounty_id = $1 ORDER BY rank ASC',
    [bountyId],
  );
  return rows.map(rowToWinner);
}

/** Deterministic verification code for a winner (different domain than fee splits). */
export function bountyCodeFor(bountyId: number, winnerId: number): string {
  // Reuse the same 6-char scheme as tweetCodeFor with a bounty domain.
  const hash = createHash('sha256').update(`${bountyId}:${winnerId}:curv-bounty-bind`).digest();
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let n = hash.readUInt32BE(0) & 0x3fffffff;
  let out = '';
  for (let i = 0; i < 6; i++) {
    out = alphabet[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return `CURV-${out}`;
}

export async function bindWinnerWallet(winnerId: number, wallet: string): Promise<boolean> {
  const n = await execute(
    'UPDATE bounty_winners SET bound_wallet = $1 WHERE id = $2 AND bound_wallet IS NULL',
    [wallet, winnerId],
  );
  return n === 1;
}

export async function getWinnerById(winnerId: number): Promise<BountyWinner | null> {
  const rows = await query<Record<string, unknown>>('SELECT * FROM bounty_winners WHERE id = $1', [winnerId]);
  return rows.length ? rowToWinner(rows[0]) : null;
}

/** Unclaimed bounty winnings for an X handle (claim page inbox). */
export async function getUnclaimedWinnings(handle: string): Promise<
  Array<{ bountyId: number; rank: number; prizeRaw: string; prizeMint: string; bound: boolean }>
> {
  const rows = await query<Record<string, unknown>>(
    `SELECT w.bounty_id, w.rank, w.prize_raw, b.prize_mint,
            (w.bound_wallet IS NOT NULL) AS bound
     FROM bounty_winners w JOIN bounties b ON b.id = w.bounty_id
     WHERE w.author_handle = $1 AND w.claimed_at IS NULL
     ORDER BY w.bounty_id DESC`,
    [handle.toLowerCase()],
  );
  return rows.map((r) => ({
    bountyId: r.bounty_id as number,
    rank: r.rank as number,
    prizeRaw: r.prize_raw as string,
    prizeMint: r.prize_mint as string,
    bound: !!r.bound,
  }));
}

/** Winners ready for payout: bound, unpaid. */
export async function listPayableWinners(): Promise<Array<BountyWinner & { prizeMint: string; poolAddress: string }>> {
  const rows = await query<Record<string, unknown>>(
    `SELECT w.*, b.prize_mint, b.pool_address
     FROM bounty_winners w JOIN bounties b ON b.id = w.bounty_id
     WHERE w.bound_wallet IS NOT NULL AND w.claimed_at IS NULL`,
  );
  return rows.map((r) => ({
    ...rowToWinner(r),
    prizeMint: r.prize_mint as string,
    poolAddress: r.pool_address as string,
  }));
}

export async function recordPayout(winnerId: number, amountRaw: string, txSignature: string): Promise<boolean> {
  return transaction(async (db) => {
    const p = await db.query(
      `INSERT INTO bounty_payouts (winner_id, amount_raw, tx_signature, paid_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT (winner_id) DO NOTHING`,
      [winnerId, amountRaw, txSignature, Date.now()],
    );
    if ((p.rowCount ?? 0) === 0) return false;
    await db.query('UPDATE bounty_winners SET claimed_at = $1, payout_tx = $2 WHERE id = $3', [
      Date.now(),
      txSignature,
      winnerId,
    ]);
    return true;
  });
}

/** Verified bounty deposit. Idempotent on tx_signature. */
export async function recordBountyDeposit(
  poolAddress: string,
  quoteMint: string,
  amountRaw: string,
  txSignature: string,
): Promise<boolean> {
  const n = await execute(
    `INSERT INTO bounty_deposits (pool_address, quote_mint, amount_raw, tx_signature, created_at)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tx_signature) DO NOTHING`,
    [poolAddress, quoteMint, amountRaw, txSignature, Date.now()],
  );
  return n === 1;
}

export async function getBountyDepositTotal(poolAddress: string): Promise<string> {
  const rows = await query<{ total: string | null }>(
    'SELECT SUM(amount_raw::numeric) as total FROM bounty_deposits WHERE pool_address = $1',
    [poolAddress],
  );
  const total = rows[0]?.total;
  return total ? BigInt(total).toString() : '0';
}

export async function getBountyPaidTotal(poolAddress: string): Promise<string> {
  const rows = await query<{ total: string | null }>(
    `SELECT SUM(p.amount_raw::numeric) as total FROM bounty_payouts p
     JOIN bounty_winners w ON w.id = p.winner_id
     JOIN bounties b ON b.id = w.bounty_id
     WHERE b.pool_address = $1`,
    [poolAddress],
  );
  const total = rows[0]?.total;
  return total ? BigInt(total).toString() : '0';
}

/** Funded balance for a pool: deposits minus payouts, never negative. */
export async function getBountyBalance(poolAddress: string): Promise<string> {
  const dep = BigInt(await getBountyDepositTotal(poolAddress));
  const paid = BigInt(await getBountyPaidTotal(poolAddress));
  const bal = dep - paid;
  return (bal > BigInt(0) ? bal : BigInt(0)).toString();
}
