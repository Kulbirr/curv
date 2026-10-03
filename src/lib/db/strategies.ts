import { execute, query } from './index';
import type { SignalInput, SignalOutcome, StrategySignal, StrategySubscription } from '../strategies';

/**
 * Storage half of the strategy mirror feed. Signals are written by the
 * admin publish route and never edited; subscriptions are written by the
 * subscribe route after on chain verification of the SOL payment. Nothing
 * here moves funds.
 */

export async function insertStrategySignal(
  input: SignalInput & { aiApproved?: boolean; aiReasons?: string[] | null },
): Promise<StrategySignal> {
  const { newSignalId } = await import('../strategies');
  const now = Date.now();
  const signal: StrategySignal = {
    ...input,
    id: newSignalId(),
    status: 'active',
    createdAt: now,
    aiApproved: input.aiApproved ?? false,
    aiReasons: input.aiReasons ?? null,
    outcome: 'pending',
    resolvedAt: null,
    resolvedPrice: null,
  };
  await execute(
    `INSERT INTO strategy_signals
       (id, base_mint, quote_mint, base_symbol, quote_symbol,
        base_decimals, quote_decimals, entry_price, max_price,
        size_text, note, status, expires_at, created_at,
        ai_approved, ai_reasons, stop_price, targets,
        outcome, resolved_at, resolved_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending',NULL,NULL)`,
    [
      signal.id,
      signal.baseMint,
      signal.quoteMint,
      signal.baseSymbol,
      signal.quoteSymbol,
      signal.baseDecimals,
      signal.quoteDecimals,
      signal.entryPrice,
      signal.maxPrice,
      signal.sizeText,
      signal.note,
      signal.status,
      signal.expiresAt,
      signal.createdAt,
      signal.aiApproved ? 1 : 0,
      signal.aiReasons ? JSON.stringify(signal.aiReasons) : null,
      input.stopPrice,
      input.targets ? JSON.stringify(input.targets) : null,
    ],
  );
  return signal;
}

interface SignalRow {
  id: string;
  base_mint: string;
  quote_mint: string;
  base_symbol: string;
  quote_symbol: string;
  base_decimals: number;
  quote_decimals: number;
  entry_price: number;
  max_price: number;
  size_text: string | null;
  note: string | null;
  status: string;
  expires_at: number;
  created_at: number;
  ai_approved: number;
  ai_reasons: string | null;
  stop_price: number | null;
  targets: string | null;
  outcome: string;
  resolved_at: number | null;
  resolved_price: number | null;
}

function parseTargets(value: string | null): number[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const nums = parsed.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    return nums.length > 0 ? nums : null;
  } catch {
    return null;
  }
}

function parseOutcome(value: string): SignalOutcome {
  return value === 'win' || value === 'loss' || value === 'expired' ? value : 'pending';
}

function parseAiReasons(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const reasons = parsed.filter((r): r is string => typeof r === 'string');
    return reasons.length > 0 ? reasons : null;
  } catch {
    return null;
  }
}

function rowToSignal(r: SignalRow): StrategySignal {
  return {
    id: r.id,
    baseMint: r.base_mint,
    baseSymbol: r.base_symbol,
    quoteMint: r.quote_mint,
    quoteSymbol: r.quote_symbol,
    baseDecimals: r.base_decimals,
    quoteDecimals: r.quote_decimals,
    entryPrice: r.entry_price,
    maxPrice: r.max_price,
    side: 'buy',
    sizeText: r.size_text,
    note: r.note,
    status: r.status === 'cancelled' ? 'cancelled' : 'active',
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    aiApproved: r.ai_approved === 1,
    aiReasons: parseAiReasons(r.ai_reasons),
    stopPrice: r.stop_price,
    targets: parseTargets(r.targets),
    outcome: parseOutcome(r.outcome),
    resolvedAt: r.resolved_at,
    resolvedPrice: r.resolved_price,
  };
}

/** Signals still awaiting a verdict: live or recently expired, outcome pending. */
export async function listSignalsAwaitingResolution(nowMs: number): Promise<StrategySignal[]> {
  const rows = await query<SignalRow>(
    `SELECT id, base_mint, quote_mint, base_symbol, quote_symbol,
            base_decimals, quote_decimals, entry_price, max_price,
            size_text, note, status, expires_at, created_at,
            ai_approved, ai_reasons, stop_price, targets,
            outcome, resolved_at, resolved_price
     FROM strategy_signals
     WHERE outcome = 'pending' AND status = 'active'
     ORDER BY created_at ASC`,
    [],
  );
  return rows.map(rowToSignal);
}

/** Resolve a signal once: win/loss/expired with the resolving price. */
export async function resolveSignal(
  id: string,
  outcome: 'win' | 'loss' | 'expired',
  resolvedAt: number,
  resolvedPrice: number | null,
): Promise<boolean> {
  const n = await execute(
    `UPDATE strategy_signals
     SET outcome = $2, resolved_at = $3, resolved_price = $4
     WHERE id = $1 AND outcome = 'pending'`,
    [id, outcome, resolvedAt, resolvedPrice],
  );
  return n === 1;
}

