/**
 * Pure formatting helpers for the pool price/market-cap chart axis.
 * Kept in a JSX-free module so they are unit-testable.
 */

export const compactFmt = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
});

/**
 * Y-axis tick label for market cap: K/M/B suffixes only when the tick step
 * is coarse enough that the labels stay distinct (avoids "1K", "1K", "1K").
 * Falls back to adaptive plain decimals for tight ranges.
 */
export function formatMcapAxis(v: number, span: number): string {
  if (!Number.isFinite(v)) return '-';
  if (v === 0) return '0';
  const step = span / 3;
  const SUFFIXES: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [div, suffix] of SUFFIXES) {
    if (Math.abs(v) >= div && step >= div / 100) {
      // Enough fraction digits that adjacent ticks differ in the label.
      const digits = Math.min(
        2,
        Math.max(0, Math.ceil(-Math.log10(step / div)) + 1)
      );
      return `${Number((v / div).toFixed(digits))}${suffix}`;
    }
  }
  const decimals =
    span > 0 ? Math.min(8, Math.max(2, Math.ceil(-Math.log10(span / 4)) + 1)) : 2;
  // Trim trailing zeros so 1000.4100 renders as 1000.41.
  return Number(v.toFixed(decimals)).toString();
}

/** Y-axis tick label for price: adaptive decimals from the visible span. */
export function formatPriceAxis(v: number, span: number): string {
  if (!Number.isFinite(v)) return '-';
  if (v === 0) return '0';
  const decimals =
    span > 0 ? Math.min(8, Math.max(2, Math.ceil(-Math.log10(span / 4)) + 1)) : 4;
  // Trim trailing zeros so 0.00100000 renders as 0.001.
  return Number(v.toFixed(decimals)).toString();
}

/** Full value for the tooltip and the header stat. */
export function formatFullValue(v: number, mode: 'price' | 'mcap'): string {
  if (!Number.isFinite(v)) return '-';
  if (mode === 'mcap') return compactFmt.format(v);
  return Number(v.toPrecision(6)).toString();
}
