import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { NATIVE_MINT } from '@solana/spl-token';
import { buildClaimCreatorFeesTx } from './claim-creator-fees';
import { fetchPoolLiveState } from './pool-state';
import type { TrackedPool } from './pool-registry';
import { splitShareRaw } from './fee-split-terms';
import type { FeeSplitRecipient } from './fee-split-terms';

/**
 * The DBC SDK appends an unwrap (CloseAccount) of the creator's wSOL ATA
 * for SOL-quoted pools, paying the creator in native SOL. When split
 * recipients are owed wSOL, that close must go: the payout transfers below
 * read the creator's wSOL ATA, which would otherwise be a closed account.
 * Removing it is safe: the SDK creates the ATA idempotently, so repeat
 * claims keep working, and recipients receive wSOL (1:1 with SOL).
 */
function isWsolUnwrapOf(ix: TransactionInstruction, wsolAta: PublicKey): boolean {
  return (
    ix.programId.equals(TOKEN_PROGRAM_ID) &&
    ix.data.length > 0 &&
    ix.data[0] === 9 && // CloseAccount
    ix.keys.length > 0 &&
    ix.keys[0].pubkey.equals(wsolAta)
  );
}

/**
 * Claim and distribute: the atomic heart of fee splits.
 *
 * The creator trading fee accrues inside the Meteora pool and can
 * only be claimed by the creator wallet. When a pool has split terms,
 * Curv's claim flow builds one transaction that claims the fees and
 * pays every recipient their published share in the same atomic
 * unit: either the claim and all the payouts land together, or none
 * of them do. Curv never holds the money at any point.
 *
 * If a pool has many recipients and the combined instructions exceed
 * one transaction's size limit, the payouts continue in follow up
 * transactions signed in the same wallet session, immediately after
 * the claim. Shares are computed from a fresh on chain read of the
 * accrued fees, floored, so payouts can never exceed the claim.
 */

export interface SplitPayout {
  wallet: string;
  handle?: string;
  bps: number;
  baseRaw: string;
  quoteRaw: string;
}

/** Pure payout plan: every recipient's share of the accrued fees. */
export function planDistribution(
  accruedBaseRaw: string | null | undefined,
  accruedQuoteRaw: string | null | undefined,
  recipients: FeeSplitRecipient[],
): SplitPayout[] {
  const out: SplitPayout[] = [];
  for (const r of recipients) {
    const baseRaw = splitShareRaw(accruedBaseRaw, r.bps);
    const quoteRaw = splitShareRaw(accruedQuoteRaw, r.bps);
    if (baseRaw === '0' && quoteRaw === '0') continue;
    out.push({ wallet: r.wallet, handle: r.handle, bps: r.bps, baseRaw, quoteRaw });
  }
  return out;
}

const TX_SIZE_BUDGET = 1200; // legacy transactions cap at 1232 bytes

function txSize(tx: Transaction): number {
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
}

export interface ClaimAndSplitBuild {
  transactions: Transaction[];
  distribution: SplitPayout[];
  accruedBaseRaw: string | null;
  accruedQuoteRaw: string | null;
}

export async function buildClaimAndSplitTransactions(args: {
  connection: Connection;
  tracked: TrackedPool;
  recipients: FeeSplitRecipient[];
}): Promise<ClaimAndSplitBuild> {
  const { connection, tracked, recipients } = args;
  const creator = new PublicKey(tracked.creator);

  const live = await fetchPoolLiveState(tracked);
  const distribution = planDistribution(live.creatorBaseFeeRaw, live.creatorQuoteFeeRaw, recipients);

  const claimTx = await buildClaimCreatorFeesTx({
    poolAddress: tracked.poolAddress,
    creator: tracked.creator,
  });

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const newTx = () => new Transaction({ feePayer: creator, recentBlockhash: blockhash });

  const transactions: Transaction[] = [];
  let current = newTx();
  // When recipients are owed the native SOL leg, drop the SDK's wSOL
  // unwrap: payouts below are wSOL SPL transfers from the creator's wSOL
  // ATA, which the unwrap would close first. With no SOL payouts the
  // claim is untouched, so a plain claim still pays native SOL.
  const quoteMintPk = new PublicKey(tracked.quoteMint);
  const owesSolPayouts =
    quoteMintPk.equals(NATIVE_MINT) && distribution.some((p) => BigInt(p.quoteRaw) > BigInt(0));
  const claimInstructions = owesSolPayouts
    ? claimTx.instructions.filter(
        (ix) => !isWsolUnwrapOf(ix, getAssociatedTokenAddressSync(NATIVE_MINT, creator)),
      )
    : claimTx.instructions;
  current.add(...claimInstructions);
  transactions.push(current);

  // Distribution instructions, packed after the claim while they fit.
  const baseMint = new PublicKey(tracked.baseMint);
  const quoteMint = quoteMintPk;
  const pushIx = (ix: TransactionInstruction) => {
    current.add(ix);
    if (txSize(current) > TX_SIZE_BUDGET) {
      current.instructions.pop();
      current = newTx();
      current.add(ix);
      transactions.push(current);
    }
  };

  for (const payout of distribution) {
    const owner = new PublicKey(payout.wallet);
    const legs: Array<{ mint: PublicKey; raw: string }> = [
      { mint: baseMint, raw: payout.baseRaw },
      { mint: quoteMint, raw: payout.quoteRaw },
    ];
    for (const leg of legs) {
      const amount = BigInt(leg.raw);
      if (amount <= BigInt(0)) continue;
      const source = getAssociatedTokenAddressSync(leg.mint, creator);
      const dest = getAssociatedTokenAddressSync(leg.mint, owner);
      const destInfo = await connection.getAccountInfo(dest);
      if (!destInfo) {
        pushIx(createAssociatedTokenAccountInstruction(creator, dest, owner, leg.mint));
      }
      pushIx(createTransferInstruction(source, dest, creator, amount));
    }
  }

  return {
    transactions,
    distribution,
    accruedBaseRaw: live.creatorBaseFeeRaw,
    accruedQuoteRaw: live.creatorQuoteFeeRaw,
  };
}

/**
 * Full flow: build, sign (all transactions in one wallet prompt when
 * the wallet supports it), send in order, confirm each. Returns the
 * signatures, claim first.
 */
export async function claimAndSplitFlow(args: {
  connection: Connection;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
  tracked: TrackedPool;
  recipients: FeeSplitRecipient[];
}): Promise<{ signatures: string[]; distribution: SplitPayout[] }> {
  const build = await buildClaimAndSplitTransactions({
    connection: args.connection,
    tracked: args.tracked,
    recipients: args.recipients,
  });

  const signed =
    build.transactions.length > 1 && args.signAllTransactions
      ? await args.signAllTransactions(build.transactions)
      : await (async () => {
          const out: Transaction[] = [];
          for (const tx of build.transactions) out.push(await args.signTransaction(tx));
          return out;
        })();

  const signatures: string[] = [];
  for (const tx of signed) {
    const raw = tx.serialize();
    const signature = await args.connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 3,
    });
    const latest = await args.connection.getLatestBlockhash('confirmed');
    await args.connection.confirmTransaction(
      { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      'confirmed',
    );
    signatures.push(signature);
  }

  return { signatures, distribution: build.distribution };
}
