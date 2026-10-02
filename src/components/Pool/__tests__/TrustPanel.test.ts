import { describe, expect, it } from 'vitest';
import { devBuyDisplay } from '../TrustPanel';

describe('devBuyDisplay', () => {
  it('renders the amount in quote UI units', () => {
    expect(devBuyDisplay(500_000_000, 9)).toBe('0.5');
    expect(devBuyDisplay(1_000_000, 6)).toBe('1');
  });

  it('returns null when there is no dev buy', () => {
    expect(devBuyDisplay(null, 9)).toBeNull();
    expect(devBuyDisplay(undefined, 9)).toBeNull();
    expect(devBuyDisplay(0, 9)).toBeNull();
  });

  it('returns null when quote decimals are unknown', () => {
    expect(devBuyDisplay(500_000_000, null)).toBeNull();
    expect(devBuyDisplay(500_000_000, undefined)).toBeNull();
  });
});
