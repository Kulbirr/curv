import { describe, expect, it } from 'vitest';
import { BN } from '@coral-xyz/anchor';
import { LAUNCH_FEE_CONFIG } from './launch-fees';
import { planBuyback, planDistribution } from './fee-split-claim';
import { parseUiAmountToRaw, applySlippageBps } from './swap-math';

/**
 * Full lifecycle scenarios: launch -> buy -> sell -> accrue -> claim ->
 * graduate -> post-grad fees. Nobody should get stuck anywhere.
 *
 * All math uses integer raw units (lamports). SOL = 9 decimals.
 * Fees accrue in the QUOTE asset on SOL-quoted pools.
 */

const SOL = 1_000_000_000;

// Fee constants from the live config
const TRADING_FEE_PCT = 1.19;
const METEORA_CUT = 0.2; // 20% of trading fee
const CREATOR_TRADING_FEE_PERCENT = LAUNCH_FEE_CONFIG.creatorTradingFeePercent; // 31.51
const MIGRATION_FEE_PERCENT = LAUNCH_FEE_CONFIG.migrationFeePercent; // 4
const CREATOR_MIGRATION_SHARE = LAUNCH_FEE_CONFIG.creatorMigrationFeePercent; // 50
const DAMM_FEE_BPS = LAUNCH_FEE_CONFIG.migratedPoolFeeBps; // 120 = 1.20%

/** Split $10k of volume through the bonding-curve fee schedule. Returns lamports. */
function bondingCurveFees(volumeSol: number) {
  const volumeRaw = Math.round(volumeSol * SOL);
  const totalFee = Math.floor((volumeRaw * TRADING_FEE_PCT) / 100);
  const meteora = Math.floor(totalFee * METEORA_CUT);
  const distributable = totalFee - meteora;
  const creator = Math.floor((distributable * CREATOR_TRADING_FEE_PERCENT) / 100);
  const curv = distributable - creator;
  return { volumeRaw, totalFee, meteora, creator, curv };
}

describe('lifecycle: bonding curve fee math never loses or creates money', () => {
  it('every lamport of fee is accounted for across a full buy and sell', () => {
    // Buy 10 SOL, then sell it all back. Fees accrue in quote (SOL here).
    const buy = bondingCurveFees(10);
    const sell = bondingCurveFees(10);
    for (const leg of [buy, sell]) {
      expect(leg.meteora + leg.creator + leg.curv).toBe(leg.totalFee);
      expect(leg.totalFee).toBeGreaterThan(0);
    }
    // Creator rate is exactly 0.30% of volume
    expect(buy.creator / buy.volumeRaw).toBeCloseTo(0.003, 4);
    // Curv keeps ~0.652% of volume
    expect(buy.curv / buy.volumeRaw).toBeCloseTo(0.00652, 4);
  });

  it('dust trades do not break accounting: fees floor to zero cleanly', () => {
    // 1 lamport trade: fee math must not produce negative or NaN
    const tiny = bondingCurveFees(0.000000001);
    expect(tiny.totalFee).toBe(0);
    expect(tiny.meteora + tiny.creator + tiny.curv).toBe(0);
  });

  it('slippage guard never inverts: min-out is always below quoted out', () => {
    const quoted = new BN('1500000000');
    const minOut = applySlippageBps(quoted, 100); // 1% slippage
    expect(minOut.lt(quoted)).toBe(true);
    expect(minOut.gtn(0)).toBe(true);
  });

  it('zero and garbage amounts are rejected before a transaction is built', () => {
    expect(parseUiAmountToRaw('0', 9)).toBeNull();
    expect(parseUiAmountToRaw('', 9)).toBeNull();
    expect(parseUiAmountToRaw('-5', 9)).toBeNull();
    expect(parseUiAmountToRaw('abc', 9)).toBeNull();
  });
});

