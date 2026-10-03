/**
 * AI judge for signal candidates. After the deterministic gates clear, a
 * Hermes model scores the candidate against the published ruleset rubric
 * and returns a strict JSON verdict. The verdict and its reasons are
 * stored and shown on the signal card; a rejection is logged and never
 * shown to subscribers.
 *
 * When OPENROUTER_API_KEY is not configured the judge reports
 * unavailable and the candidate stays pending for a human decision.
 *
 * All user facing strings avoid dash characters, per the strategies
 * feature convention. AI generated text is sanitized for dashes before
 * it is stored or shown.
 */

import type { CandidateInput, GateResult, MarketSnapshot } from './gates';

export type JudgeVerdict = 'approved' | 'rejected';

export interface JudgeCheck {
  name: string;
  pass: boolean;
  note: string;
}

export interface JudgeOk {
  status: 'ok';
  verdict: JudgeVerdict;
  reasons: string[];
  checks: JudgeCheck[];
  model: string;
}

export interface JudgeUnavailable {
  status: 'unavailable';
  reason: string;
}

export interface JudgeError {
  status: 'error';
  reason: string;
}

export type JudgeResult = JudgeOk | JudgeUnavailable | JudgeError;

/** Hermes via OpenRouter, OpenAI compatible chat completions. */
export const JUDGE_MODEL = 'nousresearch/hermes-4-70b';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const JUDGE_TIMEOUT_MS = 20_000;

