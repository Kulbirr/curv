/**
 * Deterministic gates for signal candidates. Every gate is pure logic
 * except the liquidity gate, which reads CoinGecko. A gate returns pass,
 * fail or abstain: abstain means the gate could not decide (for example
 * market data was unreachable) and the candidate needs a human look
 * instead of failing closed on missing data.
 *
 * All user facing strings avoid dash characters, per the strategies
 * feature convention.
 */

export type GateStatus = 'pass' | 'fail' | 'abstain';

export interface GateResult {
  name: string;
  status: GateStatus;
  reason: string;
}

export interface CandidateInput {
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
  /** Submitter attests no large unlock is known within the next 30 days. */
  noKnownUnlock: boolean;
}

export interface UniverseEntry {
  baseMint: string;
  symbol: string;
  coingeckoId: string;
  tier: 'core' | 'satellite';
  active: boolean;
}

export interface MarketSnapshot {
  coingeckoId: string;
  price: number;
  change24hPct: number | null;
  change7dPct: number | null;
  volume24h: number;
  volume30dAvg: number | null;
  mcap: number;
  fetchedAt: number;
}

/** Core tier bars, matching professional index methodology. */
export const CORE_MIN_MCAP = 1_000_000_000;
export const CORE_MIN_ADV = 25_000_000;
/** Satellite tier bars: smaller, with a per signal depth check by the judge. */
export const SATELLITE_MIN_MCAP = 250_000_000;
export const SATELLITE_MIN_ADV = 5_000_000;

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const MARKET_TIMEOUT_MS = 10_000;

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'curv-strategies/1.0' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`coingecko http ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

interface MarketsRow {
  current_price?: number;
  market_cap?: number;
  total_volume?: number;
  price_change_percentage_24h?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
}

/**
 * Fetch price, market cap, 24h volume and 30 day average volume from the
 * CoinGecko free API. Returns null when anything fails: the liquidity
 * gate abstains on null rather than failing closed.
 */
export async function fetchMarketSnapshot(coingeckoId: string): Promise<MarketSnapshot | null> {
  try {
    const markets = (await fetchJson(
      `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(coingeckoId)}&price_change_percentage=24h,7d`,
      MARKET_TIMEOUT_MS,
    )) as MarketsRow[];
    const row = Array.isArray(markets) ? markets[0] : undefined;
    if (
      !row ||
      typeof row.current_price !== 'number' ||
      typeof row.market_cap !== 'number' ||
      typeof row.total_volume !== 'number'
    ) {
      return null;
    }
    let volume30dAvg: number | null = null;
    try {
      const chart = (await fetchJson(
        `${COINGECKO_BASE}/coins/${encodeURIComponent(coingeckoId)}/market_chart?vs_currency=usd&days=30`,
        MARKET_TIMEOUT_MS,
      )) as { total_volumes?: Array<[number, number]> };
      const vols = Array.isArray(chart.total_volumes) ? chart.total_volumes : [];
      const nums = vols.map((v) => v[1]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      if (nums.length > 0) {
        volume30dAvg = nums.reduce((a, b) => a + b, 0) / nums.length;
      }
    } catch {
      volume30dAvg = null;
    }
    return {
      coingeckoId,
      price: row.current_price,
      change24hPct:
        typeof row.price_change_percentage_24h === 'number' ? row.price_change_percentage_24h : null,
      change7dPct:
        typeof row.price_change_percentage_7d_in_currency === 'number'
          ? row.price_change_percentage_7d_in_currency
          : null,
      volume24h: row.total_volume,
      volume30dAvg,
      mcap: row.market_cap,
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/** Gate 1: the coin must be in the active signal universe. */
export function universeGate(
  candidate: Pick<CandidateInput, 'baseMint' | 'baseSymbol'>,
  universe: UniverseEntry[],
): GateResult {
  const entry = universe.find(
    (u) => u.baseMint === candidate.baseMint && u.active,
  );
  if (!entry) {
    return {
      name: 'universe',
      status: 'fail',
      reason: `${candidate.baseSymbol} is not in the active signal universe`,
    };
  }
  return {
    name: 'universe',
    status: 'pass',
    reason: `${candidate.baseSymbol} is in the universe as ${entry.tier} tier`,
  };
}

/** Gate 2: no live signal may already cover the same coin. */
export function duplicateGate(
  candidate: Pick<CandidateInput, 'baseMint' | 'baseSymbol'>,
  liveBaseMints: string[],
): GateResult {
  if (liveBaseMints.includes(candidate.baseMint)) {
    return {
      name: 'duplicate',
      status: 'fail',
      reason: `A live signal already covers ${candidate.baseSymbol}`,
    };
  }
  return { name: 'duplicate', status: 'pass', reason: 'No live signal covers this coin' };
}

/** Gate 3: the entry zone, stop and targets must be coherent numbers. */
export function formatGate(candidate: CandidateInput): GateResult {
  const nums = [candidate.entryLow, candidate.entryHigh, candidate.stopPrice, ...candidate.targets];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) {
    return { name: 'format', status: 'fail', reason: 'Entry, stop and targets must be positive numbers' };
  }
  if (!(candidate.entryLow < candidate.entryHigh)) {
    return { name: 'format', status: 'fail', reason: 'Entry low must be below entry high' };
  }
  if (!(candidate.stopPrice < candidate.entryLow)) {
    return { name: 'format', status: 'fail', reason: 'Stop must sit below the entry zone' };
  }
  if (candidate.targets.length === 0) {
    return { name: 'format', status: 'fail', reason: 'At least one target is required' };
  }
  if (!candidate.targets.every((t) => t > candidate.entryHigh)) {
    return { name: 'format', status: 'fail', reason: 'Every target must sit above the entry zone' };
  }
  return { name: 'format', status: 'pass', reason: 'Zone, stop and targets are coherent' };
}

/** Gate 4: the submitter attests no large unlock is known within 30 days. */
export function unlockAttestationGate(candidate: Pick<CandidateInput, 'noKnownUnlock'>): GateResult {
  if (candidate.noKnownUnlock) {
    return {
      name: 'unlock attestation',
      status: 'pass',
      reason: 'Submitter attests no large unlock is known within 30 days',
    };
  }
  return {
    name: 'unlock attestation',
    status: 'abstain',
    reason: 'No unlock attestation given, a human must check the unlock calendar',
  };
}

/**
 * Gate 5: liquidity bars per tier. Abstains when market data is
 * unreachable so a CoinGecko outage never kills a candidate on its own.
 */
export function liquidityGate(
  candidate: Pick<CandidateInput, 'baseSymbol'>,
  tier: 'core' | 'satellite',
  market: MarketSnapshot | null,
): GateResult {
  if (!market) {
    return {
      name: 'liquidity',
      status: 'abstain',
      reason: 'Market data was unreachable, a human must confirm liquidity',
    };
  }
  const minMcap = tier === 'core' ? CORE_MIN_MCAP : SATELLITE_MIN_MCAP;
  const minAdv = tier === 'core' ? CORE_MIN_ADV : SATELLITE_MIN_ADV;
  const adv = market.volume30dAvg ?? market.volume24h;
  const advLabel = market.volume30dAvg !== null ? '30 day average volume' : '24h volume';
  if (market.mcap < minMcap) {
    return {
      name: 'liquidity',
      status: 'fail',
      reason: `Market cap ${fmtUsd(market.mcap)} is below the ${tier} bar of ${fmtUsd(minMcap)}`,
    };
  }
  if (adv < minAdv) {
    return {
      name: 'liquidity',
      status: 'fail',
      reason: `${advLabel} ${fmtUsd(adv)} is below the ${tier} bar of ${fmtUsd(minAdv)}`,
    };
  }
  return {
    name: 'liquidity',
    status: 'pass',
    reason: `Market cap ${fmtUsd(market.mcap)} and ${advLabel} ${fmtUsd(adv)} clear the ${tier} bars`,
  };
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export interface GateEvaluation {
  results: GateResult[];
  market: MarketSnapshot | null;
  tier: 'core' | 'satellite' | null;
  /** True when every gate passed (abstains do not block the judge). */
  gatesClear: boolean;
}

export interface GateContext {
  universe: UniverseEntry[];
  liveBaseMints: string[];
}

/**
 * Run every deterministic gate. Market data is fetched once and shared.
 * A fail on any gate (except abstains) means the candidate is rejected
 * without bothering the AI judge.
 */
export async function runGates(
  candidate: CandidateInput,
  ctx: GateContext,
): Promise<GateEvaluation> {
  const results: GateResult[] = [];
  results.push(universeGate(candidate, ctx.universe));
  results.push(duplicateGate(candidate, ctx.liveBaseMints));
  results.push(formatGate(candidate));
  results.push(unlockAttestationGate(candidate));

  const entry = ctx.universe.find((u) => u.baseMint === candidate.baseMint && u.active);
  const tier = entry ? entry.tier : null;
  let market: MarketSnapshot | null = null;
  if (entry) {
    market = await fetchMarketSnapshot(entry.coingeckoId);
    results.push(liquidityGate(candidate, entry.tier, market));
  } else {
    results.push({
      name: 'liquidity',
      status: 'abstain',
      reason: 'Skipped because the coin is not in the universe',
    });
  }

  const gatesClear = results.every((r) => r.status !== 'fail');
  return { results, market, tier, gatesClear };
}
