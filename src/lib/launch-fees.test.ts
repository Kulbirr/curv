import { describe, expect, it } from 'vitest';
import { LAUNCH_FEE_CONFIG, buildFeeDisclosureRows } from './launch-fees';

describe('LAUNCH_FEE_CONFIG', () => {
  it('carries the exact on-chain economics buildCurveParams uses', async () => {
    // These are the values verified against the Meteora DBC SDK:
    // poolCreationFee is converted via convertToLamports (SOL), the
    // migration feePercentage is divided by 100 (percent), and
    // creatorTradingFeePercentage is validated by the SDK as 0-100
    // (percent) — 0.3 means 0.3%.
    // poolCreationFeeSol is 0: the SDK accepts zero, and the fee is a
    // per-config Curv setting, not a Meteora protocol mandate.
    expect(LAUNCH_FEE_CONFIG.poolCreationFeeSol).toBe(0);
    expect(LAUNCH_FEE_CONFIG.migrationFeePercent).toBe(10);
    expect(LAUNCH_FEE_CONFIG.creatorMigrationFeePercent).toBe(50);
    expect(LAUNCH_FEE_CONFIG.migratedPoolFeeBps).toBe(120);
    expect(LAUNCH_FEE_CONFIG.creatorTradingFeePercent).toBe(0.3);
    expect(LAUNCH_FEE_CONFIG.migrationOption).toBe('DAMM v2');
  });

  it('keeps the creator trading fee inside the SDK-valid percent range', async () => {
    const v = LAUNCH_FEE_CONFIG.creatorTradingFeePercent;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(100);
  });
});

describe('buildFeeDisclosureRows', () => {
  const rows = buildFeeDisclosureRows({ startingFeeBps: 500, endingFeeBps: 100, quoteSymbol: 'SOL' });
  const byLabel = (label: string) => rows.find((r) => r.label === label)!;

  it('discloses that there is no pool creation fee', async () => {
    expect(byLabel('Pool creation fee').value).toBe('0 SOL');
    expect(byLabel('Pool creation fee').hint).toContain('no pool creation fee');
  });

  it('renders the user-configured trading fee schedule', async () => {
    expect(byLabel('Trading fees').value).toBe('5.00% → 1.00%');
  });

  it('discloses the creator trading-fee share honestly', async () => {
    expect(byLabel('Your share of trading fees').value).toBe('0.3%');
  });

  it('tells the creator how claiming works', async () => {
    const hint = byLabel('Your share of trading fees').hint;
    expect(hint).toContain('0.3%');
    expect(hint).toContain('creator wallet');
  });

  it('discloses the migration fee and the creator cut', async () => {
    expect(byLabel('Migration fee').value).toBe('10% (you keep 50%)');
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
    expect(hint).toContain('120 periods');
    expect(hint).not.toContain('dynamic fee');
  });

  it('reflects an overridden migration fee', async () => {
    const rows = buildFeeDisclosureRows({
      startingFeeBps: 500,
      endingFeeBps: 100,
      quoteSymbol: 'SOL',
      econ: { ...LAUNCH_FEE_CONFIG, migrationFeePercent: 20 },
    });
    expect(rows.find((r) => r.label === 'Migration fee')!.value).toBe('20% (you keep 50%)');
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
