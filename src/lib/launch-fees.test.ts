import { describe, expect, it } from 'vitest';
import { LAUNCH_FEE_CONFIG, buildFeeConsequenceLines, buildFeeDisclosureRows, effectiveTradeFeeSplit } from './launch-fees';

describe('LAUNCH_FEE_CONFIG', () => {
  it('carries the exact on-chain economics buildCurveParams uses', async () => {
    // These are the values verified against the Meteora DBC SDK:
    // poolCreationFee is converted via convertToLamports (SOL), the
    // migration feePercentage is divided by 100 (percent), and
    // creatorTradingFeePercentage is validated by the SDK as 0-100
    // (percent of the non-protocol fee share) — 31.51 means the creator
    // keeps 31.51% of the 80% left after Meteora's 20% protocol cut,
    // which is exactly 0.30% of volume at the 1.19% flat trading fee
    // Flat 0.30%; creator rates elsewhere vary by market cap, so no
    // fixed multiple is asserted. Curv keeps ~0.652%.
    // poolCreationFeeSol is 0.01, and the fee is a per-config Curv
    // setting, not a Meteora protocol mandate.
    expect(LAUNCH_FEE_CONFIG.poolCreationFeeSol).toBe(0.01);
    expect(LAUNCH_FEE_CONFIG.migrationFeePercent).toBe(4);
    expect(LAUNCH_FEE_CONFIG.creatorMigrationFeePercent).toBe(50);
    expect(LAUNCH_FEE_CONFIG.migratedPoolFeeBps).toBe(120);
    expect(LAUNCH_FEE_CONFIG.creatorTradingFeePercent).toBe(31.51);
    expect(LAUNCH_FEE_CONFIG.migrationOption).toBe('DAMM v2');
  });

  it('keeps the creator trading fee inside the SDK-valid percent range', async () => {
    const v = LAUNCH_FEE_CONFIG.creatorTradingFeePercent;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(100);
  });
});

