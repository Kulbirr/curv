/**
 * Shared candidate pipeline: evaluate and publish.
 *
 * The API routes under /api/strategies/candidates/[id] delegate to these
 * functions, and the idea engine chains them server side when auto
 * publishing. Nothing here touches HTTP, so the logic stays identical
 * whichever entry point runs it.
 */

import {
  KNOWN_MINT_DECIMALS,
  MAX_SIGNAL_TTL_MS,
  validateSignalInput,
} from '@/lib/strategies';
import {
  getCandidate,
  listLiveSignalBaseMints,
  listUniverse,
  markCandidatePublished,
  recordEvaluation,
  recordGateResults,
  toGateUniverse,
  type SignalCandidate,
} from '@/lib/db/strategy-pipeline';
import { insertStrategySignal } from '@/lib/db/strategies';
import { runGates, fetchMarketSnapshot, type CandidateInput, type GateResult } from './gates';
import { runJudge } from './judge';

const DEFAULT_TTL_MS = 48 * 3600_000;

/** HTTP aware error for the thin API wrappers to translate. */
export class PipelineError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface EvaluateResult {
  candidate: SignalCandidate;
  judgeSkipped?: boolean;
  judgeUnavailable?: boolean;
  judgeError?: string;
  note?: string;
}

/**
 * Run the deterministic gates, then the AI judge, and store the verdict.
 *
 * Flow: any failing gate rejects the candidate without calling the judge.
 * When the gates clear, the judge decides. When the judge is unavailable
 * (no API key) or errors, the candidate stays pending for a human, with
 * the gate results already stored.
 */
export async function evaluateCandidate(id: string): Promise<EvaluateResult> {
  let candidate: SignalCandidate | null;
  try {
    candidate = await getCandidate(id);
  } catch {
    throw new PipelineError(500, 'Could not load the candidate');
  }
  if (!candidate) throw new PipelineError(404, 'Candidate not found');
  if (candidate.status !== 'pending') {
    throw new PipelineError(409, `Candidate is already ${candidate.status}`);
  }

  let universe;
  let liveBaseMints: string[];
  try {
    universe = await listUniverse();
    liveBaseMints = await listLiveSignalBaseMints(Date.now());
  } catch {
    throw new PipelineError(500, 'Could not load universe or live signals');
  }

  const gateInput: CandidateInput = {
    baseMint: candidate.baseMint,
    baseSymbol: candidate.baseSymbol,
    quoteMint: candidate.quoteMint,
    quoteSymbol: candidate.quoteSymbol,
    entryLow: candidate.entryLow,
    entryHigh: candidate.entryHigh,
    stopPrice: candidate.stopPrice,
    targets: candidate.targets,
    sizeText: candidate.sizeText,
    thesis: candidate.thesis,
    noKnownUnlock: candidate.noKnownUnlock,
  };

  let evaluation;
  try {
    evaluation = await runGates(gateInput, {
      universe: toGateUniverse(universe),
      liveBaseMints,
    });
  } catch {
    throw new PipelineError(502, 'Gate evaluation failed');
  }

  const now = Date.now();

  if (!evaluation.gatesClear) {
    const failed = evaluation.results.filter((r) => r.status === 'fail');
    const updated = await recordEvaluation(
      id,
      {
        ruleResults: evaluation.results,
        aiVerdict: 'rejected',
        aiReasons: failed.map((f) => `Gate rejected: ${f.reason}`),
        aiChecks: [],
        status: 'rejected',
        note: null,
      },
      now,
    );
    if (!updated) throw new PipelineError(500, 'Could not record the evaluation');
    return { candidate: updated, judgeSkipped: true };
  }

  let judge;
  try {
    // The mirror guard and the feed quote prices in the signal quote
    // currency, so the judge gets the live price in the same unit for
    // its no chase check.
    let marketPriceInQuote: number | null = null;
    if (evaluation.market) {
      const quoteEntry = toGateUniverse(universe).find(
        (u) => u.baseMint === gateInput.quoteMint && u.active,
      );
      if (quoteEntry) {
        const quoteMarket = await fetchMarketSnapshot(quoteEntry.coingeckoId);
        if (quoteMarket && quoteMarket.price > 0) {
          marketPriceInQuote = evaluation.market.price / quoteMarket.price;
        }
      }
    }
    judge = await runJudge({
      candidate: gateInput,
      market: evaluation.market,
      marketPriceInQuote,
      gateResults: evaluation.results,
    });
  } catch {
    judge = { status: 'error' as const, reason: 'Judge call threw' };
  }

  if (judge.status === 'unavailable') {
    await recordGateResults(id, evaluation.results);
    const refreshed = await getCandidate(id);
    if (!refreshed) throw new PipelineError(500, 'Could not reload the candidate');
    return {
      candidate: refreshed,
      judgeUnavailable: true,
      note: 'Judge has no API key, candidate stays pending for a human decision',
    };
  }

  if (judge.status === 'error') {
    const withNote: GateResult[] = [
      ...evaluation.results,
      { name: 'ai judge', status: 'abstain', reason: judge.reason },
    ];
    await recordGateResults(id, withNote);
    const refreshed = await getCandidate(id);
    if (!refreshed) throw new PipelineError(500, 'Could not reload the candidate');
    return {
      candidate: refreshed,
      judgeError: judge.reason,
      note: 'Judge errored, candidate stays pending for a human decision',
    };
  }

  const updated = await recordEvaluation(
    id,
    {
      ruleResults: evaluation.results,
      aiVerdict: judge.verdict,
      aiReasons: judge.reasons,
      aiChecks: judge.checks,
      status: judge.verdict === 'approved' ? 'approved' : 'rejected',
      note: null,
    },
    now,
  );
  if (!updated) throw new PipelineError(500, 'Could not record the evaluation');
  return { candidate: updated };
}

