import { describe, expect, it } from 'vitest';

import { resolveOutcome, type Kline } from './resolution';

function kline(time: number, low: number, high: number, close?: number): Kline {
  return { time, low, high, open: low, close: close ?? (low + high) / 2 };
}

const BASE = {
  createdAt: 1_000_000,
  expiresAt: 1_000_000 + 48 * 3600_000,
  stopPrice: 121,
  targets: [128, 138],
};

describe('resolveOutcome', () => {
  it('scores a win when the target touches first, even if the stop breaks later', () => {
    // The user's scenario: TP 128 hit, then SL 121 broken, check runs after.
    const klines = [
      kline(1_100_000, 123, 124),
      kline(1_200_000, 124, 128.5), // tags TP 128 -> win here
      kline(1_300_000, 120, 122), // breaks SL 121 later: must not flip the win
    ];
    const r = resolveOutcome(BASE, klines, 2_000_000);
    expect(r.outcome).toBe('win');
    if (r.outcome === 'win') {
      expect(r.resolvedAt).toBe(1_200_000);
      expect(r.resolvedPrice).toBe(128);
    }
  });

  it('scores a loss when the stop breaks first', () => {
    const klines = [kline(1_100_000, 120.5, 123), kline(1_200_000, 122, 129)];
    const r = resolveOutcome(BASE, klines, 2_000_000);
    expect(r.outcome).toBe('loss');
    if (r.outcome === 'loss') expect(r.resolvedPrice).toBe(121);
  });

  it('scores a loss when one candle touches both levels (order unknowable)', () => {
    const klines = [kline(1_100_000, 120, 129)];
    expect(resolveOutcome(BASE, klines, 2_000_000).outcome).toBe('loss');
  });

  it('stays pending while live and untouched', () => {
    const klines = [kline(1_100_000, 122, 126)];
    expect(resolveOutcome(BASE, klines, 1_500_000).outcome).toBe('pending');
  });

  it('expires neutral when the window ends untouched', () => {
    const klines = [kline(1_100_000, 122, 126)];
    const r = resolveOutcome(BASE, klines, BASE.expiresAt + 1000);
    expect(r.outcome).toBe('expired');
  });

  it('ignores candles before publication and after expiry', () => {
    const klines = [
      kline(900_000, 120, 129), // before createdAt: ignored
      kline(BASE.expiresAt + 60_000, 120, 129), // after expiry: ignored
    ];
    const r = resolveOutcome(BASE, klines, BASE.expiresAt + 1000);
    expect(r.outcome).toBe('expired');
  });

  it('expires (never wins/losses) when levels are missing', () => {
    const klines = [kline(1_100_000, 100, 200)];
    const r = resolveOutcome({ ...BASE, stopPrice: null, targets: null }, klines, BASE.expiresAt + 1);
    expect(r.outcome).toBe('expired');
  });
});
