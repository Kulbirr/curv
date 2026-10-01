import { describe, expect, it } from 'vitest';
import { formatMcapAxis } from '../chartFormat';

describe('formatMcapAxis', () => {
  it('keeps tight-range labels distinct (regression: no repeated "1k")', () => {
    // The reported case: values ~998.86-1001.18 rendered as 1k, 1k, 1k, 999.63, 998.86.
    const span = 2.7;
    const labels = [1001.18, 1000.41, 1000.0, 999.63, 998.86].map((v) =>
      formatMcapAxis(v, span)
    );
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(['1001.18', '1000.41', '1000', '999.63', '998.86']);
  });

  it('uses compact lowercase k/m/b suffixes when the tick step is coarse', () => {
    expect(formatMcapAxis(1_500_000, 300_000)).toBe('1.5m');
    expect(formatMcapAxis(1_600_000, 300_000)).toBe('1.6m');
    expect(formatMcapAxis(250_000, 60_000)).toBe('250k');
    expect(formatMcapAxis(2_500_000_000, 600_000_000)).toBe('2.5b');
  });

  it('compacts round values: 3000 -> 3k, 1000000 -> 1m', () => {
    expect(formatMcapAxis(3000, 60)).toBe('3k');
    expect(formatMcapAxis(1_000_000, 300_000)).toBe('1m');
  });

  it('keeps labels distinct in a moderately tight range', () => {
    // MC hovering ~3000 with a span of 20: 2.99k, 3k, 3.01k.
    const span = 20;
    const labels = [2990, 3000, 3010].map((v) => formatMcapAxis(v, span));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(['2.99k', '3k', '3.01k']);
  });

  it('falls back to plain decimals for large values with a tiny span', () => {
    const labels = [150_000.41, 150_000.18, 149_999.63].map((v) =>
      formatMcapAxis(v, 2.7)
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('handles zero and non-finite input', () => {
    expect(formatMcapAxis(0, 10)).toBe('0');
    expect(formatMcapAxis(NaN, 10)).toBe('-');
    expect(formatMcapAxis(Infinity, 10)).toBe('-');
  });
});
