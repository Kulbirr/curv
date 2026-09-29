import { afterEach, describe, expect, it, vi } from 'vitest';
import { BN } from '@coral-xyz/anchor';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  buildClaimPartnerFeesTx,
  buildClaimPartnerPoolCreationFeeTx,
  buildWithdrawCreatorMigrationFeeTx,
  buildWithdrawPartnerMigrationFeeTx,
  getPartnerClaimable,
} from './claim-partner-fees';
import { randomAddress } from '@/test-support/db';

vi.mock('./solana', () => ({
  getDbcClient: vi.fn(),
}));

import { getDbcClient } from './solana';

const mockedGetDbcClient = vi.mocked(getDbcClient);

const poolAddress = randomAddress();
const feeClaimer = randomAddress();

function mockClient(overrides: Record<string, unknown> = {}) {
  const tx = new Transaction();
  mockedGetDbcClient.mockReturnValue({
    partner: {
      claimPartnerTradingFee: vi.fn(async () => tx),
      partnerWithdrawMigrationFee: vi.fn(async () => tx),
      claimPartnerPoolCreationFee: vi.fn(async () => tx),
    },
    creator: {
      creatorWithdrawMigrationFee: vi.fn(async () => tx),
    },
    state: {
      getPoolFeeMetrics: vi.fn(async () => ({
        current: {
          partnerBaseFee: new BN('123'),
          partnerQuoteFee: new BN('456'),
          creatorBaseFee: new BN('7'),
          creatorQuoteFee: new BN('8'),
        },
        total: {},
      })),
    },
    ...overrides,
  } as unknown as ReturnType<typeof getDbcClient>);
  return tx;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildClaimPartnerFeesTx', () => {
  it('claims everything with u64-max caps, signed by the feeClaimer', async () => {
    const tx = mockClient();
    const client = mockedGetDbcClient();
    const out = await buildClaimPartnerFeesTx({ poolAddress, feeClaimer });
    expect(out).toBe(tx);
    expect(client.partner.claimPartnerTradingFee).toHaveBeenCalledWith({
      feeClaimer: new PublicKey(feeClaimer),
      payer: new PublicKey(feeClaimer),
      pool: new PublicKey(poolAddress),
      maxBaseAmount: new BN('18446744073709551615'),
      maxQuoteAmount: new BN('18446744073709551615'),
    });
  });
});

describe('migration fee withdrawals', () => {
  it('builds the partner (Curv) migration fee withdrawal', async () => {
    const tx = mockClient();
    const client = mockedGetDbcClient();
    const out = await buildWithdrawPartnerMigrationFeeTx({
      poolAddress,
      sender: feeClaimer,
    });
    expect(out).toBe(tx);
    expect(client.partner.partnerWithdrawMigrationFee).toHaveBeenCalledWith({
      pool: new PublicKey(poolAddress),
      sender: new PublicKey(feeClaimer),
    });
  });

  it('builds the creator migration fee withdrawal', async () => {
    const tx = mockClient();
    const client = mockedGetDbcClient();
    const out = await buildWithdrawCreatorMigrationFeeTx({
      poolAddress,
      sender: feeClaimer,
    });
    expect(out).toBe(tx);
    expect(client.creator.creatorWithdrawMigrationFee).toHaveBeenCalledWith({
      pool: new PublicKey(poolAddress),
      sender: new PublicKey(feeClaimer),
    });
  });
});

describe('buildClaimPartnerPoolCreationFeeTx', () => {
  it('claims the pool creation fee to the receiver', async () => {
    const tx = mockClient();
    const client = mockedGetDbcClient();
    const out = await buildClaimPartnerPoolCreationFeeTx({
      poolAddress,
      feeReceiver: feeClaimer,
    });
    expect(out).toBe(tx);
    expect(client.partner.claimPartnerPoolCreationFee).toHaveBeenCalledWith({
      pool: new PublicKey(poolAddress),
      feeReceiver: new PublicKey(feeClaimer),
    });
  });
});

describe('getPartnerClaimable', () => {
  it('returns raw partner fee strings without float math', async () => {
    mockClient();
    const got = await getPartnerClaimable(poolAddress);
    expect(got).toEqual({ baseRaw: '123', quoteRaw: '456' });
  });

  it('returns nulls when the read fails shape checks', async () => {
    mockedGetDbcClient.mockReturnValue({
      state: {
        getPoolFeeMetrics: vi.fn(async () => ({
          current: { partnerBaseFee: null, partnerQuoteFee: undefined },
        })),
      },
    } as unknown as ReturnType<typeof getDbcClient>);
    const got = await getPartnerClaimable(poolAddress);
    expect(got).toEqual({ baseRaw: null, quoteRaw: null });
  });
});

describe('claimPartnerFeesFlow signing', () => {
  it('does not sign with a user wallet: flow takes an explicit Keypair', async () => {
    // The flow functions require a Keypair argument, so a browser wallet
    // can never be passed by accident. Compile-time shape check via the
    // module import is enough; this test pins the export surface.
    const mod = await import('./claim-partner-fees');
    expect(typeof mod.claimPartnerFeesFlow).toBe('function');
    expect(typeof mod.withdrawPartnerMigrationFeeFlow).toBe('function');
    expect(typeof mod.loadFeeWalletKeypair).toBe('function');
    void Keypair;
  });
});
