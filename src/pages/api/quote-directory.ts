import type { NextApiRequest, NextApiResponse } from 'next'
import {
  FALLBACK_ASSETS,
  POPULAR_TOKENS,
  XSTOCKS_MAX_PAGES,
  XSTOCKS_PAGE_SIZE,
  enrichWithPrices,
  mapXstocksAssets,
  mergeWithFallback,
  type QuoteAsset,
} from '@/lib/quote-directory'

/**
 * Verified quote-asset directory for the launch form's custom-pair picker.
 *
 * GET → { assets, source: 'live' | 'fallback', updatedAt }
 *
 * The directory is assembled server-side so the browser never talks to the
 * upstream APIs directly: one xStocks call (public integrator API) plus
 * batched Jupiter price lookups, cached in memory for 10 minutes and at
 * the edge for 10 minutes. If either upstream is unreachable the route
 * still answers with the static fallback list instead of failing.
 */

const XSTOCKS_URL = 'https://api.xstocks.fi/api/v2/public/assets'
const CACHE_TTL_MS = 10 * 60_000

let cache: { assets: QuoteAsset[]; at: number } | null = null

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'Curv/1.0 (+quote-directory)',
      },
    })
    if (!res.ok) throw new Error(`upstream ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

async function loadLiveDirectory(): Promise<QuoteAsset[]> {
  const assets: QuoteAsset[] = []
  for (let page = 1; page <= XSTOCKS_MAX_PAGES; page++) {
    const json = await fetchJson(
      `${XSTOCKS_URL}?network=Solana&page=${page}&pageSize=${XSTOCKS_PAGE_SIZE}`,
      10_000
    )
    const mapped = mapXstocksAssets(json)
    assets.push(...mapped)
    if (mapped.length < XSTOCKS_PAGE_SIZE) break
  }
  if (assets.length === 0) throw new Error('empty xStocks directory')
  // Add curated popular tokens (memes, majors, DeFi) alongside xStocks.
  // Deduped by mint; xStocks take precedence if a mint appears in both.
  const seen = new Set(assets.map((a) => a.mint))
  for (const t of POPULAR_TOKENS) {
    if (!seen.has(t.mint)) {
      assets.push({ ...t })
      seen.add(t.mint)
    }
  }
  // Best-effort: enrichWithPrices never throws, so a Jupiter outage
  // degrades to missing prices rather than a failed directory.
  await enrichWithPrices(assets)
  return mergeWithFallback(assets)
}

async function getDirectory(): Promise<{
  assets: QuoteAsset[]
  source: 'live' | 'fallback'
}> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS)
    return { assets: cache.assets, source: 'live' }
  try {
    const assets = await loadLiveDirectory()
    cache = { assets, at: now }
    return { assets, source: 'live' }
  } catch {
    // Fallback includes popular tokens so the picker stays useful offline.
    const seen = new Set(FALLBACK_ASSETS.map((a) => a.mint))
    const fallback = [
      ...FALLBACK_ASSETS,
      ...POPULAR_TOKENS.filter((a) => !seen.has(a.mint)),
    ]
    return { assets: fallback, source: 'fallback' }
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const { assets, source } = await getDirectory()
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300')
  return res
    .status(200)
    .json({ assets, source, updatedAt: new Date().toISOString() })
}