export interface PublishOptions {
  /** Publishes a pending or rejected candidate without the AI badge. */
  overrideReason?: string | null;
  /** Epoch ms; defaults to 48h from now, must be within 7 days. */
  expiresAt?: number;
}

/**
 * Publish an approved candidate as a live signal.
 *
 * Only candidates with status approved publish directly. A human can
 * override a pending or rejected candidate by giving overrideReason;
 * overridden signals publish without the AI badge.
 */
export async function publishCandidate(id: string, opts: PublishOptions = {}) {
  let candidate: SignalCandidate | null;
  try {
    candidate = await getCandidate(id);
  } catch {
    throw new PipelineError(500, 'Could not load the candidate');
  }
  if (!candidate) throw new PipelineError(404, 'Candidate not found');
  if (candidate.status === 'published') {
    throw new PipelineError(409, 'Candidate is already published');
  }

  const overrideReason =
    typeof opts.overrideReason === 'string' && opts.overrideReason.trim().length > 0
      ? opts.overrideReason.trim().slice(0, 280)
      : null;

  let aiApproved = false;
  let aiReasons: string[] | null = null;
  if (candidate.status === 'approved') {
    aiApproved = true;
    aiReasons = candidate.aiReasons;
  } else if (overrideReason) {
    aiApproved = false;
    aiReasons = null;
  } else {
    throw new PipelineError(
      409,
      `Candidate is ${candidate.status}, publish needs approval or an override reason`,
    );
  }

  const now = Date.now();
  const expiresAt =
    typeof opts.expiresAt === 'number' && Number.isInteger(opts.expiresAt)
      ? opts.expiresAt
      : now + DEFAULT_TTL_MS;

  // Reference price is the bottom of the entry zone; the mirror ceiling
  // is the zone top plus the 2 percent no chase buffer from the ruleset.
  const signalBody = {
    baseMint: candidate.baseMint,
    quoteMint: candidate.quoteMint,
    baseSymbol: candidate.baseSymbol,
    quoteSymbol: candidate.quoteSymbol,
    baseDecimals: KNOWN_MINT_DECIMALS[candidate.baseMint],
    quoteDecimals: KNOWN_MINT_DECIMALS[candidate.quoteMint],
    entryPrice: candidate.entryLow,
    maxPrice: candidate.entryHigh * 1.02,
    side: 'buy' as const,
    sizeText: candidate.sizeText,
    note: candidate.thesis.slice(0, 140),
    expiresAt,
  };
  const validated = validateSignalInput(signalBody, now);
  if (validated.ok === false) {
    throw new PipelineError(400, validated.error);
  }
  if (expiresAt - now > MAX_SIGNAL_TTL_MS) {
    throw new PipelineError(400, 'expiresAt must be within 7 days');
  }

  let signal;
  try {
    signal = await insertStrategySignal({
      ...validated.input,
      aiApproved,
      aiReasons,
    });
  } catch (e) {
    throw new PipelineError(500, e instanceof Error ? e.message : 'Could not publish the signal');
  }
  await markCandidatePublished(id, signal.id);
  return { signal, overridden: overrideReason !== null };
}
