import Link from 'next/link'
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { cn } from '@/lib/utils'
import { DASH } from '@/lib/format/number'
import { formatAge } from '@/lib/format/date'
import {
  clampProgress,
  formatMoneyValue,
  formatPriceValue,
  formatSignedChangePct,
} from './format'
import { UsdRef } from '@/components/UsdRef'
import type { PoolSummary } from './types'

/** Deterministic hue (0-359) derived from a string, for avatar gradients. */
function hueFromString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360
  }
  return hash
}

function TokenAvatar({ pool }: { pool: PoolSummary }) {
  const [imgFailed, setImgFailed] = useState(false)
  const letter = (pool.baseSymbol.charAt(0) || '?').toUpperCase()
  const hue = hueFromString(pool.baseSymbol || pool.poolAddress)

  return (
    <span
      className="sc-token-avatar large"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 65% 42%), hsl(${(hue + 50) % 360} 65% 58%))`,
      }}
      aria-hidden="true"
    >
      {pool.imageUrl && !imgFailed ? (
        <img
          src={pool.imageUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span>{letter}</span>
      )}
    </span>
  )
}

/**
 * Quote badge pill. Stock-style quotes (ending in "x", e.g. NVDAx) get the
 * muted stock variant with a tiny leading letter chip.
 */
function QuoteBadge({ quoteSymbol }: { quoteSymbol: string }) {
  const isStockQuote = quoteSymbol.endsWith('x')
  return (
    <span className={cn('sc-quote-badge', isStockQuote && 'stock')}>
      {isStockQuote && <i>{quoteSymbol.charAt(0).toUpperCase()}</i>}
      {quoteSymbol}
    </span>
  )
}

const FAVORITES_KEY = 'curv:favorite-pools'

function readFavorites(): string[] {
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string')
      : []
  } catch {
    return []
  }
}

/**
 * Watchlist star. Favorites are a local, per-browser convenience stored
 * in localStorage; the button must never trigger the card's link.
 */
function FavoriteButton({ poolAddress }: { poolAddress: string }) {
  const [favorite, setFavorite] = useState(false)

  useEffect(() => {
    setFavorite(readFavorites().includes(poolAddress))
  }, [poolAddress])

  const toggle = (event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setFavorite((prev) => {
      const next = !prev
      try {
        const set = new Set(readFavorites())
        if (next) set.add(poolAddress)
        else set.delete(poolAddress)
        window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([...set]))
      } catch {
        /* storage unavailable: the star still flips for this session */
      }
      return next
    })
  }

  return (
    <button
      type="button"
      className={cn('sc-fav-btn', favorite && 'active')}
      onClick={toggle}
      aria-pressed={favorite}
      aria-label={favorite ? 'Remove from watchlist' : 'Add to watchlist'}
      title={favorite ? 'Remove from watchlist' : 'Add to watchlist'}
    >
      {favorite ? '★' : '☆'}
    </button>
  )
}

/**
 * Mini price sparkline from real sampled ticks served by /api/pools.
 * Renders nothing when the API has fewer than 2 samples, rather than
 * inventing a shape.
 */
function Sparkline({
  points,
  tone,
}: {
  points: number[] | null | undefined
  tone: 'up' | 'down' | 'flat'
}) {
  if (!points || points.length < 2) {
    return <div className="sc-spark sc-spark-empty" aria-hidden="true" />
  }
  const w = 104
  const h = 40
  const pad = 3
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const stepX = (w - pad * 2) / (points.length - 1)
  const coords = points.map(
    (p, i) =>
      `${(pad + i * stepX).toFixed(1)},${(
        h -
        pad -
        ((p - min) / span) * (h - pad * 2)
      ).toFixed(1)}`
  )
  const line = coords.join(' ')
  const area = `${pad},${h - 1} ${line} ${w - pad},${h - 1}`
  return (
    <svg
      className={cn('sc-spark', tone)}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon points={area} className="sc-spark-fill" />
      <polyline points={line} className="sc-spark-line" />
    </svg>
  )
}

export default function PoolCard({
  pool,
  usdReference,
}: {
  pool: PoolSummary
  usdReference?: boolean
}) {
  const progress = clampProgress(pool.progress)
  const change = pool.change24h
  const changePositive = typeof change === 'number' && change > 0
  const changeKnown = typeof change === 'number' && Number.isFinite(change)
  const tone = !changeKnown || change === 0 ? 'flat' : changePositive ? 'up' : 'down'
  const age = formatAge(new Date(pool.createdAt), new Date())

  return (
    <Link href={`/token/${pool.poolAddress}`} className="sc-token-card">
      {/* Top row: avatar, name/ticker/age, watchlist star */}
      <div className="sc-token-card-top">
        <TokenAvatar pool={pool} />
        <div className="sc-token-identity">
          <strong>{pool.baseName || pool.baseSymbol}</strong>
          <span>
            ${pool.baseSymbol} · {age}
            {pool.stale && (
              <span title="On-chain data could not be refreshed">
                {' '}
                · stale
              </span>
            )}
            {!pool.verified && (
              <span title="This pool's on-chain account has not been verified yet">
                {' '}
                · unverified
              </span>
            )}
          </span>
        </div>
        <FavoriteButton poolAddress={pool.poolAddress} />
      </div>

      {/* Pills row: quote pair, venue, verification */}
      <div className="sc-card-pills">
        <QuoteBadge quoteSymbol={pool.quoteSymbol} />
        {pool.graduated ? (
          <span className="sc-pill teal">DAMM v2</span>
        ) : (
          <span className="sc-pill">DBC curve</span>
        )}
        {pool.verified && <span className="sc-pill ok">✓ Verified pool</span>}
      </div>

      {/* Market cap block + sparkline */}
      <div className="sc-card-stats">
        <div className="sc-card-mc">
          <span className="sc-card-label">Market cap</span>
          <strong className="sc-number">
            {formatMoneyValue(pool.marketCapUsd, pool.marketCap, pool.quoteSymbol)}
            <UsdRef reference={usdReference} hasUsd={pool.marketCapUsd != null} />
          </strong>
          <span
            className={cn(
              'sc-card-change sc-number',
              !changeKnown && 'text-neutral-500',
              changeKnown &&
                (changePositive ? 'positive text-emerald' : 'negative text-rose')
            )}
          >
            {formatSignedChangePct(change)}
          </span>
        </div>
        <Sparkline points={pool.sparkline} tone={tone} />
      </div>

      {/* Secondary stats: estimated volume, spot price */}
      <div className="sc-card-substats">
        <div>
          <span className="sc-card-label">24h volume · est</span>
          <b className="sc-number">
            {formatMoneyValue(null, pool.volume24h, pool.quoteSymbol)}
          </b>
        </div>
        <div className="sc-card-substat-right">
          <span className="sc-card-label">Price</span>
          <b className="sc-number">
            {formatPriceValue(pool.priceUsd, pool.price, pool.quoteSymbol)}
          </b>
        </div>
      </div>

      {/* Graduation status + progress bar */}
      <div className="sc-discover-progress-head">
        <span>
          {pool.graduated ? (
            <span className="sc-grad-note">Graduated to DAMM v2 ✓</span>
          ) : (
            'Curve progress'
          )}
        </span>
        <span className="sc-number">
          {pool.graduated
            ? '100%'
            : progress === null
              ? DASH
              : `${Math.round(progress)}%`}
        </span>
      </div>
      <div className={cn('sc-progress', pool.graduated && 'graduated')}>
        <span style={{ width: `${pool.graduated ? 100 : (progress ?? 0)}%` }} />
      </div>

      {/* Footer affordance */}
      <div className="sc-card-viewrow">
        <span>View market</span>
        <span aria-hidden="true">→</span>
      </div>
    </Link>
  )
}
