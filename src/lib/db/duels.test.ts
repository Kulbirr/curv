import { describe, expect, it } from 'vitest';
import {
  decideDuelOutcome,
  forfeitApplies,
  forfeitWinnerWallet,
  type Duel,
} from './duels';
import { planDuelForfeit } from '@/lib/fee-split-claim';

function makeDuel(over: Partial<Duel> = {}): Duel {
  return {
    id: 1,
    poolA: 'poolA',
    poolB: 'poolB',
    challengerWallet: 'walletA',
    challengedWallet: 'walletB',
    status: 'settled',
    forfeitScope: 'creator_remainder_window',
    forfeitDays: 90,
    createdAt: 1000,
    activatedAt: 2000,
    expiresAt: 3000,
    settledAt: 4000,
    forfeitEndsAt: 5000,
    winnerPool: 'poolA',
    loserPool: 'poolB',
    ...over,
  };
}

describe('decideDuelOutcome', () => {
  it('A wins when only A graduated', () => {
    expect(decideDuelOutcome(1000, null)).toBe('a');
  });

  it('B wins when only B graduated', () => {
    expect(decideDuelOutcome(null, 2000)).toBe('b');
  });

  it('earlier graduation wins when 60s+ apart', () => {
    expect(decideDuelOutcome(1000, 70000)).toBe('a');
    expect(decideDuelOutcome(70000, 1000)).toBe('b');
  });

  it('draw when both graduate within 60s', () => {
    expect(decideDuelOutcome(1000, 30000)).toBe('draw');
    expect(decideDuelOutcome(30000, 1000)).toBe('draw');
    // Exactly 60s apart is not a draw (window is strict < 60s).
    expect(decideDuelOutcome(1000, 61000)).toBe('a');
  });

  it('none when neither graduated', () => {
    expect(decideDuelOutcome(null, null)).toBe('none');
  });
});

describe('forfeitApplies', () => {
  it('applies to the losing pool inside the window', () => {
    expect(forfeitApplies('poolB', makeDuel(), 4999)).toBe(true);
  });

  it('does not apply 1ms after the window ends', () => {
    expect(forfeitApplies('poolB', makeDuel(), 5000)).toBe(false);
    expect(forfeitApplies('poolB', makeDuel(), 99999)).toBe(false);
  });

  it('does not apply to the winning pool', () => {
    expect(forfeitApplies('poolA', makeDuel(), 4999)).toBe(false);
  });

  it('does not apply when unsettled', () => {
    expect(forfeitApplies('poolB', makeDuel({ status: 'active' }), 4999)).toBe(false);
  });
});

describe('forfeitWinnerWallet', () => {
  it('returns the challenger wallet when pool A won', () => {
    expect(forfeitWinnerWallet(makeDuel())).toBe('walletA');
  });

  it('returns the challenged wallet when pool B won', () => {
    expect(
      forfeitWinnerWallet(makeDuel({ winnerPool: 'poolB', loserPool: 'poolA' })),
    ).toBe('walletB');
  });

  it('returns null when unsettled', () => {
    expect(forfeitWinnerWallet(makeDuel({ status: 'active', winnerPool: null }))).toBe(null);
  });
});

describe('planDuelForfeit', () => {
  it('redirects the remainder after buyback and bounty', () => {
    // Gross 1000 base / 2000 quote, creator holds 10000 bps (no recipients).
    // Buyback 1000 bps (10%) of remainder, bounty 2000 bps (20%).
    // Remainder: 1000 base, 2000 quote. Buyback: 100 base, 200 quote.
    // Bounty: 200 base, 400 quote. Forfeit: 700 base, 1400 quote.
    const plan = planDuelForfeit(
      '1000',
      '2000',
      10000,
      { bps: 1000, baseRaw: '100', quoteRaw: '200', vault: 'v' },
      { bps: 2000, baseRaw: '200', quoteRaw: '400', vault: 'v' },
      7,
      'winnerWallet',
      9999,
    );
    expect(plan).not.toBeNull();
    expect(plan!.baseRaw).toBe('700');
    expect(plan!.quoteRaw).toBe('1400');
    expect(plan!.duelId).toBe(7);
    expect(plan!.winnerWallet).toBe('winnerWallet');
  });

  it('recipients are untouched: forfeit applies to creator bps only', () => {
    // Gross 1000, creator keeps 5000 bps (50%). Forfeit = 500.
    const plan = planDuelForfeit('1000', '0', 5000, null, null, 1, 'w', 9);
    expect(plan!.baseRaw).toBe('500');
  });

  it('returns null when the remainder is zero', () => {
    expect(planDuelForfeit('0', '0', 10000, null, null, 1, 'w', 9)).toBeNull();
  });

  it('returns null when creatorBps is zero', () => {
    expect(planDuelForfeit('1000', '1000', 0, null, null, 1, 'w', 9)).toBeNull();
  });

  it('never redirects a negative amount', () => {
    // Inconsistent inputs: slices exceed the remainder. Clamp to zero → null.
    const plan = planDuelForfeit(
      '100',
      '100',
      10000,
      { bps: 10000, baseRaw: '100', quoteRaw: '100', vault: 'v' },
      { bps: 10000, baseRaw: '100', quoteRaw: '100', vault: 'v' },
      1,
      'w',
      9,
    );
    expect(plan).toBeNull();
  });
});
