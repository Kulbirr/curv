import { useEffect, useMemo, useState } from 'react'
import { searchQuoteAssets, type QuoteAsset } from '@/lib/quote-directory'

/**
 * Searchable quote-asset picker for the launch form.
 *
 * Lists mainnet mints from the xStocks issuer registry enriched with
 * Jupiter prices. Selecting an asset prefills the custom mint, decimals
 * and symbol fields. Manual entry stays available underneath for devnet
 * test mints and anything not in the directory.
 */

export interface PickedQuoteAsset {
  mint: string
  symbol: string
  name: string
  decimals: number | null
  usdPrice: number | null
  tokenProgram: string | null
}

interface DirectoryResponse {
  assets: QuoteAsset[]
  source: 'live' | 'fallback'
  updatedAt: string
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000)
    return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000)
    return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toPrecision(3)}`
}

function AssetLogo({ asset }: { asset: QuoteAsset }) {
  const [failed, setFailed] = useState(false)
  if (!asset.logoUrl || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-neutral-800 text-lg font-semibold text-neutral-400"
      >
        {asset.symbol.slice(0, 1)}
      </span>
    )
  }
  return (
    <img
      src={asset.logoUrl}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-12 w-12 shrink-0 rounded-2xl bg-neutral-800 object-cover"
    />
  )
}

function SkeletonRow() {
  return (
    <div className="flex animate-pulse items-center gap-4 px-3 py-3">
      <div className="h-12 w-12 shrink-0 rounded-2xl bg-neutral-800/70" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-4 w-2/5 rounded bg-neutral-800/70" />
        <div className="h-3 w-1/4 rounded bg-neutral-800/50" />
      </div>
      <div className="shrink-0 space-y-2">
        <div className="h-4 w-20 rounded bg-neutral-800/70" />
        <div className="ml-auto h-3 w-16 rounded bg-neutral-800/50" />
      </div>
    </div>
  )
}

export function QuoteAssetPicker({
  onSelect,
  selectedMint,
}: {
  onSelect: (asset: PickedQuoteAsset) => void
  selectedMint: string
}) {
  const [assets, setAssets] = useState<QuoteAsset[]>([])
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/quote-directory')
        if (!res.ok) throw new Error(`directory ${res.status}`)
        const json = (await res.json()) as DirectoryResponse
        if (cancelled) return
        setAssets(Array.isArray(json.assets) ? json.assets : [])
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const results = useMemo(() => searchQuoteAssets(assets, query), [assets, query])

  return (
    <div className="mb-5">
      <div className="relative mb-3">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-neutral-500"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tokens"
          aria-label="Search quote assets"
          className="h-12 w-full rounded-2xl border border-neutral-800 bg-neutral-900/70 pl-12 pr-4 text-[15px] text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
        />
      </div>
      <div role="listbox" aria-label="Quote assets" className="max-h-80 overflow-y-auto">
        {failed ? (
          <p className="px-3 py-6 text-center text-sm text-neutral-500">
            Directory unreachable. Enter the mint manually below.
          </p>
        ) : assets.length === 0 ? (
          <>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : results.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-neutral-500">
            No assets found. Enter the mint manually below.
          </p>
        ) : (
          results.map((a) => {
            const selected = selectedMint.trim() === a.mint
            return (
              <button
                key={a.mint}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() =>
                  onSelect({
                    mint: a.mint,
                    symbol: a.symbol,
                    name: a.name,
                    decimals: a.decimals,
                    usdPrice: a.usdPrice,
                    tokenProgram: a.tokenProgram,
                  })
                }
                className={`flex w-full items-center gap-4 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-white/[0.04] ${
                  selected ? 'bg-white/[0.05]' : ''
                }`}
              >
                <AssetLogo asset={a} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-white">
                    {a.name}
                  </span>
                  <span className="block text-[13px] text-neutral-500">
                    {a.symbol}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-right">
                    <span className="block text-[15px] font-semibold text-white">
                      {a.usdPrice != null ? fmtUsd(a.usdPrice) : ''}
                    </span>
                    {a.liquidityUsd != null && a.liquidityUsd > 0 && (
                      <span className="block text-[13px] text-neutral-500">
                        Liquidity · {fmtUsd(a.liquidityUsd)}
                      </span>
                    )}
                  </span>
                  {selected && (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-5 w-5 text-emerald-400"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </span>
              </button>
            )
          })
        )}
      </div>
      <p className="mt-3 text-center text-[11px] text-neutral-600">
        Prices powered by Jupiter
      </p>
    </div>
  )
}
