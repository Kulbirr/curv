import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { useTempDb } from '@/test-support/db';
import {
  cancelSignal,
  claimPaymentSignature,
  getSignal,
  getSubscription,
  insertStrategySignal,
  listLiveSignals,
  recordSubscription,
} from './strategies';
import { SUBSCRIPTION_DURATION_MS } from '../strategies';

const NOW = 1_800_000_000_000;
const BASE = Keypair.generate().publicKey.toBase58();
const QUOTE = Keypair.generate().publicKey.toBase58();

function input(expiresAt: number = NOW + 3_600_000) {
  return {
    baseMint: BASE,
    quoteMint: QUOTE,
    baseSymbol: 'TKN',
    quoteSymbol: 'SOL',
    baseDecimals: 6,
    quoteDecimals: 9,
    entryPrice: 0.5,
    maxPrice: 0.55,
    side: 'buy' as const,
    sizeText: '1 SOL',
    stopPrice: 0.46,
    targets: [0.56, 0.61],
    note: 'test signal',
    expiresAt,
  };
}

describe('strategy_signals store', () => {
  let db: Awaited<ReturnType<typeof useTempDb>>;
  beforeEach(async () => {
    db = await useTempDb();
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('lists only live signals, newest first', async () => {
    const live1 = await insertStrategySignal(input(NOW + 1000));
    const live2 = await insertStrategySignal(input(NOW + 2000));
    const expired = await insertStrategySignal(input(NOW - 1000));
    await cancelSignal(live1.id);

    const listed = await listLiveSignals(NOW);
    expect(listed.map((s) => s.id)).toEqual([live2.id]);
    expect(listed[0].baseSymbol).toBe('TKN');
    expect(listed[0].status).toBe('active');
    void expired;
  });

  it('round trips a signal by id', async () => {
    const created = await insertStrategySignal(input());
    const fetched = await getSignal(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.maxPrice).toBe(0.55);
    expect(fetched?.note).toBe('test signal');
    expect(await getSignal('sig_missing')).toBeNull();
  });
});

describe('strategy_subscriptions store', () => {
  let db: Awaited<ReturnType<typeof useTempDb>>;
  beforeEach(async () => {
    db = await useTempDb();
  });
  afterEach(async () => {
    await db.cleanup();
  });

  const wallet = Keypair.generate().publicKey.toBase58();

  it('records and reads a subscription', async () => {
    expect(await getSubscription(wallet)).toBeNull();
    const sub = await recordSubscription(wallet, 'sig1', SUBSCRIPTION_DURATION_MS, NOW);
    expect(sub.expiresAt).toBe(NOW + SUBSCRIPTION_DURATION_MS);
    const fetched = await getSubscription(wallet);
    expect(fetched?.txSignature).toBe('sig1');
  });

  it('extends from the current expiry when renewing early', async () => {
    await recordSubscription(wallet, 'sig1', SUBSCRIPTION_DURATION_MS, NOW);
    const renewed = await recordSubscription(wallet, 'sig2', SUBSCRIPTION_DURATION_MS, NOW + 1000);
    expect(renewed.expiresAt).toBe(NOW + 2 * SUBSCRIPTION_DURATION_MS);
  });

  it('restarts from now when renewing after expiry', async () => {
    await recordSubscription(wallet, 'sig1', SUBSCRIPTION_DURATION_MS, NOW);
    const renewed = await recordSubscription(wallet, 'sig2', SUBSCRIPTION_DURATION_MS, NOW + 2 * SUBSCRIPTION_DURATION_MS);
    expect(renewed.expiresAt).toBe(NOW + 3 * SUBSCRIPTION_DURATION_MS);
  });
});

describe('strategy_used_signatures', () => {
  let db: Awaited<ReturnType<typeof useTempDb>>;
  beforeEach(async () => {
    db = await useTempDb();
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('first claim wins', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    expect(await claimPaymentSignature('pay_sig_1', wallet)).toBe(true);
    expect(await claimPaymentSignature('pay_sig_1', wallet)).toBe(false);
  });
});
