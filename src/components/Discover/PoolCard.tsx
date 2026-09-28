import Link from 'next/link'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { DASH } from '@/lib/format/number'
import {
  clampProgress,
  formatMoneyValue,
  formatPriceValue,
  formatSignedChangePct,
} from './format'
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

export default function PoolCard({ pool }: { pool: PoolSummary }) {
  const progress = clampProgress(pool.progress)
  const change = pool.change24h
  const changePositive = typeof change === 'number' && change > 0
  const changeKnown = typeof change === 'number' && Number.isFinite(change)

  return (
    <Link href={`/token/${pool.poolAddress}`} className="sc-token-card">
      {/* Top row: avatar, name/ticker, quote badge */}
      <div className="sc-token-card-top">
        <TokenAvatar pool={pool} />
        <div className="sc-token-identity">
          <strong>{pool.baseName || pool.baseSymbol}</strong>
          <span>
            ${pool.baseSymbol}
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
        <QuoteBadge quoteSymbol={pool.quoteSymbol} />
      </div>

      {/* Price row */}
      <div className="sc-token-price-row">
        <strong className="sc-number">
          {formatPriceValue(pool.priceUsd, pool.price, pool.quoteSymbol)}
        </strong>
        <span
          className={cn(
            'sc-number',
            !changeKnown && 'text-neutral-500',
            changeKnown &&
              (changePositive ? 'positive text-emerald' : 'negative text-rose')
          )}
        >
          {formatSignedChangePct(change)}
        </span>
      </div>

      {/* Curve progress */}
      <div className="sc-discover-progress-head">
        <span>{pool.graduated ? 'Graduated' : 'Curve progress'}</span>
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

      {/* Bottom row: MC / EST VOL / arrow */}
      <div className="sc-token-card-foot">
        <span>
          MC <b>{formatMoneyValue(pool.marketCapUsd, pool.marketCap, pool.quoteSymbol)}</b>
        </span>
        <span title="Estimated from sampled reserve changes, not exact trade volume">
          EST VOL <b>{formatMoneyValue(null, pool.volume24h, pool.quoteSymbol)}</b>
        </span>
        <span className="sc-open-arrow" aria-hidden="true">
          ↗
        </span>
      </div>
    </Link>
  )
}
