import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { useTempDb } from '@/test-support/db';
import { mockReqRes } from '@/test-support/http';
import handler from './signals';
import { STRATEGIES_ADMIN_HEADER, SUBSCRIPTION_DURATION_MS } from '@/lib/strategies';
import { insertStrategySignal, recordSubscription } from '@/lib/db/strategies';

const BASE = Keypair.generate().publicKey.toBase58();
const QUOTE = Keypair.generate().publicKey.toBase58();
const wallet = Keypair.generate().publicKey.toBase58();

function signalBody() {
  return {
    baseMint: BASE,
    quoteMint: QUOTE,
    baseSymbol: 'TKN',
    quoteSymbol: 'SOL',
    baseDecimals: 6,
    quoteDecimals: 9,
    entryPrice: 0.5,
    maxPrice: 0.55,
    expiresAt: Date.now() + 3_600_000,
    note: 'route test',
  };
}

describe('GET /api/strategies/signals', () => {
  let db: Awaited<ReturnType<typeof useTempDb>>;
  beforeEach(async () => {
    db = await useTempDb();
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('400 without a wallet', async () => {
    const { req, res } = mockReqRes('GET', { query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('402 with pass info when not subscribed', async () => {
    const { req, res } = mockReqRes('GET', { query: { wallet } });
    await handler(req, res);
    expect(res.statusCode).toBe(402);
    expect(res.body.pass.priceLamports).toBe(50_000_000);
    expect(res.body.error).not.toContain('-');
  });

  it('200 with live signals for a subscriber', async () => {
    await recordSubscription(wallet, 'sig1', SUBSCRIPTION_DURATION_MS, Date.now());
    const live = await insertStrategySignal({
      baseMint: BASE,
      quoteMint: QUOTE,
      baseSymbol: 'TKN',
      quoteSymbol: 'SOL',
      baseDecimals: 6,
      quoteDecimals: 9,
      entryPrice: 0.5,
      maxPrice: 0.55,
      side: 'buy',
      sizeText: null,
      note: null,
      expiresAt: Date.now() + 3_600_000,
    });
    await insertStrategySignal({
      baseMint: BASE,
      quoteMint: QUOTE,
      baseSymbol: 'TKN',
      quoteSymbol: 'SOL',
      baseDecimals: 6,
      quoteDecimals: 9,
      entryPrice: 0.5,
      maxPrice: 0.55,
      side: 'buy',
      sizeText: null,
      note: null,
      expiresAt: Date.now() - 1000,
    });
    const { req, res } = mockReqRes('GET', { query: { wallet } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.signals.map((s: { id: string }) => s.id)).toEqual([live.id]);
  });

  it('402 when the subscription lapsed', async () => {
    await recordSubscription(wallet, 'sig1', 1, Date.now() - 10_000);
    const { req, res } = mockReqRes('GET', { query: { wallet } });
    await handler(req, res);
    expect(res.statusCode).toBe(402);
  });
});

describe('POST /api/strategies/signals', () => {
  let db: Awaited<ReturnType<typeof useTempDb>>;
  const OLD = process.env.STRATEGIES_ADMIN_SECRET;
  beforeEach(async () => {
    db = await useTempDb();
    process.env.STRATEGIES_ADMIN_SECRET = 'test-admin-secret';
  });
  afterEach(async () => {
    await db.cleanup();
    if (OLD === undefined) delete process.env.STRATEGIES_ADMIN_SECRET;
    else process.env.STRATEGIES_ADMIN_SECRET = OLD;
  });

  const authed = (body: unknown, secret = 'test-admin-secret') =>
    mockReqRes('POST', {
      body,
      headers: { [STRATEGIES_ADMIN_HEADER]: secret },
    });

  it('401 without the admin header', async () => {
    const { req, res } = mockReqRes('POST', { body: signalBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('401 with the wrong secret', async () => {
    const { req, res } = authed(signalBody(), 'wrong');
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('401 when no secret is configured (fail closed)', async () => {
    delete process.env.STRATEGIES_ADMIN_SECRET;
    const { req, res } = authed(signalBody());
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('201 publishes a valid signal', async () => {
    const { req, res } = authed(signalBody());
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.signal.baseSymbol).toBe('TKN');
    expect(res.body.signal.status).toBe('active');
  });

  it('400 on invalid input', async () => {
    const { req, res } = authed({ ...signalBody(), maxPrice: 0.1 });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).not.toContain('-');
  });

  it('405 on PUT', async () => {
    const { req, res } = mockReqRes('PUT', {});
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