/** Strip dash characters from AI generated text, per repo convention. */
export function sanitizeAiText(text: string): string {
  return text
    .replace(/[—–−]/g, ', ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RUBRIC = `You are the gatekeeper for a crypto spot buy signal feed. Subscribers mirror each published signal by buying in their own wallets, so a bad signal costs real people real money. Be strict. Reject unless the candidate clearly earns approval.

RULES
1. Entry quality. Prefer a pullback or retest entry zone over chasing a breakout. The entry zone must be a genuine value area, not the top of a vertical move.
2. No chasing. If the live price is already more than 2 percent above the top of the entry zone, reject. Late entries are the most common way signal followers lose money.
3. Thin volume vertical moves. A sharp price spike on thin volume with no identifiable catalyst is a manipulation pattern. Reject.
4. Unlock risk. The submitter attests whether a large token unlock is known within the next 30 days. If the attestation is missing, weigh that against the candidate. If you know of an unlock risk from the market context, reject.
5. Crowding. If the context reports overheated funding rates, extreme open interest, or mania level social attention, reject. Crowded trades unwind violently.
6. Catalyst. Every signal needs an identifiable reason to exist: a trend structure, a level reclaim, a fundamental development. "It might go up" is not a catalyst. Reject catalyst free candidates.
7. Risk and reward. The stop must be placed at a level that invalidates the idea, and at least the first target must offer a sensible multiple of the risk. A stop wider than the expected move is a reject.
8. Honesty. If the market data is missing or the thesis contradicts the data, say so and reject. Never approve on hope.

OUTPUT
Reply with strict JSON only, no markdown fences, no commentary:
{"verdict": "approved" or "rejected", "reasons": ["short plain reason", "..."], "checks": [{"name": "entry quality", "pass": true or false, "note": "short note"}, ...]}
Use these check names: entry quality, no chase, volume health, unlock risk, crowding, catalyst, risk reward. Keep every string free of dash characters.`;

export interface JudgePromptInput {
  candidate: CandidateInput;
  market: MarketSnapshot | null;
  gateResults: GateResult[];
}

export function buildJudgePrompt(input: JudgePromptInput): { system: string; user: string } {
  const { candidate, market, gateResults } = input;
  const gates = gateResults.map((g) => `${g.name}: ${g.status} (${g.reason})`).join('\n');
  const marketBlock = market
    ? [
        `Live price: $${market.price}`,
        `24h change: ${market.change24hPct === null ? 'unknown' : `${market.change24hPct.toFixed(2)} percent`}`,
        `7d change: ${market.change7dPct === null ? 'unknown' : `${market.change7dPct.toFixed(2)} percent`}`,
        `24h volume: $${Math.round(market.volume24h).toLocaleString('en-US')}`,
        `30 day average volume: ${market.volume30dAvg === null ? 'unknown' : `$${Math.round(market.volume30dAvg).toLocaleString('en-US')}`}`,
        `Market cap: $${Math.round(market.mcap).toLocaleString('en-US')}`,
      ].join('\n')
    : 'Market snapshot unavailable.';
  const user = [
    'CANDIDATE',
    `Coin: ${candidate.baseSymbol} quoted in ${candidate.quoteSymbol}`,
    `Entry zone: ${candidate.entryLow} to ${candidate.entryHigh} ${candidate.quoteSymbol}`,
    `Stop: ${candidate.stopPrice} ${candidate.quoteSymbol}`,
    `Targets: ${candidate.targets.join(', ')} ${candidate.quoteSymbol}`,
    candidate.sizeText ? `Suggested size: ${candidate.sizeText}` : 'Suggested size: not given',
    `Thesis: ${candidate.thesis}`,
    `Unlock attestation: ${candidate.noKnownUnlock ? 'submitter attests no large unlock known within 30 days' : 'no attestation given'}`,
    '',
    'MARKET CONTEXT',
    marketBlock,
    '',
    'GATE RESULTS',
    gates,
    '',
    'Decide: approved or rejected, with reasons and per check notes.',
  ].join('\n');
  return { system: RUBRIC, user };
}

interface RawVerdict {
  verdict?: unknown;
  reasons?: unknown;
  checks?: unknown;
}

/** Parse the model's reply into a strict verdict. Returns null when unusable. */
export function parseJudgeReply(text: string): { verdict: JudgeVerdict; reasons: string[]; checks: JudgeCheck[] } | null {
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: RawVerdict;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1)) as RawVerdict;
  } catch {
    return null;
  }
  if (raw.verdict !== 'approved' && raw.verdict !== 'rejected') return null;
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter((r): r is string => typeof r === 'string').map(sanitizeAiText).filter((r) => r.length > 0)
    : [];
  if (reasons.length === 0) return null;
  const checks = Array.isArray(raw.checks)
    ? raw.checks
        .filter(
          (c): c is { name?: unknown; pass?: unknown; note?: unknown } =>
            typeof c === 'object' && c !== null,
        )
        .map((c) => ({
          name: sanitizeAiText(typeof c.name === 'string' ? c.name : 'check'),
          pass: c.pass === true,
          note: sanitizeAiText(typeof c.note === 'string' ? c.note : ''),
        }))
    : [];
  return { verdict: raw.verdict, reasons, checks };
}

/**
 * Run the AI judge. Needs OPENROUTER_API_KEY in the environment.
 * Returns unavailable when no key is configured so the caller can keep
 * the candidate pending for a human instead of failing the evaluation.
 */
export async function runJudge(input: JudgePromptInput): Promise<JudgeResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { status: 'unavailable', reason: 'OPENROUTER_API_KEY is not configured' };
  }
  const { system, user } = buildJudgePrompt(input);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), JUDGE_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'http-referer': 'https://curvpad.fun',
        'x-title': 'Curv strategies signal judge',
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: JUDGE_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: 800,
      }),
    });
    if (!res.ok) {
      return { status: 'error', reason: `Judge request failed with http ${res.status}` };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      return { status: 'error', reason: 'Judge returned an empty reply' };
    }
    const parsed = parseJudgeReply(content);
    if (!parsed) {
      return { status: 'error', reason: 'Judge reply was not valid verdict JSON' };
    }
    return { status: 'ok', ...parsed, model: JUDGE_MODEL };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { status: 'error', reason: 'Judge request timed out' };
    }
    return { status: 'error', reason: 'Judge request failed' };
  } finally {
    clearTimeout(timer);
  }
}