describe('lifecycle: claim with fee splits and buyback', () => {
  // Fees accrue in the QUOTE asset on SOL-quoted pools: base is '0'.
  const accrued = String(10 * SOL); // 10 SOL of creator fees accrued
  const recipients = [
    { wallet: 'walletA', bps: 3000 }, // 30%
    { wallet: 'walletB', bps: 2000 }, // 20%
  ];
  const creatorBps = 10_000 - 3000 - 2000; // 50%

  it('recipients take gross bps, buyback takes from the creator remainder only', () => {
    const dist = planDistribution('0', accrued, recipients);
    expect(dist.length).toBe(2);
    // 30% + 20% = 50% of gross to recipients
    const paid = dist.reduce((s, d) => s + BigInt(d.quoteRaw), BigInt(0));
    expect(paid).toBe(BigInt(5 * SOL));

    // 98% buyback applies to the creator's 5 SOL remainder, not the 10 SOL gross
    const bb = planBuyback('0', accrued, creatorBps, 9800, 'vault111');
    expect(bb).not.toBeNull();
    expect(BigInt(bb!.quoteRaw)).toBe(BigInt(Math.floor((5 * SOL * 9800) / 10_000)));
    // Creator nets 2% of their remainder = 0.1 SOL
    const creatorNet = BigInt(5 * SOL) - BigInt(bb!.quoteRaw);
    expect(creatorNet).toBe(BigInt(Math.floor((5 * SOL * 200) / 10_000)));
    // Parts never exceed the whole
    expect(paid + BigInt(bb!.quoteRaw) + creatorNet).toBeLessThanOrEqual(BigInt(accrued));
  });

  it('buyback at 100% leaves the creator zero but recipients whole', () => {
    const bb = planBuyback('0', accrued, creatorBps, 10_000, 'vault111');
    expect(bb).not.toBeNull();
    expect(BigInt(bb!.quoteRaw)).toBe(BigInt(5 * SOL));
    const dist = planDistribution('0', accrued, recipients);
    const paid = dist.reduce((s, d) => s + BigInt(d.quoteRaw), BigInt(0));
    expect(paid).toBe(BigInt(5 * SOL)); // recipients untouched
  });

  it('buyback at 0% returns null: no diversion, creator keeps remainder', () => {
    expect(planBuyback('0', accrued, creatorBps, 0, 'vault111')).toBeNull();
  });

  it('claim with nothing accrued produces no payouts and no buyback', () => {
    expect(planDistribution('0', '0', recipients)).toEqual([]);
    expect(planBuyback('0', '0', creatorBps, 9800, 'vault111')).toBeNull();
  });

  it('10 recipients at max split still cannot exceed the gross', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ wallet: `w${i}`, bps: 900 }));
    const dist = planDistribution('0', accrued, ten);
    const paid = dist.reduce((s, d) => s + BigInt(d.quoteRaw), BigInt(0));
    expect(paid).toBeLessThanOrEqual(BigInt(accrued));
  });
});

describe('lifecycle: graduation and post-grad fees', () => {
  it('migration fee splits 2% creator / 2% Curv of the migrating liquidity', () => {
    const migratingRaw = BigInt(50_000 * SOL); // $50k tier in SOL terms
    const fee = (migratingRaw * BigInt(MIGRATION_FEE_PERCENT)) / BigInt(100);
    const creator = (fee * BigInt(CREATOR_MIGRATION_SHARE)) / BigInt(100);
    const curv = fee - creator;
    expect(creator).toBe((migratingRaw * BigInt(2)) / BigInt(100));
    expect(curv).toBe((migratingRaw * BigInt(2)) / BigInt(100));
    expect(creator + curv).toBe(fee);
  });

  it('post-grad DAMM v2 fees split 80/20 after Meteora takes 20%', () => {
    const volumeRaw = BigInt(1_000_000 * SOL);
    const poolFee = (volumeRaw * BigInt(DAMM_FEE_BPS)) / BigInt(10000);
    const meteora = (poolFee * BigInt(20)) / BigInt(100);
    const lpFees = poolFee - meteora;
    const creator = (lpFees * BigInt(80)) / BigInt(100);
    const curv = lpFees - creator;
    expect(creator + curv + meteora).toBe(poolFee);
    // Creator earns ~0.768% of post-grad volume, Curv ~0.192%
    expect(Number(creator) / Number(volumeRaw)).toBeCloseTo(0.00768, 4);
    expect(Number(curv) / Number(volumeRaw)).toBeCloseTo(0.00192, 4);
  });
});

describe('lifecycle: parasite-scale volume through Curv economics', () => {
  it('$10M volume: every dollar of fee is attributed, nothing stuck', () => {
    // Model: 60% of volume pre-graduation (bonding curve), 40% post (DAMM v2)
    const totalVol = 10_000_000;
    const preVol = totalVol * 0.6;
    const postVol = totalVol * 0.4;

    // Pre-grad: 1.19% fee, 20% Meteora, then 31.51% creator / 68.49% Curv
    const preFee = preVol * 0.0119;
    const preMeteora = preFee * 0.2;
    const preDist = preFee - preMeteora;
    const preCreator = preDist * 0.3151;
    const preCurv = preDist - preCreator;

    // Post-grad: 1.20% pool fee, 20% Meteora, then 80% creator / 20% Curv
    const postFee = postVol * 0.012;
    const postMeteora = postFee * 0.2;
    const postDist = postFee - postMeteora;
    const postCreator = postDist * 0.8;
    const postCurv = postDist - postCreator;

    // Migration: 2% of ~$50k graduating liquidity to each side
    const migEach = 50_000 * 0.02;

    const creatorTotal = preCreator + postCreator + migEach;
    const curvTotal = preCurv + postCurv + migEach;
    const meteoraTotal = preMeteora + postMeteora;

    // Conservation: all fee dollars accounted for
    const allFees = preFee + postFee + migEach * 2;
    expect(creatorTotal + curvTotal + meteoraTotal).toBeCloseTo(allFees, 2);

    // Sanity: Curv's platform take is a multiple of a pure protocol cut
    expect(curvTotal).toBeGreaterThan(40_000);
    expect(creatorTotal).toBeGreaterThan(40_000);
  });
});
