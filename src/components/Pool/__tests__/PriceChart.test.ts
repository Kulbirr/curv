import { describe, expect, it } from 'vitest';
import { formatMcapAxis } from '../chartFormat';

describe('formatMcapAxis', () => {
  it('uses one consistent suffix across the 1k boundary (no "1k" next to "999.63")', () => {
    // The reported case: values ~998.86-1001.18 must not mix "1k" and "999.63".
    const span = 2.7;
    const maxV = 1001.18;
    const labels = [1001.18, 1000.41, 1000.0, 999.63, 998.86].map((v) =>
      formatMcapAxis(v, span, maxV)
    );
    expect(labels).toEqual(['1.001k', '1k', '1k', '1k', '0.999k']);
    expect(labels.every((l) => l.endsWith('k'))).toBe(true);
  });

  it('uses compact lowercase k/m/b suffixes when the tick step is coarse', () => {
    expect(formatMcapAxis(1_500_000, 300_000, 1_600_000)).toBe('1.5m');
    expect(formatMcapAxis(1_600_000, 300_000, 1_600_000)).toBe('1.6m');
    expect(formatMcapAxis(250_000, 60_000, 250_000)).toBe('250k');
    expect(formatMcapAxis(2_500_000_000, 600_000_000, 2_500_000_000)).toBe('2.5b');
  });

  it('compacts round values: 3000 -> 3k, 1000000 -> 1m', () => {
    expect(formatMcapAxis(3000, 60, 3030)).toBe('3k');
    expect(formatMcapAxis(1_000_000, 300_000, 1_100_000)).toBe('1m');
  });

  it('keeps labels distinct in a moderately tight range', () => {
    // MC hovering ~3000 with a span of 20: 2.99k, 3k, 3.01k.
    const span = 20;
    const labels = [2990, 3000, 3010].map((v) => formatMcapAxis(v, span, 3010));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(['2.99k', '3k', '3.01k']);
  });

  it('compacts large values with a tiny span (flat line reads "1m", not "1000002.5714")', () => {
    // The live devnet case: MC pinned ~1,000,002.56, span ~0.02.
    const values = [1000002.5714, 1000002.5646, 1000002.5579, 1000002.5512];
    const labels = values.map((v) => formatMcapAxis(v, 0.02, 1000002.5714));
    expect(labels).toEqual(['1m', '1m', '1m', '1m']);
  });

  it('compacts a tight 150k range instead of falling back to plain decimals', () => {
    const labels = [150_000.41, 150_000.18, 149_999.63].map((v) =>
      formatMcapAxis(v, 2.7, 150_000.41)
    );
    expect(labels).toEqual(['150k', '150k', '150k']);
  });

  it('handles zero and non-finite input', () => {
    expect(formatMcapAxis(0, 10, 10)).toBe('0');
    expect(formatMcapAxis(NaN, 10, 10)).toBe('-');
    expect(formatMcapAxis(Infinity, 10, 10)).toBe('-');
  });
});
