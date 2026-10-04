import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { buildClaimAndSplitTransactions, planBuyback, planDistribution } from './fee-split-claim';
import type { FeeSplitRecipient } from './fee-split-terms';

vi.mock('./pool-state', () => ({
  fetchPoolLiveState: vi.fn().mockResolvedValue({
    creatorBaseFeeRaw: '1000000000', // 1.0 base units
    creatorQuoteFeeRaw: '2000000000', // 2.0 quote units
  }),
}));

// Mimics the DBC SDK's claim: one claim instruction plus the wSOL unwrap
// (CloseAccount) it appends for SOL-quoted pools.
vi.mock('./claim-creator-fees', () => ({
  buildClaimCreatorFeesTx: vi.fn().mockImplementation(async (args: { creator: string }) => {
    const creator = new PublicKey(args.creator);
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, creator);
    return {
      instructions: [
        new TransactionInstruction({
          keys: [],
          programId: Keypair.generate().publicKey,
          data: Buffer.from([1, 2, 3]),
        }),
        createCloseAccountInstruction(wsolAta, creator, creator),
      ],
    };
  }),
}));

const wallet = () => Keypair.generate().publicKey.toBase58();

function makeTracked() {
  return {
    poolAddress: wallet(),
    creator: wallet(),
    baseMint: wallet(),
    quoteMint: wallet(),
  } as any;
}

function makeConnection({ accountExists }: { accountExists: boolean }) {
  // Any 32-byte base58 value serializes as a blockhash.
  const fakeBlockhash = Keypair.generate().publicKey.toBase58();
  return {
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: fakeBlockhash }),
    getAccountInfo: vi.fn().mockResolvedValue(accountExists ? { lamports: 1 } : null),
  } as any;
}

function recipients(n: number, bpsEach: number): FeeSplitRecipient[] {
  return Array.from({ length: n }, (_, i) => ({
    wallet: wallet(),
    bps: bpsEach,
    handle: i === 0 ? 'alice' : undefined,
  }));
}

describe('planDistribution', () => {
  it('pays every recipient their exact floored bps share in both assets', () => {
    const rs = recipients(3, 1000); // 10% each
    const plan = planDistribution('1000000000', '2000000000', rs);
    expect(plan).toHaveLength(3);
    for (const p of plan) {
      expect(p.baseRaw).toBe('100000000'); // 10% of 1e9
      expect(p.quoteRaw).toBe('200000000'); // 10% of 2e9
    }
  });

  it('sums to no more than the accrued fees', () => {
    const rs = recipients(10, 900); // 90% total
    const plan = planDistribution('1000000000', '2000000000', rs);
    const baseSum = plan.reduce((s, p) => s + BigInt(p.baseRaw), BigInt(0));
    const quoteSum = plan.reduce((s, p) => s + BigInt(p.quoteRaw), BigInt(0));
    expect(baseSum).toBeLessThanOrEqual(BigInt('1000000000'));
    expect(quoteSum).toBeLessThanOrEqual(BigInt('2000000000'));
    expect(baseSum).toBe(BigInt('900000000'));
  });

  it('drops recipients whose share rounds to zero', () => {
    const rs = recipients(1, 1); // 0.01%
    const plan = planDistribution('100', '200', rs);
    expect(plan).toHaveLength(0);
  });
});

describe('planBuyback', () => {
  const vault = Keypair.generate().publicKey.toBase58();

  it('takes the committed bps of the creator remainder, not the gross', () => {
    // Accrued 1.0 base / 2.0 quote, creator keeps 70% (0.7/1.4),
    // buyback commits 50% of that remainder.
    const plan = planBuyback('1000000000', '2000000000', 7000, 5000, vault);
    expect(plan).not.toBeNull();
    expect(plan!.baseRaw).toBe('350000000'); // 50% of 0.7
    expect(plan!.quoteRaw).toBe('700000000'); // 50% of 1.4
    expect(plan!.bps).toBe(5000);
    expect(plan!.vault).toBe(vault);
  });

  it('leaves recipient shares untouched: remainder plus recipients never exceed gross', () => {
    const rs = recipients(3, 1000); // 30% to recipients
    const dist = planDistribution('1000000000', '2000000000', rs);
    const plan = planBuyback('1000000000', '2000000000', 7000, 10_000, vault);
    const distBase = dist.reduce((s, p) => s + BigInt(p.baseRaw), BigInt(0));
    const remainderBase = BigInt('700000000');
    // Even at 100% buyback of the remainder, recipients + buyback <= gross.
    expect(distBase + BigInt(plan!.baseRaw)).toBeLessThanOrEqual(BigInt('1000000000'));
    expect(distBase + remainderBase).toBeLessThanOrEqual(BigInt('1000000000'));
  });

  it('returns null when buyback is off or the creator keeps nothing', () => {
    expect(planBuyback('1000000000', '2000000000', 7000, 0, vault)).toBeNull();
    expect(planBuyback('1000000000', '2000000000', 0, 5000, vault)).toBeNull();
    expect(planBuyback('100', '200', 7000, 1, vault)).toBeNull(); // rounds to zero
  });

  it('clamps out-of-range bps', () => {
    const plan = planBuyback('1000000000', '2000000000', 10_000, 99_999, vault);
    expect(plan!.bps).toBe(10_000);
    expect(plan!.baseRaw).toBe('1000000000');
  });
});

