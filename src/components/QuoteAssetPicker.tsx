import { useEffect, useMemo, useState } from 'react'
import { isDevnet } from '@/lib/solana'
import { searchQuoteAssets, type QuoteAsset } from '@/lib/quote-directory'

/**
 * Searchable verified quote-asset picker for the launch form.
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
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-sm text-neutral-400"
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
      className="h-8 w-8 shrink-0 rounded-full bg-neutral-800"
    />
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
  const [source, setSource] = useState<'live' | 'fallback' | null>(null)
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
        setSource(json.source === 'fallback' ? 'fallback' : 'live')
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const results = useMemo(
    () => searchQuoteAssets(assets, query),
    [assets, query]
  )
  const devnet = isDevnet()

  return (
    <div className="mb-4 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-neutral-200">Verified assets</p>
        {source === 'fallback' && (
          <span className="text-xs text-amber-300/80">offline snapshot</span>
        )}
      </div>
      {devnet && (
        <p className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200/90">
          These mints live on mainnet. Curv is on devnet, so pick one to prefill
          the form, then swap in your devnet test mint — or enter a mint
          manually below.
        </p>
      )}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search symbol, name or mint…"
        aria-label="Search verified quote assets"
        className="mb-2 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
      />
      <div
        className="max-h-64 overflow-y-auto"
        role="listbox"
        aria-label="Quote assets"
      >
        {failed ? (
          <p className="px-1 py-3 text-sm text-neutral-500">
            Directory unreachable. Enter the mint manually below.
          </p>
        ) : assets.length === 0 ? (
          <p className="px-1 py-3 text-sm text-neutral-500">
            Loading verified assets…
          </p>
        ) : results.length === 0 ? (
          <p className="px-1 py-3 text-sm text-neutral-500">
            No match. Enter the mint manually below.
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
                className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-neutral-900 ${
                  selected
                    ? 'bg-neutral-900 ring-1 ring-inset ring-emerald-500/50'
                    : ''
                }`}
              >
                <AssetLogo asset={a} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <strong className="text-sm text-neutral-100">
                      {a.symbol}
                    </strong>
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
                      mainnet
                    </span>
                    {a.source === 'xstocks' && (
                      <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sky-300">
                        xStock
                      </span>
                    )}
                    {a.tokenProgram === 'Token-2022' && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                        Token-2022
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-neutral-500">
                    {a.name}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm text-neutral-200">
                    {a.usdPrice != null ? fmtUsd(a.usdPrice) : '—'}
                  </span>
                  {a.liquidityUsd != null && a.liquidityUsd > 0 && (
                    <span className="block text-[11px] text-neutral-500">
                      liq {fmtUsd(a.liquidityUsd)}
                    </span>
                  )}
                </span>
              </button>
            )
          })
        )}
      </div>
      <p className="mt-2 text-[11px] text-neutral-600">
        Token data: xStocks by Backed · Prices powered by Jupiter
      </p>
    </div>
  )
}
