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
import { BPS_TOTAL } from './fee-split-terms';
import type { EffectiveFeeSplitRecipient, FeeSplitBinding, FeeSplitRecipient } from './fee-split-terms';
import { resolveEffectiveRecipients } from './fee-split-terms';
import { platformFeeWallet } from './launch';

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
 *
 * Buyback and burn: when the pool was launched with buyback_bps, the
 * creator's committed share of their remainder is forwarded to the
 * buyback vault in the same atomic flow. Recipients are unaffected:
 * their bps still apply to the gross accrued fee.
 */

export interface SplitPayout {
  wallet: string;
  handle?: string;
  bps: number;
  baseRaw: string;
  quoteRaw: string;
}

/**
 * Recipients with a wallet to pay: bound wallet when set, otherwise
 * the registered one. Handle-only entries with no bound wallet have
 * nothing to pay to, so they are skipped and their share stays accrued
 * in the pool (it is excluded from the creator remainder in the claim
 * builder, so the creator cannot take it either).
 */
export function payableRecipients(
  recipients: FeeSplitRecipient[],
  bindings: FeeSplitBinding[] = [],
): FeeSplitRecipient[] {
  return resolveEffectiveRecipients(recipients, bindings)
    .filter(
      (r): r is EffectiveFeeSplitRecipient & { effectiveWallet: string } => !!r.effectiveWallet,
    )
    .map((r) => ({ ...r, wallet: r.effectiveWallet }));
}

/** Pure payout plan: every recipient's share of the accrued fees. */
export function planDistribution(
  accruedBaseRaw: string | null | undefined,
  accruedQuoteRaw: string | null | undefined,
  recipients: FeeSplitRecipient[],
): SplitPayout[] {
  const out: SplitPayout[] = [];
  for (const r of recipients) {
    // Entries with no wallet anywhere are skipped: their share stays
    // accrued in the pool (excluded from the creator remainder), never
    // paid to anyone until the entry is bound.
    if (!r.wallet) continue;
    const baseRaw = splitShareRaw(accruedBaseRaw, r.bps);
    const quoteRaw = splitShareRaw(accruedQuoteRaw, r.bps);
    if (baseRaw === '0' && quoteRaw === '0') continue;
    out.push({ wallet: r.wallet, handle: r.handle, bps: r.bps, baseRaw, quoteRaw });
  }
  return out;
}

export interface BuybackPlan {
  /** Basis points of the creator remainder committed to buyback, 0 when off. */
  bps: number;
  baseRaw: string;
  quoteRaw: string;
  /** Vault wallet the buyback slice is forwarded to. */
  vault: string;
}

/**
 * Pure buyback plan: the buyback slice of a claim.
 *
 * Semantics, kept consistent with fee-split-terms: recipients take
 * their bps of the GROSS accrued fee, untouched. The buyback_bps the
 * creator committed at launch applies to the creator's REMAINDER
 * (gross minus recipient shares), never to the gross, so recipient
 * math is unaffected and the parts can never exceed the whole.
 * The creator nets the remainder minus the buyback slice.
 */
export function planBuyback(
  accruedBaseRaw: string | null | undefined,
  accruedQuoteRaw: string | null | undefined,
  creatorBps: number,
  buybackBps: number,
  vault: string,
): BuybackPlan | null {
  const bps = Math.max(0, Math.min(10_000, Math.floor(buybackBps)));
  if (bps <= 0 || creatorBps <= 0) return null;
  const remainderBase = splitShareRaw(accruedBaseRaw, creatorBps);
  const remainderQuote = splitShareRaw(accruedQuoteRaw, creatorBps);
  const baseRaw = splitShareRaw(remainderBase, bps);
  const quoteRaw = splitShareRaw(remainderQuote, bps);
  if (baseRaw === '0' && quoteRaw === '0') return null;
  return { bps, baseRaw, quoteRaw, vault };
}

/**
 * The wallet that collects buyback slices. The vault address is public
 * (it only receives funds), so it may come from a NEXT_PUBLIC_ var for
 * the client claim flow; the server keeper uses the same address.
 * Falls back to the platform fee wallet when no dedicated vault is set.
 */
export function resolveBuybackVault(): PublicKey | null {
  const raw =
    process.env.NEXT_PUBLIC_BUYBACK_VAULT_WALLET?.trim() ||
    process.env.BUYBACK_VAULT_WALLET?.trim() ||
    '';
  if (raw) {
    try {
      return new PublicKey(raw);
    } catch {
      // Fall through to the fee wallet below.
    }
  }
  return platformFeeWallet();
}

const TX_SIZE_BUDGET = 1200; // legacy transactions cap at 1232 bytes

function txSize(tx: Transaction): number {
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
}

