import { describe, expect, it } from 'vitest';
import {
  duplicateGate,
  formatGate,
  liquidityGate,
  runGates,
  universeGate,
  unlockAttestationGate,
  type CandidateInput,
  type MarketSnapshot,
  type UniverseEntry,
} from './gates';

const UNIVERSE: UniverseEntry[] = [
  { baseMint: 'SOL_MINT', symbol: 'SOL', coingeckoId: 'solana', tier: 'core', active: true },
  { baseMint: 'INACTIVE_MINT', symbol: 'OLD', coingeckoId: 'old', tier: 'core', active: false },
  { baseMint: 'SAT_MINT', symbol: 'MID', coingeckoId: 'mid', tier: 'satellite', active: true },
];

function candidate(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    baseMint: 'SOL_MINT',
    baseSymbol: 'SOL',
    quoteMint: 'USDC_MINT',
    quoteSymbol: 'USDC',
    entryLow: 100,
    entryHigh: 105,
    stopPrice: 95,
    targets: [115, 130],
    sizeText: null,
    thesis: 'Uptrend with a clean retest of the broken level and rising volume.',
    noKnownUnlock: true,
    ...over,
  };
}

function market(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    coingeckoId: 'solana',
    price: 150,
    change24hPct: 2,
    change7dPct: 8,
    volume24h: 2_000_000_000,
    volume30dAvg: 1_800_000_000,
    mcap: 70_000_000_000,
    fetchedAt: Date.now(),
    ...over,
  };
}

describe('universeGate', () => {
  it('passes for an active universe coin', () => {
    const r = universeGate(candidate(), UNIVERSE);
    expect(r.status).toBe('pass');
    expect(r.reason).toContain('core');
  });
  it('fails for a coin outside the universe', () => {
    const r = universeGate(candidate({ baseMint: 'RANDOM' }), UNIVERSE);
    expect(r.status).toBe('fail');
  });
  it('fails for an inactive universe coin', () => {
    const r = universeGate(candidate({ baseMint: 'INACTIVE_MINT', baseSymbol: 'OLD' }), UNIVERSE);
    expect(r.status).toBe('fail');
  });
});

describe('duplicateGate', () => {
  it('passes when no live signal covers the coin', () => {
    expect(duplicateGate(candidate(), []).status).toBe('pass');
  });
  it('fails when a live signal already covers the coin', () => {
    const r = duplicateGate(candidate(), ['OTHER_MINT', 'SOL_MINT']);
    expect(r.status).toBe('fail');
    expect(r.reason).toContain('SOL');
  });
});

describe('formatGate', () => {
  it('passes for a coherent zone', () => {
    expect(formatGate(candidate()).status).toBe('pass');
  });
  it('fails when entry low is not below entry high', () => {
    expect(formatGate(candidate({ entryLow: 105, entryHigh: 100 })).status).toBe('fail');
  });
  it('fails when the stop is not below the zone', () => {
    expect(formatGate(candidate({ stopPrice: 102 })).status).toBe('fail');
  });
  it('fails when a target is not above the zone', () => {
    expect(formatGate(candidate({ targets: [103] })).status).toBe('fail');
  });
  it('fails with no targets', () => {
    expect(formatGate(candidate({ targets: [] })).status).toBe('fail');
  });
  it('fails on non positive numbers', () => {
    expect(formatGate(candidate({ entryLow: -5 })).status).toBe('fail');
  });
});

describe('unlockAttestationGate', () => {
  it('passes when attested', () => {
    expect(unlockAttestationGate({ noKnownUnlock: true }).status).toBe('pass');
  });
  it('abstains when not attested', () => {
    const r = unlockAttestationGate({ noKnownUnlock: false });
    expect(r.status).toBe('abstain');
    expect(r.reason).toContain('human');
  });
});

describe('liquidityGate', () => {
  it('passes a liquid core coin', () => {
    const r = liquidityGate(candidate(), 'core', market());
    expect(r.status).toBe('pass');
  });
  it('fails a core coin below the market cap bar', () => {
    const r = liquidityGate(candidate(), 'core', market({ mcap: 500_000_000 }));
    expect(r.status).toBe('fail');
    expect(r.reason).toContain('Market cap');
  });
  it('fails a core coin below the volume bar', () => {
    const r = liquidityGate(candidate(), 'core', market({ volume30dAvg: 10_000_000, volume24h: 10_000_000 }));
    expect(r.status).toBe('fail');
  });
  it('applies the lower satellite bars', () => {
    const m = market({ mcap: 500_000_000, volume30dAvg: 10_000_000, volume24h: 10_000_000 });
    expect(liquidityGate(candidate(), 'satellite', m).status).toBe('pass');
    expect(liquidityGate(candidate(), 'core', m).status).toBe('fail');
  });
  it('abstains when market data is unreachable', () => {
    const r = liquidityGate(candidate(), 'core', null);
    expect(r.status).toBe('abstain');
    expect(r.reason).toContain('human');
  });
  it('falls back to 24h volume when no 30 day average', () => {
    const r = liquidityGate(candidate(), 'core', market({ volume30dAvg: null }));
    expect(r.status).toBe('pass');
  });
});

describe('runGates', () => {
  it('reports gatesClear false when a gate fails, without fetching market data', async () => {
    // baseMint outside the universe: universe gate fails, liquidity abstains.
    const evaled = await runGates(candidate({ baseMint: 'NOPE' }), {
      universe: UNIVERSE,
      liveBaseMints: [],
    });
    expect(evaled.gatesClear).toBe(false);
    expect(evaled.results.find((r) => r.name === 'universe')?.status).toBe('fail');
    expect(evaled.tier).toBeNull();
  });
});
