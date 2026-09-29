import { describe, expect, it } from 'vitest';
import { LAUNCH_FEE_CONFIG, buildFeeDisclosureRows, effectiveTradeFeeSplit } from './launch-fees';

describe('LAUNCH_FEE_CONFIG', () => {
  it('carries the exact on-chain economics buildCurveParams uses', async () => {
    // These are the values verified against the Meteora DBC SDK:
    // poolCreationFee is converted via convertToLamports (SOL), the
    // migration feePercentage is divided by 100 (percent), and
    // creatorTradingFeePercentage is validated by the SDK as 0-100
    // (percent of the non-protocol fee share) — 31.51 means the creator
    // keeps 31.51% of the 80% left after Meteora's 20% protocol cut,
    // which is exactly 0.30% of volume at the 1.19% flat trading fee
    // (6x pump.fun's 0.05% creator share); Curv keeps ~0.652%.
    // poolCreationFeeSol is 0.02: pump.fun parity, and the fee is a
    // per-config Curv setting, not a Meteora protocol mandate.
    expect(LAUNCH_FEE_CONFIG.poolCreationFeeSol).toBe(0.02);
    expect(LAUNCH_FEE_CONFIG.migrationFeePercent).toBe(8);
    expect(LAUNCH_FEE_CONFIG.creatorMigrationFeePercent).toBe(25);
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

  it('discloses the 0.02 SOL pool creation fee', async () => {
    expect(byLabel('Pool creation fee').value).toBe('0.02 SOL');
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
    expect(byLabel('Migration fee').value).toBe('8% (you keep 2% of liquidity)');
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
    expect(rows.find((r) => r.label === 'Migration fee')!.value).toBe('20% (you keep 5% of liquidity)');
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
