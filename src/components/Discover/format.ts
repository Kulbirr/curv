import { DASH } from '@/lib/format/number'

const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})

function isRenderable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Compact USD: 87000 -> "$87K", 1860000 -> "$1.86M". Null -> "-". */
export function formatCompactUsd(value: number | null | undefined): string {
  if (!isRenderable(value)) return DASH
  return `$${compactFormatter.format(value)}`
}

/** Compact plain number: 54700 -> "54.7K". Null -> "-". */
export function formatCompact(value: number | null | undefined): string {
  if (!isRenderable(value)) return DASH
  return compactFormatter.format(value)
}

/**
 * Adaptive price with a $ prefix: 0.00087 -> "$0.00087", 0.0764 -> "$0.0764".
 * Uses 4 significant digits, matching the card design. Null -> "-".
 */
export function formatPriceUsd(value: number | null | undefined): string {
  if (!isRenderable(value)) return DASH
  const abs = Math.abs(value)
  if (abs >= 1e15) return formatCompactUsd(value)
  return `$${Number(value.toPrecision(4)).toString()}`
}

/**
 * Signed 24h change in percent units: 31.52 -> "+31.52%", -3.24 -> "-3.24%".
 * Null -> "-".
 */
export function formatSignedChangePct(
  value: number | null | undefined
): string {
  if (!isRenderable(value)) return DASH
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

/**
 * Money display that prefers the USD-denominated field and falls back to the
 * quote-denominated value with its quote symbol (e.g. "87K SOL").
 * Returns "-" when neither is known, never invents a number.
 */
export function formatMoneyValue(
  usdValue: number | null | undefined,
  quoteValue: number | null | undefined,
  quoteSymbol: string
): string {
  if (isRenderable(usdValue)) return formatCompactUsd(usdValue)
  if (isRenderable(quoteValue))
    return `${formatCompact(quoteValue)} ${quoteSymbol}`
  return DASH
}

/**
 * Price display that prefers USD and falls back to quote-denominated
 * (e.g. "0.00482 SOL"). Returns "-" when unknown.
 */
export function formatPriceValue(
  priceUsd: number | null | undefined,
  price: number | null | undefined,
  quoteSymbol: string
): string {
  if (isRenderable(priceUsd)) return formatPriceUsd(priceUsd)
  if (isRenderable(price))
    return `${formatPriceUsd(price).slice(1)} ${quoteSymbol}`
  return DASH
}

/** Clamp a 0-100 progress value; null stays null. */
export function clampProgress(
  progress: number | null | undefined
): number | null {
  if (!isRenderable(progress)) return null
  return Math.min(100, Math.max(0, progress))
}
