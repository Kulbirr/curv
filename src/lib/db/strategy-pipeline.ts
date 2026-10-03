import { execute, query } from './index';
import type { CandidateInput, GateResult, UniverseEntry } from '../strategies/gates';
import type { JudgeCheck, JudgeVerdict } from '../strategies/judge';

/**
 * Storage half of the signal approval pipeline. Candidates move
 * pending -> approved | rejected, and approved candidates become
 * strategy_signals rows on publish. Rejected rows are the audit trail
 * and are never served to subscribers.
 */

export type CandidateStatus = 'pending' | 'approved' | 'rejected' | 'published';

export interface SignalCandidate {
  id: string;
  baseMint: string;
  baseSymbol: string;
  quoteMint: string;
  quoteSymbol: string;
  entryLow: number;
  entryHigh: number;
  stopPrice: number;
  targets: number[];
  sizeText: string | null;
  thesis: string;
  submittedBy: string;
  noKnownUnlock: boolean;
  status: CandidateStatus;
  ruleResults: GateResult[] | null;
  aiVerdict: JudgeVerdict | null;
  aiReasons: string[] | null;
  aiChecks: JudgeCheck[] | null;
  decidedAt: number | null;
  createdAt: number;
}

export interface UniverseRow {
  baseMint: string;
  symbol: string;
  coingeckoId: string;
  tier: 'core' | 'satellite';
  active: boolean;
  createdAt: number;
}

export function newCandidateId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `cand_${Date.now().toString(36)}_${rand}`;
}

function parseJsonArray<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

interface CandidateRow {
  id: string;
  base_mint: string;
  base_symbol: string;
  quote_mint: string;
  quote_symbol: string;
  entry_low: number;
  entry_high: number;
  stop_price: number;
  targets: string;
  size_text: string | null;
  thesis: string;
  submitted_by: string;
  no_known_unlock: number;
  status: string;
  rule_results: string | null;
  ai_verdict: string | null;
  ai_reasons: string | null;
  decided_at: number | null;
  created_at: number;
}

