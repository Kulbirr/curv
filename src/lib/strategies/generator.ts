/**
 * The idea engine: scans the active signal universe for 1 to 4 week
 * relative strength and builds fully formed signal candidates from the
 * strongest setups. Generated ideas flow through the same gates and AI
 * judge as manual ones; nothing publishes without passing them.
 */

import { SOL_MINT } from './candidates';
import type { CandidateInput, UniverseEntry } from './gates';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const GEN_TIMEOUT_MS = 15_000;

/** Parabolic 7d moves are not chased: likely a vertical thin move. */
const MAX_7D_PCT = 40;
/** 30d moves beyond this are considered extended, not fresh momentum. */
const MAX_30D_PCT = 200;

export interface MomentumSnapshot {
  coingeckoId: string;
  price: number;
  change7dPct: number | null;
  change14dPct: number | null;
  change30dPct: number | null;
  volume24h: number;
  mcap: number;
}

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
  id?: string;
  current_price?: number;
  market_cap?: number;
  total_volume?: number;
  price_change_percentage_7d_in_currency?: number | null;
  price_change_percentage_14d_in_currency?: number | null;
  price_change_percentage_30d_in_currency?: number | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * One batched CoinGecko call for the whole universe: current price,
 * 7d / 14d / 30d changes, 24h volume and market cap per coin.
 */
export async function fetchMomentumSnapshots(
  coingeckoIds: string[],
): Promise<Map<string, MomentumSnapshot>> {
  const out = new Map<string, MomentumSnapshot>();
  if (coingeckoIds.length === 0) return out;
  const rows = (await fetchJson(
    `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(
      coingeckoIds.join(','),
    )}&price_change_percentage=7d,14d,30d`,
    GEN_TIMEOUT_MS,
  )) as MarketsRow[];
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : null;
    const price = num(row.current_price);
    if (!id || price === null || price <= 0) continue;
    out.set(id, {
      coingeckoId: id,
      price,
      change7dPct: num(row.price_change_percentage_7d_in_currency),
      change14dPct: num(row.price_change_percentage_14d_in_currency),
      change30dPct: num(row.price_change_percentage_30d_in_currency),
      volume24h: num(row.total_volume) ?? 0,
      mcap: num(row.market_cap) ?? 0,
    });
  }
  return out;
}

/**
 * 1 to 4 week formation blend, matching the research: the 30 day leg
 * carries the most weight, the 14 day leg catches the turn, the 7 day
 * leg confirms it is still working. Null when data is missing.
 */
export function scoreMomentum(s: MomentumSnapshot): number | null {
  if (s.change7dPct === null || s.change30dPct === null) return null;
  const c14 = s.change14dPct ?? (s.change7dPct + s.change30dPct) / 2;
  return 0.5 * s.change30dPct + 0.3 * c14 + 0.2 * s.change7dPct;
}

/** A setup is worth turning into an idea only with a positive blend. */
export function isEligibleMomentum(s: MomentumSnapshot): boolean {
  const score = scoreMomentum(s);
  if (score === null || score <= 0) return false;
  if ((s.change7dPct ?? 0) > MAX_7D_PCT) return false;
  if ((s.change30dPct ?? 0) > MAX_30D_PCT) return false;
  return true;
}

function roundPrice(p: number): number {
  if (p >= 100) return Math.round(p * 100) / 100;
  if (p >= 1) return Math.round(p * 1000) / 1000;
  return Math.round(p * 100000) / 100000;
}

function fmtPct(v: number | null): string {
  if (v === null) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

export interface GeneratedIdea {
  entry: UniverseEntry;
  snapshot: MomentumSnapshot;
  score: number;
  rank: number;
  of: number;
  input: CandidateInput;
}

/**
 * Build a complete candidate from a momentum setup: entry at market,
 * a 7 percent invalidation, targets near 1.7R and 3R. The snapshot price
 * is denominated in the signal quote currency (SOL), matching what the
 * feed shows and what the mirror guard compares against.
 */
export function buildIdea(
  entry: UniverseEntry,
  snapshot: MomentumSnapshot,
  score: number,
  rank: number,
  of: number,
): GeneratedIdea {
  const price = snapshot.price;
  const entryLow = roundPrice(price * 0.99);
  const entryHigh = roundPrice(price * 1.005);
  const stopPrice = roundPrice(price * 0.93);
  const targets = [roundPrice(price * 1.12), roundPrice(price * 1.22)];
  const thesis =
    `Systematic momentum, rank ${rank} of ${of} in the universe: ${entry.symbol} is ` +
    `${fmtPct(snapshot.change30dPct)} over 30 days, ${fmtPct(snapshot.change14dPct)} over 14 days and ` +
    `${fmtPct(snapshot.change7dPct)} over 7 days, the strongest 1 to 4 week relative strength ` +
    `available, trading at ${price.toLocaleString('en-US')} SOL. Entry at market, invalidation 7 percent ` +
    `below entry, targets at plus 12 and plus 22 percent.`;
  return {
    entry,
    snapshot,
    score,
    rank,
    of,
    input: {
      baseMint: entry.baseMint,
      baseSymbol: entry.symbol,
      quoteMint: SOL_MINT,
      quoteSymbol: 'SOL',
      entryLow,
      entryHigh,
      stopPrice,
      targets,
      sizeText: null,
      thesis,
      // The engine cannot attest to unlock calendars; the gate abstains
      // and the judge or a human weighs it.
      noKnownUnlock: false,
    },
  };
}

/**
 * Scan the active universe, rank by momentum, return the top ideas.
 * Coins with a live signal are skipped: the duplicate gate would reject
 * them anyway, so there is no point spending a judge call.
 *
 * Prices are denominated in SOL, the signal quote currency: the mirror
 * guard compares the live Jupiter price (SOL per coin) against the entry
 * zone, so the zone must be in the same unit.
 */
export async function generateIdeas(
  universe: UniverseEntry[],
  liveBaseMints: string[],
  count: number,
): Promise<GeneratedIdea[]> {
  const eligible = universe.filter(
    (u) => u.active && !liveBaseMints.includes(u.baseMint) && u.coingeckoId,
  );
  if (eligible.length === 0) return [];
  const ids = eligible.map((u) => u.coingeckoId);
  if (!ids.includes('solana')) ids.push('solana');
  const snaps = await fetchMomentumSnapshots(ids);
  const solUsd = snaps.get('solana')?.price ?? null;
  // Without the SOL reference the ideas cannot be priced in the quote
  // currency, so generating nothing beats generating wrong units.
  if (!solUsd || solUsd <= 0) return [];
  const scored: Array<{ entry: UniverseEntry; snapshot: MomentumSnapshot; score: number }> = [];
  for (const entry of eligible) {
    const snapshot = snaps.get(entry.coingeckoId);
    if (!snapshot) continue;
    if (!isEligibleMomentum(snapshot)) continue;
    const score = scoreMomentum(snapshot);
    if (score === null) continue;
    // Percent changes are unit free; only the traded levels convert.
    const inQuote: MomentumSnapshot = { ...snapshot, price: snapshot.price / solUsd };
    scored.push({ entry, snapshot: inQuote, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const take = Math.max(1, Math.min(count, 5));
  return scored
    .slice(0, take)
    .map((s, i) => buildIdea(s.entry, s.snapshot, s.score, i + 1, scored.length));
}
