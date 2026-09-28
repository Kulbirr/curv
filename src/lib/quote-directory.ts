/**
 * Verified quote-asset directory.
 *
 * Where the data comes from (and why we may use it):
 * - xStocks by Backed Finance publishes a public, documented, no-auth
 *   assets API explicitly built for integrators:
 *   https://api.xstocks.fi/api/v2/public/assets
 *   It returns the canonical Solana mint per tokenized stock plus the
 *   issuer-hosted logo. We consume the documented API; we do not scrape
 *   their site.
 * - Jupiter's public price API v3 enriches each mint with USD price,
 *   liquidity and decimals (batched, 50 mints per query):
 *   https://api.jup.ag/price/v3
 *   The picker shows "Powered by Jupiter" attribution per their licence.
 * - We deliberately do NOT use pump.fun's list or API: their Terms of Use
 *   (§16, §17, §21) prohibit scraping or reusing their curated data in a
 *   competing product.
 *
 * All directory assets are mainnet mints. The launch UI must keep showing
 * the network badge and the devnet guidance, because a mainnet mint does
 * not exist on devnet.
 */

export type QuoteAssetSource = 'xstocks' | 'preset'
export type TokenProgramKind = 'SPL' | 'Token-2022'

export interface QuoteAsset {
  /** Base58 mint address. */
  mint: string
  symbol: string
  name: string
  /** Null when the registry does not publish decimals. */
  decimals: number | null
  logoUrl: string | null
  source: QuoteAssetSource
  /** The directory only lists mainnet mints today. */
  network: 'mainnet-beta'
  tokenProgram: TokenProgramKind | null
  usdPrice: number | null
  liquidityUsd: number | null
  tags: string[]
}

/** Jupiter price v3 accepts at most 50 mints per query. */
export const JUP_PRICE_BATCH_SIZE = 50

/** xStocks page size; the registry is small enough for a few pages. */
export const XSTOCKS_PAGE_SIZE = 100
export const XSTOCKS_MAX_PAGES = 3

interface XstocksDeployment {
  address?: unknown
  network?: unknown
}

interface XstocksNode {
  name?: unknown
  symbol?: unknown
  logo?: unknown
  isTradingHalted?: unknown
  deployments?: unknown
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Map one page of the xStocks public assets API to directory entries.
 * Keeps only assets with a Solana deployment. xStocks on Solana are
 * Token-2022 mints (verified against Jupiter's token metadata for TSLAx:
 * tokenProgram TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb).
 */
export function mapXstocksAssets(json: unknown): QuoteAsset[] {
  const nodes = (json as { nodes?: unknown })?.nodes
  if (!Array.isArray(nodes)) return []
  const out: QuoteAsset[] = []
  for (const n of nodes) {
    const node = n as XstocksNode
    const symbol = asString(node.symbol)
    const name = asString(node.name) ?? symbol ?? 'Unknown'
    const deployments = Array.isArray(node.deployments)
      ? (node.deployments as XstocksDeployment[])
      : []
    const sol = deployments.find((d) => d.network === 'Solana')
    const mint = sol ? asString(sol.address) : null
    if (!symbol || !mint) continue
    out.push({
      mint,
      symbol,
      name: name ?? symbol,
      decimals: null, // the xStocks API does not publish decimals; enriched later
      logoUrl: asString(node.logo),
      source: 'xstocks',
      network: 'mainnet-beta',
      tokenProgram: 'Token-2022',
      usdPrice: null,
      liquidityUsd: null,
      tags: [
        'xstock',
        ...(node.isTradingHalted === true ? ['trading-halted'] : []),
      ],
    })
  }
  return out
}

interface JupPriceEntry {
  usdPrice?: unknown
  decimals?: unknown
  liquidity?: unknown
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Fill usdPrice / liquidityUsd / decimals from Jupiter price v3.
 * `fetchImpl` is injectable for tests. Mints missing from the response
 * keep their previous values; failures never throw.
 */
export async function enrichWithPrices(
  assets: QuoteAsset[],
  fetchImpl: typeof fetch = fetch
): Promise<QuoteAsset[]> {
  const byMint = new Map(assets.map((a) => [a.mint, a]))
  const mints = [...byMint.keys()]
  await Promise.all(
    chunk(mints, JUP_PRICE_BATCH_SIZE).map(async (batch) => {
      try {
        const res = await fetchImpl(
          `https://api.jup.ag/price/v3?ids=${batch.join(',')}`
        )
        if (!res.ok) return
        const json = (await res.json()) as Record<string, JupPriceEntry>
        for (const mint of batch) {
          const entry = json?.[mint]
          if (!entry) continue
          const asset = byMint.get(mint)
          if (!asset) continue
          const price = asFiniteNumber(entry.usdPrice)
          if (price !== null && price > 0) asset.usdPrice = price
          const liq = asFiniteNumber(entry.liquidity)
          if (liq !== null && liq >= 0) asset.liquidityUsd = liq
          const dec = asFiniteNumber(entry.decimals)
          if (dec !== null && Number.isInteger(dec) && dec >= 0 && dec <= 18) {
            asset.decimals = dec
          }
        }
      } catch {
        // Enrichment is best-effort; the directory works without prices.
      }
    })
  )
  return assets
}

/**
 * Ranked substring search over symbol, name and mint.
 * Symbol prefix matches rank first so "SOL" finds Solana, not "absolut".
 */
export function searchQuoteAssets(
  assets: QuoteAsset[],
  query: string
): QuoteAsset[] {
  const q = query.trim().toLowerCase()
  if (!q) return assets.slice(0, 50)
  const ranked: { asset: QuoteAsset; rank: number }[] = []
  for (const asset of assets) {
    const symbol = asset.symbol.toLowerCase()
    const name = asset.name.toLowerCase()
    let rank = -1
    if (symbol.startsWith(q)) rank = 0
    else if (symbol.includes(q)) rank = 1
    else if (name.includes(q)) rank = 2
    else if (asset.mint.toLowerCase().includes(q)) rank = 3
    if (rank >= 0) ranked.push({ asset, rank })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.asset.symbol.localeCompare(b.asset.symbol))
  return ranked.slice(0, 50).map((r) => r.asset)
}

/**
 * Static fallback used when both upstream APIs are unreachable.
 * Every mint here is verified (SOL/USDC are canonical; TSLAx matches
 * Jupiter's verified xStocks entry).
 */
export const FALLBACK_ASSETS: QuoteAsset[] = [
  {
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
    logoUrl: null,
    source: 'preset',
    network: 'mainnet-beta',
    tokenProgram: 'SPL',
    usdPrice: null,
    liquidityUsd: null,
    tags: ['native'],
  },
  {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    logoUrl: null,
    source: 'preset',
    network: 'mainnet-beta',
    tokenProgram: 'SPL',
    usdPrice: null,
    liquidityUsd: null,
    tags: ['stablecoin'],
  },
  {
    mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
    symbol: 'TSLAx',
    name: 'Tesla xStock',
    decimals: 8,
    logoUrl: 'https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.png',
    source: 'xstocks',
    network: 'mainnet-beta',
    tokenProgram: 'Token-2022',
    usdPrice: null,
    liquidityUsd: null,
    tags: ['xstock'],
  },
]

/** Merge live assets over the fallback, deduped by mint. */
export function mergeWithFallback(live: QuoteAsset[]): QuoteAsset[] {
  const seen = new Set(live.map((a) => a.mint))
  return [...live, ...FALLBACK_ASSETS.filter((a) => !seen.has(a.mint))]
}
