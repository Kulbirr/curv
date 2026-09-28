import { describe, expect, it } from 'vitest';
import { STALE_AFTER_MS, isSampleStale } from './config';

describe('isSampleStale', () => {
  it('treats missing or invalid timestamps as stale (honest default)', async () => {
    expect(isSampleStale(null, 1000)).toBe(true);
    expect(isSampleStale(undefined, 1000)).toBe(true);
    expect(isSampleStale(NaN, 1000)).toBe(true);
  });

  it('is fresh inside the window, stale outside it', async () => {
    const now = 1_000_000;
    expect(isSampleStale(now - STALE_AFTER_MS + 1, now)).toBe(false);
    expect(isSampleStale(now - STALE_AFTER_MS - 1, now)).toBe(true);
  });

  it('uses a strict greater-than at the boundary', async () => {
    const now = 1_000_000;
    expect(isSampleStale(now - STALE_AFTER_MS, now)).toBe(false);
  });

  it('defaults to a 30s staleness window', async () => {
    expect(STALE_AFTER_MS).toBe(30_000);
  });
});

describe('sanitizeConnectionString', () => {
  it('strips sslmode=require so the explicit ssl option is not overridden', async () => {
    const { sanitizeConnectionString } = await import('./index');
    const out = sanitizeConnectionString(
      'postgres://u:p@host.example:10290/db?sslmode=require',
    );
    expect(out).not.toContain('sslmode');
    expect(out).toContain('host.example:10290/db');
  });

  it('keeps other query params and returns unparseable input untouched', async () => {
    const { sanitizeConnectionString } = await import('./index');
    const out = sanitizeConnectionString(
      'postgres://u:p@host.example/db?sslmode=require&connect_timeout=10',
    );
    expect(out).toContain('connect_timeout=10');
    expect(out).not.toContain('sslmode');
    expect(sanitizeConnectionString('not a url')).toBe('not a url');
  });
});
