import { describe, expect, it } from 'vitest';
import {
  DASH,
  formatReadableNumber,
  formatReadablePercentChange,
  getReadablePriceFormat,
  parseSubscript,
  ReadableNumberFormat,
} from './number';
import { formatAge, intlDate } from './date';

describe('getReadablePriceFormat', () => {
  it('picks the format by magnitude', () => {
    expect(getReadablePriceFormat(100_000)).toBe(ReadableNumberFormat.COMPACT);
    expect(getReadablePriceFormat(999_999)).toBe(ReadableNumberFormat.COMPACT);
    expect(getReadablePriceFormat(11)).toBe(ReadableNumberFormat.LONG);
    expect(getReadablePriceFormat(10.5)).toBe(ReadableNumberFormat.LONG);
    expect(getReadablePriceFormat(9.99)).toBe(ReadableNumberFormat.SMALL);
    expect(getReadablePriceFormat(0.000001)).toBe(ReadableNumberFormat.SMALL);
  });

  it('defaults nullish prices to SMALL (never throws)', () => {
    expect(getReadablePriceFormat(null)).toBe(ReadableNumberFormat.SMALL);
    expect(getReadablePriceFormat(undefined)).toBe(ReadableNumberFormat.SMALL);
  });
});

describe('formatReadableNumber', () => {
  it('returns a dash for missing or NaN input (honest, never 0)', () => {
    expect(formatReadableNumber(null)).toBe(DASH);
    expect(formatReadableNumber(undefined)).toBe(DASH);
    expect(formatReadableNumber(NaN)).toBe(DASH);
  });

  it('formats large numbers compactly', () => {
    const out = formatReadableNumber(1_234_567);
    expect(out).toMatch(/M$/);
  });

  it('formats mid-size numbers with 2 decimals', () => {
    expect(formatReadableNumber(123.456)).toBe('123.46');
  });

  it('renders tiny prices in subscript form', () => {
    const out = formatReadableNumber(0.0000123);
    expect(out).toContain('₄'); // 4 insignificant zeroes
    expect(out).toContain('123');
  });

  it('supports prefix and suffix', () => {
    expect(formatReadableNumber(123.456, { prefix: '$' })).toBe('$123.46');
    expect(formatReadableNumber(50, { suffix: '%' })).toContain('%');
  });

  it('puts the prefix before the negative sign', () => {
    expect(formatReadableNumber(-5, { prefix: '$' })).toBe('-$5.00');
  });
});

describe('formatReadablePercentChange', () => {
  it('returns a dash for missing input', () => {
    expect(formatReadablePercentChange(null)).toBe(DASH);
    expect(formatReadablePercentChange(undefined)).toBe(DASH);
  });

  it('formats sub-10x changes as signed percents', () => {
    expect(formatReadablePercentChange(0.1)).toContain('10%');
    expect(formatReadablePercentChange(-0.05)).toContain('-');
  });

  it('formats >= 10 as multiples', () => {
    expect(formatReadablePercentChange(10)).toBe('+10x');
    expect(formatReadablePercentChange(25.7)).toBe('+26x');
  });

  it('can hide the sign', () => {
    expect(formatReadablePercentChange(0.1, { hideSign: 'all' })).not.toContain('+');
  });
});

describe('parseSubscript', () => {
  it('converts subscript digits back to numbers', () => {
    expect(parseSubscript('₁₁')).toBe(11);
    expect(parseSubscript('₀')).toBe(0);
    expect(parseSubscript('abc')).toBeNaN();
  });
});

describe('formatAge', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  it('formats seconds, minutes, hours, days', () => {
    expect(formatAge(new Date('2026-09-28T11:59:30Z'), now)).toBe('30s');
    expect(formatAge(new Date('2026-09-28T11:30:00Z'), now)).toBe('30m');
    expect(formatAge(new Date('2026-09-28T09:00:00Z'), now)).toBe('3h');
    expect(formatAge(new Date('2026-09-25T12:00:00Z'), now)).toBe('3d');
  });

  it('returns a dash for missing dates', () => {
    expect(formatAge(null, now)).toBe(DASH);
    expect(formatAge(undefined, now)).toBe(DASH);
  });
});

describe('intlDate', () => {
  it('returns a dash for invalid dates, never "Invalid Date"', () => {
    expect(intlDate.format('not-a-date')).toBe(DASH);
    expect(intlDate.format(NaN)).toBe(DASH);
  });

  it('formats a valid date containing the year', () => {
    const out = intlDate.format(new Date('2026-09-28T12:00:00Z'));
    expect(out).toContain('2026');
    expect(out.length).toBeGreaterThan(4);
  });

  it('supports time-only and date-only output', () => {
    const d = new Date('2026-09-28T12:00:00Z');
    expect(intlDate.format(d, { withoutDate: true })).not.toContain('2026');
    expect(intlDate.format(d, { withoutTime: true })).toContain('2026');
  });

  it('toTimezone returns a string (possibly empty), never throws', () => {
    expect(typeof intlDate.toTimezone(new Date())).toBe('string');
  });
});
