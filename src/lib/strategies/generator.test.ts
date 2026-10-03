import { describe, expect, it } from 'vitest';
import {
  buildIdea,
  isEligibleMomentum,
  scoreMomentum,
  type MomentumSnapshot,
} from './generator';
import type { UniverseEntry } from './gates';

const ENTRY: UniverseEntry = {
  baseMint: 'SOL_MINT',
  symbol: 'SOL',
  coingeckoId: 'solana',
  tier: 'core',
  active: true,
};

function snap(over: Partial<MomentumSnapshot> = {}): MomentumSnapshot {
  return {
    coingeckoId: 'solana',
    price: 200,
    change7dPct: 5,
    change14dPct: 8,
    change30dPct: 12,
    volume24h: 1_000_000_000,
    mcap: 100_000_000_000,
    ...over,
  };
}

describe('scoreMomentum', () => {
  it('blends 30d, 14d and 7d with the documented weights', () => {
    // 0.5 * 12 + 0.3 * 8 + 0.2 * 5 = 9.4
    expect(scoreMomentum(snap())).toBeCloseTo(9.4, 6);
  });

  it('returns null when the 7d or 30d leg is missing', () => {
    expect(scoreMomentum(snap({ change7dPct: null }))).toBeNull();
    expect(scoreMomentum(snap({ change30dPct: null }))).toBeNull();
  });

  it('falls back to the average of 7d and 30d when 14d is missing', () => {
    // 0.5 * 12 + 0.3 * ((5 + 12) / 2) + 0.2 * 5 = 9.55
    expect(scoreMomentum(snap({ change14dPct: null }))).toBeCloseTo(9.55, 6);
  });
});

describe('isEligibleMomentum', () => {
  it('accepts positive momentum', () => {
    expect(isEligibleMomentum(snap())).toBe(true);
  });

  it('rejects flat or negative momentum', () => {
    expect(isEligibleMomentum(snap({ change7dPct: -5, change14dPct: -6, change30dPct: -8 }))).toBe(
      false,
    );
    expect(isEligibleMomentum(snap({ change7dPct: 0, change14dPct: 0, change30dPct: 0 }))).toBe(
      false,
    );
  });

  it('rejects parabolic 7d chases', () => {
    expect(isEligibleMomentum(snap({ change7dPct: 45 }))).toBe(false);
  });

  it('rejects extended 30d moves', () => {
    expect(isEligibleMomentum(snap({ change30dPct: 250 }))).toBe(false);
  });
});

describe('buildIdea', () => {
  it('builds a complete candidate around the market price', () => {
    const idea = buildIdea(ENTRY, snap(), 9.4, 1, 3);
    expect(idea.input.baseSymbol).toBe('SOL');
    expect(idea.input.entryLow).toBeCloseTo(198, 6);
    expect(idea.input.entryHigh).toBeCloseTo(201, 6);
    expect(idea.input.stopPrice).toBeCloseTo(186, 6);
    expect(idea.input.targets).toHaveLength(2);
    expect(idea.input.targets[0]).toBeCloseTo(224, 6);
    expect(idea.input.targets[1]).toBeCloseTo(244, 6);
    expect(idea.input.stopPrice).toBeLessThan(idea.input.entryLow);
    expect(idea.input.targets[0]).toBeGreaterThan(idea.input.entryHigh);
    expect(idea.input.quoteSymbol).toBe('USDC');
    expect(idea.input.thesis).toContain('rank 1 of 3');
    expect(idea.input.thesis).toContain('SOL');
    expect(idea.rank).toBe(1);
    expect(idea.of).toBe(3);
  });

  it('does not claim an unlock attestation the engine cannot make', () => {
    const idea = buildIdea(ENTRY, snap(), 9.4, 1, 1);
    expect(idea.input.noKnownUnlock).toBe(false);
  });
});
