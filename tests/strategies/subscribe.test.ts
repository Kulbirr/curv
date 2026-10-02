import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'crypto';
import { useTempDb } from '@/test-support/db';
import { mockReqRes } from '@/test-support/http';
import handler, { isValidPassPayment } from '@/pages/api/strategies/subscribe';
import { SUBSCRIPTION_PRICE_LAMPORTS } from '@/lib/strategies';

const wallet = Keypair.generate().publicKey.toBase58();
const feeWallet = Keypair.generate().publicKey.toBase58();
const NOW = 1_800_000_000_000;

function sig(): string {
  return bs58.encode(randomBytes(64));
}

function transferTx(opts: {
  source?: string;
  destination?: string;
  lamports?: number;
  err?: unknown;
  blockTime?: number | null;
} = {}) {
  return {
    meta: { err: opts.err ?? null },
    blockTime: opts.blockTime ?? Math.floor(NOW / 1000) - 60,
    transaction: {
      message: {
        instructions: [
          {
            program: 'system',
            parsed: {
              type: 'transfer',
              info: {
                source: opts.source ?? wallet,
                destination: opts.destination ?? feeWallet,
                lamports: opts.lamports ?? SUBSCRIPTION_PRICE_LAMPORTS,
              },
            },
          },
        ],
      },
    },
  };
}

describe('isValidPassPayment', () => {
  it('accepts a correct recent transfer', () => {
    expect(isValidPassPayment(transferTx(), wallet, feeWallet, SUBSCRIPTION_PRICE_LAMPORTS, NOW)).toBe(true);
  });
  it('accepts overpayment', () => {
    expect(
      isValidPassPayment(transferTx({ lamports: SUBSCRIPTION_PRICE_LAMPORTS + 1 }), wallet, feeWallet, SUBSCRIPTION_PRICE_LAMPORTS, NOW),
    ).toBe(true);
  });
  it('rejects failed, missing, stale, and wrong payments', () => {
    expect(isValidPassPayment(null, wallet, feeWallet, SUBSCRIPTION_PRICE_LAMPORTS, NOW)).toBe(false);
    expect(isValidPassPayment(transferTx({ err: 'x' }), wallet, feeWallet, SUBSCRIPTION_PRICE_LAMPORTS, NOW)).toBe(false);
    expect(
      isValidPassPayment(transferTx({ blockTime: Math.floor(NOW / 1000) - 7200 }), wallet, feeWallet, SUBSCRIPTION_PRICE_LAMPORTS, NOW),
    ).toBe(false);
    expect(
      isValidPassPayment(transferTx({ destination: wallet }), wallet, feeWallet, SUBSCRIPTION_PRICE_LAMPORTS, NOW),
    ).toBe(false);
    expect(
      isValidPassPayment(transferTx({ lamports: SUBSCRIPTION_PRICE_LAMPORTS - 1 }), wallet, feeWallet, SUBSCRIPTION_PRICE_LAMPORTS, NOW),
    ).toBe(false);
    expect(
      isValidPassPayment(transferTx({ source: feeWallet }), wallet, feeWallet, SUBSCRIPTION_PRICE_LAMPORTS, NOW),
    ).toBe(false);
  });
});

describe('POST /api/strategies/subscribe', () => {
  let db: Awaited<ReturnType<typeof useTempDb>>;
  const OLD_ENV: Record<string, string | undefined> = {};

  function stubRpc(result: unknown) {
    vi.stubGlobal(
      'fetch',
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ result }),
        }) as Response,
    );
  }

  beforeEach(async () => {
    db = await useTempDb();
    for (const k of ['NEXT_PUBLIC_CURV_FEE_WALLET', 'RPC_PROXY_UPSTREAM_URL', 'SOLANA_RPC_URL']) {
      OLD_ENV[k] = process.env[k];
    }
    process.env.NEXT_PUBLIC_CURV_FEE_WALLET = feeWallet;
    process.env.RPC_PROXY_UPSTREAM_URL = 'https://rpc.example.invalid';
  });
  afterEach(async () => {
    await db.cleanup();
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries(OLD_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('400 on bad wallet or signature', async () => {
    const bad1 = mockReqRes('POST', { body: { wallet: 'nope', signature: sig() } });
    await handler(bad1.req, bad1.res);
    expect(bad1.res.statusCode).toBe(400);
    const bad2 = mockReqRes('POST', { body: { wallet, signature: 'short' } });
    await handler(bad2.req, bad2.res);
    expect(bad2.res.statusCode).toBe(400);
  });

  it('422 when the payment is not on chain yet', async () => {
    stubRpc(null);
    const { req, res } = mockReqRes('POST', { body: { wallet, signature: sig() } });
    await handler(req, res);
    expect(res.statusCode).toBe(422);
  });

  it('422 when the payment is invalid', async () => {
    stubRpc(transferTx({ lamports: 1 }));
    const { req, res } = mockReqRes('POST', { body: { wallet, signature: sig() } });
    await handler(req, res);
    expect(res.statusCode).toBe(422);
  });

  it('200 activates the pass for a valid payment', async () => {
    stubRpc(transferTx());
    const { req, res } = mockReqRes('POST', { body: { wallet, signature: sig() } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('409 when the same signature pays twice', async () => {
    stubRpc(transferTx());
    const signature = sig();
    const first = mockReqRes('POST', { body: { wallet, signature } });
    await handler(first.req, first.res);
    expect(first.res.statusCode).toBe(200);
    const second = mockReqRes('POST', { body: { wallet, signature } });
    await handler(second.req, second.res);
    expect(second.res.statusCode).toBe(409);
  });

  it('503 when the fee wallet is not configured', async () => {
    delete process.env.NEXT_PUBLIC_CURV_FEE_WALLET;
    const { req, res } = mockReqRes('POST', { body: { wallet, signature: sig() } });
    await handler(req, res);
    expect(res.statusCode).toBe(503);
  });
});
