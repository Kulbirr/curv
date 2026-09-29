/**
 * Graduation progress math for the pool detail page.
 *
 * The bar shows how far the pool's quote reserve has climbed toward the
 * configured migration threshold, both real values from the indexed
 * DBC state. Never fabricate either input; nulls stay null.
 */

export interface GraduationDisplay {
  /** 0-100, clamped. null when either input is missing or the threshold is not positive. */
  pct: number | null;
  /** True when the reserve has reached (or passed) the threshold. */
  reached: boolean;
}

/** Progress of quoteReserve toward migrationQuoteThreshold, clamped to 0-100. */
export function graduationDisplay(
  quoteReserve: number | null,
  migrationQuoteThreshold: number | null,
): GraduationDisplay {
  if (
    typeof quoteReserve !== 'number' ||
    typeof migrationQuoteThreshold !== 'number' ||
    !Number.isFinite(quoteReserve) ||
    !Number.isFinite(migrationQuoteThreshold) ||
    migrationQuoteThreshold <= 0
  ) {
    return { pct: null, reached: false };
  }
  const raw = (quoteReserve / migrationQuoteThreshold) * 100;
  return {
    pct: Math.min(100, Math.max(0, raw)),
    reached: quoteReserve >= migrationQuoteThreshold,
  };
}
