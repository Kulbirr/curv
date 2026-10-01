import { isDevnet } from './solana';

/**
 * USD conversion for quote tokens.
 *
 * On mainnet this uses Jupiter's public price API with a short timeout
 * and a 60s in-memory cache. On devnet it returns the same mainnet
 * reference price (the SOL mint is the same address): testers expect to
 * see USD figures, and hiding them made the UI look broken. Devnet USD
 * figures are reference-only, the token itself is play money, so API
 * responses flag them with usdReference and the UI labels them as such.
 * A failed lookup returns null so callers show a dash instead of a
 * stale number.
 */

/** True when USD figures derived from quote prices are reference-only. */
export function isUsdReferencePrice(): boolean {
  return isDevnet();
}

const JUP_PRICE_URL = 'https://api.jup.ag/price/v3';
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { price: number; at: number }>();

// Well-known mainnet mints we can label without a lookup.
export const KNOWN_QUOTES: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
};

export async function getQuoteUsdPrice(quoteMint: string): Promise<number | null> {
  const now = Date.now();
  const hit = cache.get(quoteMint);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.price;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${JUP_PRICE_URL}?ids=${quoteMint}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, { usdPrice?: number }>;
    const p = json?.[quoteMint]?.usdPrice;
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return null;
    cache.set(quoteMint, { price: p, at: now });
    return p;
  } catch {
    return null;
  }
}
