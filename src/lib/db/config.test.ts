import { describe, expect, it } from 'vitest';
import { STALE_AFTER_MS, isSampleStale } from './config';

describe('isSampleStale', () => {
  it('treats missing or invalid timestamps as stale (honest default)', () => {
    expect(isSampleStale(null, 1000)).toBe(true);
    expect(isSampleStale(undefined, 1000)).toBe(true);
    expect(isSampleStale(NaN, 1000)).toBe(true);
  });

  it('is fresh inside the window, stale outside it', () => {
    const now = 1_000_000;
    expect(isSampleStale(now - STALE_AFTER_MS + 1, now)).toBe(false);
    expect(isSampleStale(now - STALE_AFTER_MS - 1, now)).toBe(true);
  });

  it('uses a strict greater-than at the boundary', () => {
    const now = 1_000_000;
    expect(isSampleStale(now - STALE_AFTER_MS, now)).toBe(false);
  });

  it('defaults to a 30s staleness window', () => {
    expect(STALE_AFTER_MS).toBe(30_000);
  });
});