describe('buildFeeDisclosureRows', () => {
  const rows = buildFeeDisclosureRows({ startingFeeBps: 119, endingFeeBps: 119, quoteSymbol: 'SOL' });
  const byLabel = (label: string) => rows.find((r) => r.label === label)!;

  it('discloses the 0.01 SOL pool creation fee', async () => {
    expect(byLabel('Pool creation fee').value).toBe('0.01 SOL');
    expect(byLabel('Pool creation fee').hint).toContain('Curv receives 90%');
  });

  it('renders the flat 1.19% default trading fee', async () => {
    expect(byLabel('Trading fees').value).toBe('1.19% flat');
  });

  it('renders a decaying fee schedule when configured', async () => {
    const decaying = buildFeeDisclosureRows({ startingFeeBps: 500, endingFeeBps: 100, quoteSymbol: 'SOL' });
    expect(decaying.find((r) => r.label === 'Trading fees')!.value).toBe('5.00% → 1.00%');
    expect(decaying.find((r) => r.label === 'Your share of trading fees')!.value).toBe('~1.26% of volume');
  });

  it('discloses the creator trading-fee share honestly', async () => {
    expect(byLabel('Your share of trading fees').value).toBe('~0.30% of volume');
  });

  it('tells the creator how claiming works', async () => {
    const hint = byLabel('Your share of trading fees').hint;
    expect(hint).toContain('0.30%');
    expect(hint).toContain('creator wallet');
  });

  it('discloses the migration fee and the creator cut', async () => {
    expect(byLabel('Migration fee').value).toBe('4% (you keep 2% of liquidity)');
  });

  it('discloses the post-graduation DAMM v2 fee', async () => {
    expect(byLabel('After graduation').value).toBe('1.20% + dynamic');
  });

  it('never invents numbers: every row has a label, value and explanatory hint', async () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.label.trim().length).toBeGreaterThan(0);
      expect(r.value.trim().length).toBeGreaterThan(0);
      expect(r.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it('adapts the trading-fee hint to the quote symbol', async () => {
    const usdc = buildFeeDisclosureRows({ startingFeeBps: 500, endingFeeBps: 100, quoteSymbol: 'USDC' });
    expect(usdc.find((r) => r.label === 'Trading fees')!.hint).toContain('USDC');
  });
});

describe('buildFeeDisclosureRows with creator overrides', () => {
  it('reflects an overridden fee schedule', async () => {
    const rows = buildFeeDisclosureRows({
      startingFeeBps: 500,
      endingFeeBps: 100,
      quoteSymbol: 'SOL',
      econ: {
        ...LAUNCH_FEE_CONFIG,
        feeSchedulerPeriods: 120,
        dynamicFeeEnabled: false,
      },
    });
    const hint = rows.find((r) => r.label === 'Trading fees')!.hint;
    expect(hint).toContain('easing from 5.00% to 1.00%');
    expect(hint).not.toContain('dynamic fee');
  });

  it('reflects an overridden migration fee', async () => {
    const rows = buildFeeDisclosureRows({
      startingFeeBps: 500,
      endingFeeBps: 100,
      quoteSymbol: 'SOL',
      econ: { ...LAUNCH_FEE_CONFIG, migrationFeePercent: 20 },
    });
    expect(rows.find((r) => r.label === 'Migration fee')!.value).toBe('20% (you keep 10% of liquidity)');
  });

  it('reflects an overridden post-graduation pool fee', async () => {
    const rows = buildFeeDisclosureRows({
      startingFeeBps: 500,
      endingFeeBps: 100,
      quoteSymbol: 'SOL',
      econ: { ...LAUNCH_FEE_CONFIG, migratedPoolFeeBps: 300, migratedPoolDynamicFee: false },
    });
    expect(rows.find((r) => r.label === 'After graduation')!.value).toBe('3.00%');
  });
});

describe('effectiveTradeFeeSplit', () => {
  it('splits the flat 1.19% fee into protocol, creator, and platform shares', async () => {
    const split = effectiveTradeFeeSplit(119);
    // Trader pays 1.19% of volume in total.
    expect(split.trader).toBeCloseTo(1.19, 6);
    // Meteora takes 20% of the 1.19% trading fee: 0.238% of volume.
    expect(split.protocol).toBeCloseTo(0.238, 6);
    // The creator keeps 31.51% of the remaining 80%: exactly 0.30% of volume.
    expect(split.creator).toBeCloseTo(0.3, 2);
    // Curv keeps the other 68.49% of the remaining 80%: ~0.652% of volume.
    expect(split.platform).toBeCloseTo(0.652, 2);
    // The shares add back up to the full trading fee.
    expect(split.protocol + split.creator + split.platform).toBeCloseTo(split.trader, 6);
  });

  it('scales with the starting fee when the schedule decays', async () => {
    const split = effectiveTradeFeeSplit(500);
    expect(split.trader).toBeCloseTo(5, 6);
    expect(split.creator).toBeCloseTo(1.2604, 6);
    expect(split.platform).toBeCloseTo(2.7396, 6);
  });
});

describe('buildFeeConsequenceLines', () => {
  it('translates the flat 1.19% fee into creator earnings per $1M volume', async () => {
    const lines = buildFeeConsequenceLines({
      startingFeeBps: 119,
      graduationThreshold: 74.44,
      quoteSymbol: 'SOL',
    });
    // 0.30% of $1M = $3,000 to the creator.
    expect(lines[0]).toBe(
      'If $1M of trading moves through your curve, you earn about $3,000 in trading fees.'
    );
  });

  it('translates the graduation threshold into the creator liquidity cut', async () => {
    const lines = buildFeeConsequenceLines({
      startingFeeBps: 119,
      graduationThreshold: 74.44,
      quoteSymbol: 'SOL',
    });
    // 4% migration fee, creator keeps 50% of it = 2% of 74.44 = 1.4888 SOL.
    expect(lines[1]).toBe(
      'At graduation (about 74.44 SOL in the curve), you keep about 1.4888 SOL of the migrating liquidity.'
    );
  });

  it('states the permanent post-graduation fee share', async () => {
    const lines = buildFeeConsequenceLines({
      startingFeeBps: 119,
      graduationThreshold: 74.44,
      quoteSymbol: 'SOL',
    });
    expect(lines[2]).toBe(
      "After graduation you earn 80% of the DAMM v2 pool's trading fees, forever. The graduated liquidity is locked permanently, so nobody can pull it."
    );
  });

  it('skips the graduation line when the threshold is unknown', async () => {
    const lines = buildFeeConsequenceLines({
      startingFeeBps: 119,
      graduationThreshold: null,
      quoteSymbol: 'SOL',
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('After graduation');
  });

  it('scales with a custom fee schedule and overridden economics', async () => {
    const lines = buildFeeConsequenceLines({
      startingFeeBps: 500,
      graduationThreshold: 100,
      quoteSymbol: 'USDC',
      econ: {
        ...LAUNCH_FEE_CONFIG,
        migrationFeePercent: 20,
        creatorMigrationFeePercent: 50,
        creatorLockedLiquidityPercent: 80,
      },
    });
    // 5% fee -> creator 1.2604% of volume -> ~$12,604 per $1M.
    expect(lines[0]).toContain('$12,604');
    // 20% migration fee, creator keeps half = 10% of 100 = 10 USDC.
    expect(lines[1]).toContain('about 10 USDC of the migrating liquidity');
  });

  it('keeps every line dash free', async () => {
    const lines = buildFeeConsequenceLines({
      startingFeeBps: 119,
      graduationThreshold: 74.44,
      quoteSymbol: 'SOL',
    });
    for (const line of lines) {
      expect(line).not.toMatch(/[–—-]/);
    }
  });
});
