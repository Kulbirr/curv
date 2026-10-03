/**
 * Track-record resolution: scores published signals against real price
 * action so the public win rate is earned, not asserted.
 *
 * Every 30 minutes the resolver pulls 1-minute Coinbase spot candles for
 * each pending signal's window and walks them in order. First touch wins:
 * a candle whose high tags the first target resolves a win, a candle whose
 * low breaks the stop resolves a loss. This answers the intra-check problem
 * (TP hit at 12:05, SL hit at 12:20, check at 12:30): the candle order shows
 * the target touched first, so it scores a win.
 *
 * Coinbase USD pairs are the reference feed. The USD/USDC spread is noise
 * next to 7%+ stop/target levels, and USD pairs exist for every universe
 * asset (SOL has no USDC pair on Coinbase).
 */

import type { StrategySignal } from '../strategies';

export interface Kline {
  /** Candle open time, ms. */
  time: number;
  low: number;
  high: number;
  open: number;
  close: number;
}

const PRODUCT_BY_SYMBOL: Record<string, string> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
};

const KLINE_GRANULARITY_S = 60;
const KLINE_PAGE_SIZE = 300;
const COINBASE_BASE = 'https://api.exchange.coinbase.com';

/** 1-minute candles for [startMs, endMs), ascending by time. */
export async function fetchKlines(
  baseSymbol: string,
  startMs: number,
  endMs: number,
): Promise<Kline[] | null> {
  const product = PRODUCT_BY_SYMBOL[baseSymbol.toUpperCase()];
  if (!product) return null;
  const out: Kline[] = [];
  let start = Math.floor(startMs / 1000);
  const end = Math.floor(endMs / 1000);
  if (end <= start) return out;
  // Each request returns at most 300 candles; page forward.
  for (let guard = 0; guard < 20 && start < end; guard++) {
    const url =
      `${COINBASE_BASE}/products/${product}/candles` +
      `?granularity=${KLINE_GRANULARITY_S}&start=${start}&end=${Math.min(end, start + KLINE_PAGE_SIZE * KLINE_GRANULARITY_S)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'curv-track-record/1.0' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      return null;
    }
    if (!Array.isArray(raw) || raw.length === 0) break;
    // Coinbase returns [time, low, high, open, close, volume], newest first.
    const page: Kline[] = [];
    for (const c of raw) {
      if (!Array.isArray(c) || c.length < 5) continue;
      const [t, low, high, open, close] = c;
      if (![t, low, high, open, close].every((n) => typeof n === 'number')) continue;
      page.push({ time: t * 1000, low, high, open, close });
    }
    page.sort((a, b) => a.time - b.time);
    out.push(...page);
    const lastTime = page[page.length - 1].time;
    if (page.length < KLINE_PAGE_SIZE) break;
    start = Math.floor(lastTime / 1000) + KLINE_GRANULARITY_S;
    // Be polite to the public API.
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

export type Resolution =
  | { outcome: 'win' | 'loss'; resolvedAt: number; resolvedPrice: number }
  | { outcome: 'expired'; resolvedAt: number; resolvedPrice: number | null }
  | { outcome: 'pending' };

/**
 * Score a signal against ordered candles. Candles before publication are
 * ignored; evaluation stops at expiry. A single candle touching both levels
 * scores a loss: when order is unknowable we score against ourselves.
 */
export function resolveOutcome(
  signal: Pick<StrategySignal, 'createdAt' | 'expiresAt' | 'stopPrice' | 'targets'>,
  klines: Kline[],
  nowMs: number,
): Resolution {
  const stop = signal.stopPrice;
  const target = signal.targets?.[0] ?? null;
  const horizon = Math.min(nowMs, signal.expiresAt);
  let lastClose: number | null = null;
  if (stop !== null && target !== null) {
    for (const k of klines) {
      if (k.time < signal.createdAt || k.time >= horizon) continue;
      lastClose = k.close;
      const hitTarget = k.high >= target;
      const hitStop = k.low <= stop;
      if (hitTarget && hitStop) {
        return { outcome: 'loss', resolvedAt: k.time, resolvedPrice: stop };
      }
      if (hitTarget) {
        return { outcome: 'win', resolvedAt: k.time, resolvedPrice: target };
      }
      if (hitStop) {
        return { outcome: 'loss', resolvedAt: k.time, resolvedPrice: stop };
      }
    }
  } else {
    for (const k of klines) {
      if (k.time < signal.createdAt || k.time >= horizon) continue;
      lastClose = k.close;
    }
  }
  if (nowMs >= signal.expiresAt) {
    return { outcome: 'expired', resolvedAt: signal.expiresAt, resolvedPrice: lastClose };
  }
  return { outcome: 'pending' };
}
