import { describe, expect, it } from 'vitest';
import {
  MIRROR_SLIPPAGE_BPS,
  SUBSCRIPTION_DURATION_MS,
  SUBSCRIPTION_PRICE_LAMPORTS,
  formatCountdown,
  isAdminAuthorized,
  isPriceAcceptable,
  isSignalExpired,
  isSignalLive,
  isSubscriptionActive,
  minOutWithSlippage,
  quoteToBasePrice,
  validateSignalInput,
} from './strategies';

const NOW = 1_800_000_000_000;

function validBody() {
  return {
    baseMint: 'So11111111111111111111111111111111111111112',
    quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    baseSymbol: 'SOL',
    quoteSymbol: 'USDC',
    entryPrice: 100,
    maxPrice: 102,
    expiresAt: NOW + 3_600_000,
    note: 'Trend continuation',
  };
}

describe('signal liveness', () => {
  it('live when active and unexpired', () => {
    expect(isSignalLive({ status: 'active', expiresAt: NOW + 1000 }, NOW)).toBe(true);
  });
  it('not live when expired', () => {
    expect(isSignalExpired({ expiresAt: NOW }, NOW)).toBe(true);
    expect(isSignalLive({ status: 'active', expiresAt: NOW - 1 }, NOW)).toBe(false);
  });
  it('not live when cancelled', () => {
    expect(isSignalLive({ status: 'cancelled', expiresAt: NOW + 1000 }, NOW)).toBe(false);
  });
});

describe('quoteToBasePrice', () => {
  it('computes base price in quote units', () => {
    // 0.1 quote units in for 1 base unit out => 0.1 quote per base.
    expect(quoteToBasePrice('100000000', '1000000', 9, 6)).toBeCloseTo(0.1, 10);
  });
  it('returns null for zero or bad amounts', () => {
    expect(quoteToBasePrice('0', '100', 9, 9)).toBeNull();
    expect(quoteToBasePrice('100', '0', 9, 9)).toBeNull();
    expect(quoteToBasePrice('abc', '100', 9, 9)).toBeNull();
  });
  it('returns null for bad decimals', () => {
    expect(quoteToBasePrice('100', '100', 19, 9)).toBeNull();
    expect(quoteToBasePrice('100', '100', 9, -1)).toBeNull();
  });
});

describe('isPriceAcceptable', () => {
  it('accepts at or under max', () => {
    expect(isPriceAcceptable(102, 102)).toBe(true);
    expect(isPriceAcceptable(99, 102)).toBe(true);
  });
  it('rejects above max and non finite', () => {
    expect(isPriceAcceptable(102.01, 102)).toBe(false);
    expect(isPriceAcceptable(NaN, 102)).toBe(false);
    expect(isPriceAcceptable(0, 102)).toBe(false);
  });
});

describe('minOutWithSlippage', () => {
  it('applies 1 percent', () => {
    expect(minOutWithSlippage(BigInt(1000000), MIRROR_SLIPPAGE_BPS)).toBe(BigInt(990000));
  });
  it('rejects absurd slippage', () => {
    expect(() => minOutWithSlippage(BigInt(100), 10_001)).toThrow();
  });
});

describe('formatCountdown', () => {
  it('formats hours, minutes, seconds', () => {
    expect(formatCountdown(NOW + 7_500_000, NOW)).toBe('2h 5m');
    expect(formatCountdown(NOW + 581_000, NOW)).toBe('9m 41s');
    expect(formatCountdown(NOW + 41_000, NOW)).toBe('41s');
  });
  it('says expired at zero', () => {
    expect(formatCountdown(NOW, NOW)).toBe('expired');
    expect(formatCountdown(NOW - 1, NOW)).toBe('expired');
  });
  it('has no dash characters', () => {
    for (const ms of [7_500_000, 581_000, 41_000, 0, -5]) {
      expect(formatCountdown(NOW + ms, NOW)).not.toContain('-');
    }
  });
});

describe('validateSignalInput', () => {
  it('accepts a valid body and fills known decimals', () => {
    const r = validateSignalInput(validBody(), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.baseMint).toBe('So11111111111111111111111111111111111111112');
      expect(r.input.baseDecimals).toBe(9);
      expect(r.input.quoteDecimals).toBe(6);
      expect(r.input.side).toBe('buy');
    }
  });
  it('fills ETH decimals from the known map', () => {
    const body = validBody();
    body.baseMint = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
    body.baseSymbol = 'ETH';
    const r = validateSignalInput(body, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.baseDecimals).toBe(8);
    }
  });
  it('rejects bad mints and identical mints', () => {
    expect(validateSignalInput({ ...validBody(), baseMint: 'nope' }, NOW).ok).toBe(false);
    const same = validBody();
    same.quoteMint = same.baseMint;
    expect(validateSignalInput(same, NOW).ok).toBe(false);
  });
  it('rejects max below entry', () => {
    const r = validateSignalInput({ ...validBody(), maxPrice: 50 }, NOW);
    expect(r.ok).toBe(false);
  });
  it('rejects past or distant expiry', () => {
    expect(validateSignalInput({ ...validBody(), expiresAt: NOW - 1 }, NOW).ok).toBe(false);
    expect(validateSignalInput({ ...validBody(), expiresAt: NOW + 8 * 24 * 3600_000 }, NOW).ok).toBe(false);
  });
  it('rejects non buy side and bad symbols', () => {
    expect(validateSignalInput({ ...validBody(), side: 'short' }, NOW).ok).toBe(false);
    expect(validateSignalInput({ ...validBody(), baseSymbol: '!!!' }, NOW).ok).toBe(false);
  });
  it('rejects non objects', () => {
    expect(validateSignalInput(null, NOW).ok).toBe(false);
  });
});

describe('isAdminAuthorized', () => {
  it('accepts the exact secret', () => {
    expect(isAdminAuthorized('s3cret', 's3cret')).toBe(true);
  });
  it('rejects wrong, empty, and missing secrets, and fails closed with no configured secret', () => {
    expect(isAdminAuthorized('wrong', 's3cret')).toBe(false);
    expect(isAdminAuthorized('', 's3cret')).toBe(false);
    expect(isAdminAuthorized('s3cret', undefined)).toBe(false);
    expect(isAdminAuthorized('s3cret', '')).toBe(false);
  });
});

describe('subscription helpers', () => {
  it('active only before expiry', () => {
    expect(isSubscriptionActive({ expiresAt: NOW + 1 }, NOW)).toBe(true);
    expect(isSubscriptionActive({ expiresAt: NOW }, NOW)).toBe(false);
    expect(isSubscriptionActive(null, NOW)).toBe(false);
  });
  it('constants are sane', () => {
    expect(SUBSCRIPTION_PRICE_LAMPORTS).toBe(50_000_000);
    expect(SUBSCRIPTION_DURATION_MS).toBe(30 * 24 * 3600 * 1000);
  });
});
