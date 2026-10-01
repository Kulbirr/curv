/**
 * Pure formatting helpers for the pool price/market-cap chart axis.
 * Kept in a JSX-free module so they are unit-testable.
 */

export const compactFmt = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
});

/**
 * Y-axis tick label for market cap: always compact (3k / 1m / 2.5b),
 * lowercase to match the reference design. Up to 3 fraction digits so that
 * labels stay distinct down to tick steps of div/1000 (e.g. 2.99k, 3k,
 * 3.01k); only extremely tight ranges fall back to plain decimals.
 */
export function formatMcapAxis(v: number, span: number): string {
  if (!Number.isFinite(v)) return '-';
  if (v === 0) return '0';
  const step = span / 3;
  const SUFFIXES: Array<[number, string]> = [
    [1e9, 'b'],
    [1e6, 'm'],
    [1e3, 'k'],
  ];
  for (const [div, suffix] of SUFFIXES) {
    if (Math.abs(v) >= div && step >= div / 1000) {
      // Enough fraction digits that adjacent ticks differ in the label.
      const digits = Math.min(
        3,
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
