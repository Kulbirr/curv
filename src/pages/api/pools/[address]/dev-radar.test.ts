import { describe, expect, it } from 'vitest';
import { pctOfSupply, signedRawToUi } from './dev-radar';
import { relativeTime } from '@/components/Pool/relativeTime';

describe('pctOfSupply', () => {
  it('computes exact percentages from raw integers', () => {
    // 124M of 1B with 9 decimals = 12.4%
    expect(pctOfSupply('124000000000000000', '1000000000000000000')).toBe(12.4);
  });

  it('handles zero balance', () => {
    expect(pctOfSupply('0', '1000000000000000000')).toBe(0);
  });

  it('handles full supply', () => {
    expect(pctOfSupply('1000000000000000000', '1000000000000000000')).toBe(100);
  });

  it('handles dust amounts without float error', () => {
    // 1 lamport-unit of 1B supply = 0.0000001% -> rounds to 0 at 2dp
    expect(pctOfSupply('1', '1000000000000000000')).toBe(0);
  });

  it('returns null on zero supply', () => {
    expect(pctOfSupply('100', '0')).toBeNull();
  });
});

describe('signedRawToUi', () => {
  it('formats positive amounts', () => {
    expect(signedRawToUi('1240000000', 9)).toBe('1.24');
  });

  it('preserves the negative sign', () => {
    expect(signedRawToUi('-1240000000', 9)).toBe('-1.24');
  });

  it('formats zero without a sign', () => {
    expect(signedRawToUi('0', 9)).toBe('0');
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000_000;
  it('says just now under a minute', () => {
    expect(relativeTime(now - 30_000, now)).toBe('just now');
  });
  it('formats minutes', () => {
    expect(relativeTime(now - 14 * 60_000, now)).toBe('14m ago');
  });
  it('formats hours', () => {
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe('2h ago');
  });
  it('formats days', () => {
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3d ago');
  });
});