export interface TrackRecord {
  wins: number;
  losses: number;
  expired: number;
  pending: number;
  /** wins / (wins + losses), null until at least one signal resolves. */
  winRate: number | null;
}

/** Public track record: expired-untouched signals stay neutral, excluded from the rate. */
export async function getTrackRecord(): Promise<TrackRecord> {
  const rows = await query<{ outcome: string; c: number }>(
    `SELECT outcome, COUNT(*) AS c FROM strategy_signals GROUP BY outcome`,
    [],
  );
  let wins = 0;
  let losses = 0;
  let expired = 0;
  let pending = 0;
  for (const r of rows) {
    const c = Number(r.c);
    if (r.outcome === 'win') wins = c;
    else if (r.outcome === 'loss') losses = c;
    else if (r.outcome === 'expired') expired = c;
    else pending = c;
  }
  const decided = wins + losses;
  return { wins, losses, expired, pending, winRate: decided > 0 ? wins / decided : null };
}

/** Resolved signals, newest first, for the public history list. */
export async function listResolvedSignals(limit: number): Promise<StrategySignal[]> {
  const rows = await query<SignalRow>(
    `SELECT id, base_mint, quote_mint, base_symbol, quote_symbol,
            base_decimals, quote_decimals, entry_price, max_price,
            size_text, note, status, expires_at, created_at,
            ai_approved, ai_reasons, stop_price, targets,
            outcome, resolved_at, resolved_price
     FROM strategy_signals
     WHERE outcome IN ('win', 'loss', 'expired')
     ORDER BY resolved_at DESC NULLS LAST, created_at DESC
     LIMIT $1`,
    [Math.max(1, Math.min(50, Math.floor(limit)))],
  );
  return rows.map(rowToSignal);
}

/** Only live signals: active and not yet expired, newest first. */
export async function listLiveSignals(nowMs: number): Promise<StrategySignal[]> {
  const rows = await query<SignalRow>(
    `SELECT id, base_mint, quote_mint, base_symbol, quote_symbol,
            base_decimals, quote_decimals, entry_price, max_price,
            size_text, note, status, expires_at, created_at,
            ai_approved, ai_reasons, stop_price, targets,
            outcome, resolved_at, resolved_price
     FROM strategy_signals
     WHERE status = 'active' AND expires_at > $1
     ORDER BY created_at DESC`,
    [nowMs],
  );
  return rows.map(rowToSignal);
}

export async function getSignal(id: string): Promise<StrategySignal | null> {
  const rows = await query<SignalRow>(
    `SELECT id, base_mint, quote_mint, base_symbol, quote_symbol,
            base_decimals, quote_decimals, entry_price, max_price,
            size_text, note, status, expires_at, created_at,
            ai_approved, ai_reasons, stop_price, targets,
            outcome, resolved_at, resolved_price
     FROM strategy_signals WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToSignal(rows[0]) : null;
}

export async function cancelSignal(id: string): Promise<boolean> {
  const n = await execute(`UPDATE strategy_signals SET status = 'cancelled' WHERE id = $1`, [id]);
  return n === 1;
}

export async function getSubscription(wallet: string): Promise<StrategySubscription | null> {
  const rows = await query<{ wallet: string; expires_at: number; tx_signature: string | null; created_at: number }>(
    'SELECT wallet, expires_at, tx_signature, created_at FROM strategy_subscriptions WHERE wallet = $1',
    [wallet],
  );
  const r = rows[0];
  if (!r) return null;
  return { wallet: r.wallet, expiresAt: r.expires_at, txSignature: r.tx_signature, createdAt: r.created_at };
}

/**
 * Record or extend a subscription. Extending from the later of now and
 * the current expiry keeps back to back renewals additive.
 */
export async function recordSubscription(
  wallet: string,
  txSignature: string,
  durationMs: number,
  nowMs: number,
): Promise<StrategySubscription> {
  const current = await getSubscription(wallet);
  const base = current && current.expiresAt > nowMs ? current.expiresAt : nowMs;
  const expiresAt = base + durationMs;
  await execute(
    `INSERT INTO strategy_subscriptions (wallet, expires_at, tx_signature, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wallet) DO UPDATE SET
       expires_at = EXCLUDED.expires_at,
       tx_signature = EXCLUDED.tx_signature`,
    [wallet, expiresAt, txSignature, nowMs],
  );
  return { wallet, expiresAt, txSignature, createdAt: nowMs };
}

/**
 * Claim a payment signature for idempotency. Returns true when this call
 * claimed it; false when the signature was already used.
 */
export async function claimPaymentSignature(signature: string, wallet: string): Promise<boolean> {
  const n = await execute(
    `INSERT INTO strategy_used_signatures (signature, wallet, created_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (signature) DO NOTHING`,
    [signature, wallet, Date.now()],
  );
  return n === 1;
}