function rowToCandidate(r: CandidateRow): SignalCandidate {
  // ai_reasons is stored as {"reasons": [...], "checks": [...]}; older rows
  // may hold a bare array. Never let a shape mismatch reach the UI.
  let aiReasons: string[] | null = null;
  let aiChecks: JudgeCheck[] | null = null;
  if (r.ai_reasons) {
    try {
      const parsed: unknown = JSON.parse(r.ai_reasons);
      if (Array.isArray(parsed)) {
        const reasons = parsed.filter((x): x is string => typeof x === 'string');
        aiReasons = reasons.length > 0 ? reasons : null;
      } else if (parsed && typeof parsed === 'object') {
        const obj = parsed as { reasons?: unknown; checks?: unknown };
        if (Array.isArray(obj.reasons)) {
          const reasons = obj.reasons.filter((x): x is string => typeof x === 'string');
          aiReasons = reasons.length > 0 ? reasons : null;
        }
        if (Array.isArray(obj.checks)) {
          const checks = obj.checks.filter(
            (x): x is JudgeCheck => typeof x === 'object' && x !== null,
          );
          aiChecks = checks.length > 0 ? checks : null;
        }
      }
    } catch {
      aiReasons = null;
      aiChecks = null;
    }
  }
  return {
    id: r.id,
    baseMint: r.base_mint,
    baseSymbol: r.base_symbol,
    quoteMint: r.quote_mint,
    quoteSymbol: r.quote_symbol,
    entryLow: r.entry_low,
    entryHigh: r.entry_high,
    stopPrice: r.stop_price,
    targets: parseJsonArray<number[]>(r.targets) ?? [],
    sizeText: r.size_text,
    thesis: r.thesis,
    submittedBy: r.submitted_by,
    noKnownUnlock: r.no_known_unlock === 1,
    status: (['pending', 'approved', 'rejected', 'published'].includes(r.status)
      ? r.status
      : 'pending') as CandidateStatus,
    ruleResults: parseJsonArray<GateResult[]>(r.rule_results),
    aiVerdict: r.ai_verdict === 'approved' || r.ai_verdict === 'rejected' ? r.ai_verdict : null,
    aiReasons,
    aiChecks,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

const CANDIDATE_COLS = `id, base_mint, base_symbol, quote_mint, quote_symbol,
  entry_low, entry_high, stop_price, targets, size_text, thesis,
  submitted_by, no_known_unlock, status, rule_results, ai_verdict,
  ai_reasons, decided_at, created_at`;

export async function insertCandidate(
  input: CandidateInput & { quoteMint: string; quoteSymbol: string; submittedBy: string },
): Promise<SignalCandidate> {
  const now = Date.now();
  const id = newCandidateId();
  await execute(
    `INSERT INTO strategy_signal_candidates
       (id, base_mint, base_symbol, quote_mint, quote_symbol,
        entry_low, entry_high, stop_price, targets, size_text, thesis,
        submitted_by, no_known_unlock, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14)`,
    [
      id,
      input.baseMint,
      input.baseSymbol,
      input.quoteMint,
      input.quoteSymbol,
      input.entryLow,
      input.entryHigh,
      input.stopPrice,
      JSON.stringify(input.targets),
      input.sizeText,
      input.thesis,
      input.submittedBy,
      input.noKnownUnlock ? 1 : 0,
      now,
    ],
  );
  const got = await getCandidate(id);
  if (!got) throw new Error('Candidate insert failed');
  return got;
}

export async function getCandidate(id: string): Promise<SignalCandidate | null> {
  const rows = await query<CandidateRow>(
    `SELECT ${CANDIDATE_COLS} FROM strategy_signal_candidates WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToCandidate(rows[0]) : null;
}

export async function listCandidates(status?: CandidateStatus): Promise<SignalCandidate[]> {
  const rows = status
    ? await query<CandidateRow>(
        `SELECT ${CANDIDATE_COLS} FROM strategy_signal_candidates WHERE status = $1 ORDER BY created_at DESC`,
        [status],
      )
    : await query<CandidateRow>(
        `SELECT ${CANDIDATE_COLS} FROM strategy_signal_candidates ORDER BY created_at DESC`,
      );
  return rows.map(rowToCandidate);
}

/** Live base mints for the duplicate gate: active, unexpired signals. */
export async function listLiveSignalBaseMints(nowMs: number): Promise<string[]> {
  const rows = await query<{ base_mint: string }>(
    `SELECT DISTINCT base_mint FROM strategy_signals WHERE status = 'active' AND expires_at > $1`,
    [nowMs],
  );
  return rows.map((r) => r.base_mint);
}

export interface EvaluationOutcome {
  ruleResults: GateResult[];
  aiVerdict: JudgeVerdict | null;
  aiReasons: string[] | null;
  aiChecks: JudgeCheck[] | null;
  status: CandidateStatus;
  note: string | null;
}

/**
 * Persist an evaluation. Only pending candidates can be decided; this
 * keeps a double evaluation from flipping a published row.
 */
export async function recordEvaluation(
  id: string,
  outcome: EvaluationOutcome,
  nowMs: number,
): Promise<SignalCandidate | null> {
  const n = await execute(
    `UPDATE strategy_signal_candidates
     SET status = $1, rule_results = $2, ai_verdict = $3, ai_reasons = $4, decided_at = $5
     WHERE id = $6 AND status = 'pending'`,
    [
      outcome.status,
      JSON.stringify(outcome.ruleResults),
      outcome.aiVerdict,
      outcome.aiReasons ? JSON.stringify({ reasons: outcome.aiReasons, checks: outcome.aiChecks ?? [] }) : null,
      nowMs,
      id,
    ],
  );
  if (n !== 1) return null;
  return getCandidate(id);
}

/**
 * Persist gate results without deciding the candidate. Used when the AI
 * judge is unavailable: the candidate stays pending for a human, with
 * the deterministic results already recorded.
 */
export async function recordGateResults(id: string, ruleResults: GateResult[]): Promise<boolean> {
  const n = await execute(
    `UPDATE strategy_signal_candidates SET rule_results = $1 WHERE id = $2 AND status = 'pending'`,
    [JSON.stringify(ruleResults), id],
  );
  return n === 1;
}

/** Mark an approved candidate published after its signal row is created. */
export async function markCandidatePublished(id: string, signalId: string): Promise<boolean> {
  const n = await execute(
    `UPDATE strategy_signal_candidates SET status = 'published' WHERE id = $1 AND status = 'approved'`,
    [id],
  );
  return n === 1 && signalId.length > 0;
}

interface UniverseDbRow {
  base_mint: string;
  symbol: string;
  coingecko_id: string;
  tier: string;
  active: number;
  created_at: number;
}

function rowToUniverse(r: UniverseDbRow): UniverseRow {
  return {
    baseMint: r.base_mint,
    symbol: r.symbol,
    coingeckoId: r.coingecko_id,
    tier: r.tier === 'satellite' ? 'satellite' : 'core',
    active: r.active === 1,
    createdAt: r.created_at,
  };
}

export function toGateUniverse(rows: UniverseRow[]): UniverseEntry[] {
  return rows.map((r) => ({
    baseMint: r.baseMint,
    symbol: r.symbol,
    coingeckoId: r.coingeckoId,
    tier: r.tier,
    active: r.active,
  }));
}

export async function listUniverse(): Promise<UniverseRow[]> {
  const rows = await query<UniverseDbRow>(
    `SELECT base_mint, symbol, coingecko_id, tier, active, created_at
     FROM strategy_universe ORDER BY symbol ASC`,
  );
  return rows.map(rowToUniverse);
}

export async function setUniverseActive(baseMint: string, active: boolean): Promise<boolean> {
  const n = await execute(`UPDATE strategy_universe SET active = $1 WHERE base_mint = $2`, [
    active ? 1 : 0,
    baseMint,
  ]);
  return n === 1;
}