export interface ClaimAndSplitBuild {
  transactions: Transaction[];
  distribution: SplitPayout[];
  /** The buyback slice forwarded to the vault, null when the pool has none. */
  buyback: BuybackPlan | null;
  accruedBaseRaw: string | null;
  accruedQuoteRaw: string | null;
}

export async function buildClaimAndSplitTransactions(args: {
  connection: Connection;
  tracked: TrackedPool;
  recipients: FeeSplitRecipient[];
  bindings?: FeeSplitBinding[];
}): Promise<ClaimAndSplitBuild> {
  const { connection, tracked, recipients } = args;
  const creator = new PublicKey(tracked.creator);

  const live = await fetchPoolLiveState(tracked);
  const payable = payableRecipients(recipients, args.bindings);
  const distribution = planDistribution(live.creatorBaseFeeRaw, live.creatorQuoteFeeRaw, payable);

  // Partial claim: pull only what is distributed now (bound recipients'
  // shares plus the creator's remainder of total accrued). Unbound
  // X-handle shares stay accrued in the pool until their owners bind;
  // the pool is the vault, nobody holds their money meanwhile.
  const totalRecipientBps = recipients.reduce((s, r) => s + r.bps, 0);
  const creatorBps = BPS_TOTAL - totalRecipientBps;
  const sumRaw = (key: 'baseRaw' | 'quoteRaw') =>
    distribution.reduce((s, p) => s + BigInt(p[key]), BigInt(0));
  const accruedBase = live.creatorBaseFeeRaw;
  const accruedQuote = live.creatorQuoteFeeRaw;
  const capBase =
    sumRaw('baseRaw') + BigInt(splitShareRaw(accruedBase, creatorBps));
  const capQuote =
    sumRaw('quoteRaw') + BigInt(splitShareRaw(accruedQuote, creatorBps));

  // Buyback and burn diversion: when the creator committed buyback_bps
  // at launch, that share of the creator remainder is forwarded to the
  // buyback vault in the same atomic flow. The claim caps above are
  // unchanged: the buyback slice is part of what the creator receives,
  // then forwarded. Recipient math is untouched.
  const buybackBps = Math.max(0, Math.min(10_000, Math.floor(tracked.buybackBps ?? 0)));
  let buyback: BuybackPlan | null = null;
  if (buybackBps > 0 && creatorBps > 0) {
    const vault = resolveBuybackVault();
    if (!vault) {
      throw new Error('Buyback is enabled for this pool but no buyback vault is configured');
    }
    buyback = planBuyback(accruedBase, accruedQuote, creatorBps, buybackBps, vault.toBase58());
  }

  const claimTx = await buildClaimCreatorFeesTx({
    poolAddress: tracked.poolAddress,
    creator: tracked.creator,
    // No recipients at all: creatorBps is 10000 and the caps equal the
    // full accrued amounts, identical to the old claim-everything path.
    maxBaseAmount: capBase,
    maxQuoteAmount: capQuote,
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
    quoteMintPk.equals(NATIVE_MINT) &&
    (distribution.some((p) => BigInt(p.quoteRaw) > BigInt(0)) ||
      (buyback !== null && BigInt(buyback.quoteRaw) > BigInt(0)));
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

  // Buyback diversion, packed like any other payout: the creator's
  // committed slice goes to the vault wallet in the same atomic flow.
  // The keeper later swaps it for the base token and burns.
  if (buyback) {
    const vault = new PublicKey(buyback.vault);
    const legs: Array<{ mint: PublicKey; raw: string }> = [
      { mint: baseMint, raw: buyback.baseRaw },
      { mint: quoteMint, raw: buyback.quoteRaw },
    ];
    for (const leg of legs) {
      const amount = BigInt(leg.raw);
      if (amount <= BigInt(0)) continue;
      const source = getAssociatedTokenAddressSync(leg.mint, creator);
      const dest = getAssociatedTokenAddressSync(leg.mint, vault);
      const destInfo = await connection.getAccountInfo(dest);
      if (!destInfo) {
        pushIx(createAssociatedTokenAccountInstruction(creator, dest, vault, leg.mint));
      }
      pushIx(createTransferInstruction(source, dest, creator, amount));
    }
  }

  return {
    transactions,
    distribution,
    buyback,
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
  bindings?: FeeSplitBinding[];
}): Promise<{ signatures: string[]; distribution: SplitPayout[]; buyback: BuybackPlan | null }> {
  const build = await buildClaimAndSplitTransactions({
    connection: args.connection,
    tracked: args.tracked,
    recipients: args.recipients,
    bindings: args.bindings,
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

  return { signatures, distribution: build.distribution, buyback: build.buyback };
}