describe('buildClaimAndSplitTransactions', () => {
  it('keeps every transaction under the size budget with 10 recipients', async () => {
    const build = await buildClaimAndSplitTransactions({
      connection: makeConnection({ accountExists: false }),
      tracked: makeTracked(),
      recipients: recipients(10, 900), // 90% total, the max allowed
    });
    expect(build.distribution).toHaveLength(10);
    expect(build.transactions.length).toBeGreaterThan(0);
    for (const tx of build.transactions) {
      const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
      expect(size).toBeLessThanOrEqual(1200);
    }
  });

  it('spills into follow-up transactions when 10 recipients exceed one transaction', async () => {
    const build = await buildClaimAndSplitTransactions({
      connection: makeConnection({ accountExists: false }),
      tracked: makeTracked(),
      recipients: recipients(10, 900),
    });
    // 10 recipients x (ATA create + transfer) x 2 assets = 40 payout
    // instructions plus the claim: cannot fit in one transaction.
    expect(build.transactions.length).toBeGreaterThan(1);
    const ixCounts = build.transactions.map((t) => t.instructions.length);
    expect(ixCounts[0]).toBeGreaterThan(0);
  });

  it('removes the SDK wSOL unwrap when recipients are owed the SOL leg', async () => {
    const nativeSol = NATIVE_MINT.toBase58();
    const tracked = makeTracked();
    tracked.quoteMint = nativeSol;
    const build = await buildClaimAndSplitTransactions({
      connection: makeConnection({ accountExists: false }),
      tracked,
      recipients: recipients(2, 1000),
    });
    const ixs = build.transactions.flatMap((t) => t.instructions);
    const creatorWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      new PublicKey(tracked.creator),
    ).toBase58();
    const unwraps = ixs.filter(
      (ix) =>
        ix.programId.equals(TOKEN_PROGRAM_ID) &&
        ix.data[0] === 9 &&
        ix.keys[0]?.pubkey.toBase58() === creatorWsolAta,
    );
    // The unwrap must go: payouts are wSOL SPL transfers from that ATA.
    expect(unwraps).toHaveLength(0);
    // The wSOL legs are paid as SPL transfers, so they work for dust too.
    const tokenProg = TOKEN_PROGRAM_ID.toBase58();
    const transfers = ixs.filter(
      (ix) => ix.programId.toBase58() === tokenProg && ix.data[0] === 3,
    );
    expect(transfers.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the claim untouched when no SOL payout is owed', async () => {
    const nativeSol = NATIVE_MINT.toBase58();
    const tracked = makeTracked();
    tracked.quoteMint = nativeSol;
    // Zero-bps recipients: distribution is empty, so the SDK unwrap stays
    // and a plain claim still pays the creator native SOL.
    const build = await buildClaimAndSplitTransactions({
      connection: makeConnection({ accountExists: false }),
      tracked,
      recipients: [],
    });
    const ixs = build.transactions.flatMap((t) => t.instructions);
    const creatorWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      new PublicKey(tracked.creator),
    ).toBase58();
    const unwraps = ixs.filter(
      (ix) =>
        ix.programId.equals(TOKEN_PROGRAM_ID) &&
        ix.data[0] === 9 &&
        ix.keys[0]?.pubkey.toBase58() === creatorWsolAta,
    );
    expect(unwraps).toHaveLength(1);
  });

  it('creates missing recipient token accounts before paying them', async () => {
    const tracked = makeTracked();
    const rs = recipients(1, 1000);
    const build = await buildClaimAndSplitTransactions({
      connection: makeConnection({ accountExists: false }),
      tracked,
      recipients: rs,
    });
    const programIds = build.transactions
      .flatMap((t) => t.instructions)
      .map((ix) => ix.programId.toBase58());
    // Associated token program id appears when ATA creation is needed.
    expect(programIds).toContain('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    // The single recipient still gets exactly 10% of each asset.
    expect(build.distribution[0].baseRaw).toBe('100000000');
    expect(build.distribution[0].quoteRaw).toBe('200000000');
  });

  it('skips ATA creation when the recipient account already exists', async () => {
    const build = await buildClaimAndSplitTransactions({
      connection: makeConnection({ accountExists: true }),
      tracked: makeTracked(),
      recipients: recipients(1, 1000),
    });
    const programIds = build.transactions
      .flatMap((t) => t.instructions)
      .map((ix) => ix.programId.toBase58());
    expect(programIds).not.toContain('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  });

  it('builds only the claim transaction when nothing is accrued', async () => {
    const { fetchPoolLiveState } = await import('./pool-state');
    vi.mocked(fetchPoolLiveState).mockResolvedValueOnce({
      creatorBaseFeeRaw: '0',
      creatorQuoteFeeRaw: '0',
    } as any);
    const build = await buildClaimAndSplitTransactions({
      connection: makeConnection({ accountExists: false }),
      tracked: makeTracked(),
      recipients: recipients(5, 1000),
    });
    expect(build.distribution).toHaveLength(0);
    expect(build.transactions).toHaveLength(1);
  });

  it('caps the claim so unbound shares stay in the pool', async () => {
    const { buildClaimCreatorFeesTx } = await import('./claim-creator-fees');
    const boundWallet = wallet();
    const recips: FeeSplitRecipient[] = [
      { wallet: boundWallet, bps: 2000 }, // bound, 20%
      { handle: 'alice', bps: 1000 }, // unbound X handle, 10%
    ];
    await buildClaimAndSplitTransactions({
      connection: makeConnection({ accountExists: true }),
      tracked: makeTracked(),
      recipients: recips,
      bindings: [
        {
          poolAddress: 'pool',
          entryIndex: 0,
          wallet: boundWallet,
          boundAt: 1,
        },
      ],
    });
    const calls = vi.mocked(buildClaimCreatorFeesTx).mock.calls;
    const last = calls[calls.length - 1][0] as {
      maxBaseAmount: bigint;
      maxQuoteAmount: bigint;
    };
    // Accrued 1.0 base / 2.0 quote. Bound 20% = 0.2/0.4, creator
    // remainder 70% = 0.7/1.4. Caps = 0.9 base + 1.8 quote; the unbound
    // 10% (0.1/0.2) stays accrued in the pool.
    expect(last.maxBaseAmount).toBe(BigInt(900_000_000));
    expect(last.maxQuoteAmount).toBe(BigInt(1_800_000_000));
  });

  it('claims everything when there are no recipients', async () => {
    const { buildClaimCreatorFeesTx } = await import('./claim-creator-fees');
    await buildClaimAndSplitTransactions({
      connection: makeConnection({ accountExists: true }),
      tracked: makeTracked(),
      recipients: [],
    });
    const calls = vi.mocked(buildClaimCreatorFeesTx).mock.calls;
    const last = calls[calls.length - 1][0] as {
      maxBaseAmount: bigint;
      maxQuoteAmount: bigint;
    };
    // No recipients: creator keeps 100%, caps equal full accrued.
    expect(last.maxBaseAmount).toBe(BigInt(1_000_000_000));
    expect(last.maxQuoteAmount).toBe(BigInt(2_000_000_000));
  });

  it('forwards the buyback slice to the vault when buybackBps is set', async () => {
    const vault = wallet();
    process.env.NEXT_PUBLIC_BUYBACK_VAULT_WALLET = vault;
    try {
      const tracked = { ...makeTracked(), buybackBps: 2500 }; // 25% of remainder
      const build = await buildClaimAndSplitTransactions({
        connection: makeConnection({ accountExists: true }),
        tracked,
        recipients: [],
      });
      // No recipients: creator remainder is the full 1.0/2.0, buyback
      // takes 25% of it: 0.25 base / 0.5 quote.
      expect(build.buyback).not.toBeNull();
      expect(build.buyback!.bps).toBe(2500);
      expect(build.buyback!.baseRaw).toBe('250000000');
      expect(build.buyback!.quoteRaw).toBe('500000000');
      expect(build.buyback!.vault).toBe(vault);
      // The claim caps are unchanged: the buyback slice is part of the
      // creator remainder, claimed then forwarded.
      const { buildClaimCreatorFeesTx } = await import('./claim-creator-fees');
      const calls = vi.mocked(buildClaimCreatorFeesTx).mock.calls;
      const last = calls[calls.length - 1][0] as {
        maxBaseAmount: bigint;
        maxQuoteAmount: bigint;
      };
      expect(last.maxBaseAmount).toBe(BigInt(1_000_000_000));
      expect(last.maxQuoteAmount).toBe(BigInt(2_000_000_000));
    } finally {
      delete process.env.NEXT_PUBLIC_BUYBACK_VAULT_WALLET;
    }
  });

  it('reports no buyback when buybackBps is unset', async () => {
    const build = await buildClaimAndSplitTransactions({
      connection: makeConnection({ accountExists: true }),
      tracked: makeTracked(),
      recipients: [],
    });
    expect(build.buyback).toBeNull();
  });
});
