import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BN } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import handler from './partner';
import { getConnection, getDbcClient } from '@/lib/solana';
import { mockReqRes } from '@/test-support/http';
import { randomAddress } from '@/test-support/db';

vi.mock('@/lib/solana', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/solana')>();
  return { ...actual, getDbcClient: vi.fn(), getConnection: vi.fn() };
});

const mockGetDbcClient = vi.mocked(getDbcClient);
const mockGetConnection = vi.mocked(getConnection);

const poolAddress = randomAddress();
const feeWallet = Keypair.generate();
const FEE_WALLET_B58 = feeWallet.publicKey.toBase58();

function mockRpc(opts: { feeClaimer?: string; partnerBase?: string; partnerQuote?: string } = {}) {
  mockGetDbcClient.mockReturnValue({
    state: {
      getPool: vi.fn(async () => ({
        poolState: { config: new PublicKey(randomAddress()) },
      })),
      getPoolConfig: vi.fn(async () => ({
        config: { feeClaimer: new PublicKey(opts.feeClaimer ?? FEE_WALLET_B58) },
      })),
      getPoolFeeMetrics: vi.fn(async () => ({
        current: {
          partnerBaseFee: new BN(opts.partnerBase ?? '100'),
          partnerQuoteFee: new BN(opts.partnerQuote ?? '200'),
          creatorBaseFee: new BN('0'),
          creatorQuoteFee: new BN('0'),
        },
        total: {
          totalTradingBaseFee: new BN('0'),
          totalTradingQuoteFee: new BN('0'),
        },
      })),
    },
    partner: {
      claimPartnerTradingFee: vi.fn(async () => new Transaction()),
      partnerWithdrawMigrationFee: vi.fn(async () => new Transaction()),
      claimPartnerPoolCreationFee: vi.fn(async () => new Transaction()),
    },
  } as unknown as DynamicBondingCurveClient);
  mockGetConnection.mockReturnValue({
    getLatestBlockhash: vi.fn(async () => ({ blockhash: 'B'.repeat(44), lastValidBlockHeight: 1 })),
    sendRawTransaction: vi.fn(async () => 'sig123'),
    getSignatureStatus: vi.fn(async () => ({
      value: { confirmationStatus: 'confirmed', err: null },
    })),
  } as unknown as Connection);
}

beforeEach(() => {
  process.env.CURV_CLAIM_SECRET = 'test-claim-secret';
  process.env.CURV_FEE_WALLET_SECRET = bs58.encode(feeWallet.secretKey);
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.CURV_CLAIM_SECRET;
  delete process.env.CURV_FEE_WALLET_SECRET;
});

function post(body: unknown, secret: string | null = 'test-claim-secret') {
  const headers: Record<string, string> = {};
  if (secret !== null) headers['x-claim-secret'] = secret;
  return mockReqRes('POST', { body, headers });
}

describe('POST /api/claims/partner', () => {
  it('rejects non-POST', async () => {
    const { req, res } = mockReqRes('GET');
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects a missing claim secret', async () => {
    mockRpc();
    const { req, res } = post({ poolAddress, kind: 'trading' }, null);
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong claim secret', async () => {
    mockRpc();
    const { req, res } = post({ poolAddress, kind: 'trading' }, 'wrong');
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a bad pool address', async () => {
    mockRpc();
    const { req, res } = post({ poolAddress: 'nope', kind: 'trading' });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown kind', async () => {
    mockRpc();
    const { req, res } = post({ poolAddress, kind: 'everything' });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('refuses pools whose feeClaimer is not our wallet', async () => {
    mockRpc({ feeClaimer: randomAddress() });
    const { req, res } = post({ poolAddress, kind: 'trading' });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/feeClaimer/i);
  });

  it('reports nothing-to-claim without sending a transaction', async () => {
    mockRpc({ partnerBase: '0', partnerQuote: '0' });
    const { req, res } = post({ poolAddress, kind: 'trading' });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      signature: null,
      claimed: false,
      reason: 'nothing to claim',
    });
    expect(mockGetConnection().sendRawTransaction).not.toHaveBeenCalled();
  });

  it('claims trading fees and returns the signature', async () => {
    mockRpc();
    const { req, res } = post({ poolAddress, kind: 'trading' });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.claimed).toBe(true);
    expect(res.body.signature).toBe('sig123');
    expect(res.body.kind).toBe('trading');
    expect(mockGetDbcClient().partner.claimPartnerTradingFee).toHaveBeenCalled();
  });

  it('withdraws the migration fee', async () => {
    mockRpc();
    const { req, res } = post({ poolAddress, kind: 'migration' });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.claimed).toBe(true);
    expect(mockGetDbcClient().partner.partnerWithdrawMigrationFee).toHaveBeenCalledWith({
      pool: new PublicKey(poolAddress),
      sender: new PublicKey(FEE_WALLET_B58),
    });
  });

  it('claims the pool creation fee', async () => {
    mockRpc();
    const { req, res } = post({ poolAddress, kind: 'creation' });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.claimed).toBe(true);
    expect(mockGetDbcClient().partner.claimPartnerPoolCreationFee).toHaveBeenCalled();
  });

  it('reports a confirmed claim', async () => {
    mockRpc();
    const { req, res } = post({ poolAddress, kind: 'trading' });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.confirmed).toBe(true);
    expect(mockGetConnection().getSignatureStatus).toHaveBeenCalledWith('sig123', {
      searchTransactionHistory: false,
    });
  });

  it('returns 502 with the signature when the transaction fails on-chain', async () => {
    mockRpc();
    mockGetConnection.mockReturnValue({
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'B'.repeat(44), lastValidBlockHeight: 1 })),
      sendRawTransaction: vi.fn(async () => 'sig123'),
      getSignatureStatus: vi.fn(async () => ({
        value: { confirmationStatus: 'processed', err: { InstructionError: [0, 'Custom'] } },
      })),
    } as unknown as Connection);
    const { req, res } = post({ poolAddress, kind: 'trading' });
    await handler(req, res);
    expect(res.statusCode).toBe(502);
    expect(res.body.claimed).toBe(false);
    expect(res.body.signature).toBe('sig123');
    expect(res.body.error).toMatch(/failed on-chain/i);
  });

  it('fails loudly when the fee wallet secret is missing', async () => {
    delete process.env.CURV_FEE_WALLET_SECRET;
    mockRpc();
    const { req, res } = post({ poolAddress, kind: 'trading' });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/CURV_FEE_WALLET_SECRET/);
  });
});
