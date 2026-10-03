/**
 * AI judge for signal candidates. After the deterministic gates clear, a
 * strong instruction following model scores the candidate against the
 * published ruleset rubric and returns a strict JSON verdict. The verdict
 * and its reasons are stored and shown on the signal card; a rejection is
 * logged and never shown to subscribers.
 *
 * Provider is chosen by JUDGE_PROVIDER: "nvidia" uses NVIDIA_API_KEY
 * against the NVIDIA NIM chat completions endpoint, anything else uses
 * OPENROUTER_API_KEY against OpenRouter. JUDGE_MODEL overrides the
 * default model for the chosen provider. When no key is configured the
 * judge reports unavailable and the candidate stays pending for a human
 * decision.
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

/** Default model per provider, OpenAI compatible chat completions. */
export const JUDGE_MODEL_OPENROUTER = 'nousresearch/hermes-4-70b';
export const JUDGE_MODEL_NVIDIA = 'nvidia/nemotron-3-super-120b-a12b';
/** Backwards compatible default: Hermes via OpenRouter. */
export const JUDGE_MODEL = JUDGE_MODEL_OPENROUTER;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

interface JudgeEndpoint {
  url: string;
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  /** Reasoning models need room to think before writing the verdict. */
  maxTokens: number;
  timeoutMs: number;
}

/** Resolve the judge endpoint from the environment. Null when no key. */
export function judgeEndpoint(): JudgeEndpoint | null {
  if (process.env.JUDGE_PROVIDER === 'nvidia') {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) return null;
    return {
      url: NVIDIA_URL,
      apiKey,
      model: process.env.JUDGE_MODEL || JUDGE_MODEL_NVIDIA,
      headers: {},
      maxTokens: 4096,
      timeoutMs: 120_000,
    };
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  return {
    url: OPENROUTER_URL,
    apiKey,
    model: process.env.JUDGE_MODEL || JUDGE_MODEL_OPENROUTER,
    headers: {
      'http-referer': 'https://curvpad.fun',
      'x-title': 'Curv strategies signal judge',
    },
    maxTokens: 800,
    timeoutMs: 20_000,
  };
}

/** Name the missing key for the selected provider. */
function missingKeyReason(): string {
  return process.env.JUDGE_PROVIDER === 'nvidia'
    ? 'NVIDIA_API_KEY is not configured'
    : 'OPENROUTER_API_KEY is not configured';
}

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
  /** Live price expressed in the signal quote currency, for the no chase check. */
  marketPriceInQuote: number | null;
  gateResults: GateResult[];
}

export function buildJudgePrompt(input: JudgePromptInput): { system: string; user: string } {
  const { candidate, market, marketPriceInQuote, gateResults } = input;
  const gates = gateResults.map((g) => `${g.name}: ${g.status} (${g.reason})`).join('\n');
  const marketBlock = market
    ? [
        `Live price: $${market.price}`,
        `Live price in ${candidate.quoteSymbol}: ${
          marketPriceInQuote === null ? 'unknown' : marketPriceInQuote.toString()
        }`,
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
 * Run the AI judge. Needs a provider key in the environment
 * (OPENROUTER_API_KEY, or NVIDIA_API_KEY with JUDGE_PROVIDER=nvidia).
 * Returns unavailable when no key is configured so the caller can keep
 * the candidate pending for a human instead of failing the evaluation.
 */
export async function runJudge(input: JudgePromptInput): Promise<JudgeResult> {
  const endpoint = judgeEndpoint();
  if (!endpoint) {
    return { status: 'unavailable', reason: missingKeyReason() };
  }
  const { system, user } = buildJudgePrompt(input);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), endpoint.timeoutMs);
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.apiKey}`,
        ...endpoint.headers,
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: endpoint.maxTokens,
      }),
    });
    if (!res.ok) {
      return { status: 'error', reason: `Judge request failed with http ${res.status}` };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>;
    };
    // Reasoning models answer in reasoning_content and may leave content null.
    const msg = json.choices?.[0]?.message;
    const content =
      typeof msg?.content === 'string' && msg.content.length > 0
        ? msg.content
        : typeof msg?.reasoning_content === 'string'
          ? msg.reasoning_content
          : '';
    if (content.length === 0) {
      return { status: 'error', reason: 'Judge returned an empty reply' };
    }
    const parsed = parseJudgeReply(content);
    if (!parsed) {
      return { status: 'error', reason: 'Judge reply was not valid verdict JSON' };
    }
    return { status: 'ok', ...parsed, model: endpoint.model };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { status: 'error', reason: 'Judge request timed out' };
    }
    return { status: 'error', reason: 'Judge request failed' };
  } finally {
    clearTimeout(timer);
  }
}
