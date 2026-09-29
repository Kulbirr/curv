import { BN } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getDbcClient } from './solana';

/**
 * Platform (partner) earnings: claim Curv's share of on-chain fees.
 *
 * Mirrors claim-creator-fees.ts but for the feeClaimer side: the ~0.652%
 * platform trading fee accrues per pool as partnerBaseFee / partnerQuoteFee,
 * the 6% migration fee is withdrawable after graduation, and the 0.02 SOL
 * pool creation fee (90% to Curv) is claimable per pool.
 *
 * All of these are signed by the Curv fee wallet, never by a user wallet,
 * so they run server-side (API route or script), never in the browser.
 */

const U64_MAX = new BN('18446744073709551615');

/** Build the claim transaction for ALL accrued partner trading fees on a pool. */
export async function buildClaimPartnerFeesTx(args: {
  poolAddress: string;
  feeClaimer: string;
}): Promise<Transaction> {
  const client = getDbcClient();
  const claimer = new PublicKey(args.feeClaimer);
  return client.partner.claimPartnerTradingFee({
    feeClaimer: claimer,
    payer: claimer,
    pool: new PublicKey(args.poolAddress),
    // Caps, not exact amounts: claiming everything accrued. Using u64 max
    // avoids under-claiming fees that accrued after the last read.
    maxBaseAmount: U64_MAX,
    maxQuoteAmount: U64_MAX,
  });
}

/** Build the transaction withdrawing Curv's 6% migration fee for a pool. */
export async function buildWithdrawPartnerMigrationFeeTx(args: {
  poolAddress: string;
  /** The feeClaimer (or any payer); the withdrawn fee goes to the partner. */
  sender: string;
}): Promise<Transaction> {
  const client = getDbcClient();
  return client.partner.partnerWithdrawMigrationFee({
    pool: new PublicKey(args.poolAddress),
    sender: new PublicKey(args.sender),
  });
}

/**
 * The creator's 2% migration-fee withdrawal is creator-signed in the
 * browser, so its builder lives in claim-creator-fees.ts. Re-exported here
 * for backward compatibility.
 */
export { buildWithdrawCreatorMigrationFeeTx } from './claim-creator-fees';

/** Build the transaction claiming Curv's 90% of the 0.02 SOL pool creation fee. */
export async function buildClaimPartnerPoolCreationFeeTx(args: {
  poolAddress: string;
  feeReceiver: string;
}): Promise<Transaction> {
  const client = getDbcClient();
  return client.partner.claimPartnerPoolCreationFee({
    pool: new PublicKey(args.poolAddress),
    feeReceiver: new PublicKey(args.feeReceiver),
  });
}

export interface PartnerClaimable {
  /** Unclaimed partner trading fee in base tokens, raw integer string. */
  baseRaw: string | null;
  /** Unclaimed partner trading fee in quote tokens, raw integer string. */
  quoteRaw: string | null;
}

function toRawString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  try {
    const s =
      typeof v === 'object'
        ? (v as { toString(radix?: number): string }).toString(10)
        : String(v);
    return /^\d+$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** Read Curv's currently unclaimed trading fees for a pool (raw units). */
export async function getPartnerClaimable(poolAddress: string): Promise<PartnerClaimable> {
  const client = getDbcClient();
  const metrics = await client.state.getPoolFeeMetrics(new PublicKey(poolAddress));
  return {
    baseRaw: toRawString(metrics.current.partnerBaseFee),
    quoteRaw: toRawString(metrics.current.partnerQuoteFee),
  };
}

/**
 * Load the fee wallet keypair from the server environment. The secret must
 * be base58-encoded in CURV_FEE_WALLET_SECRET. Throws when absent so a
 * misconfigured deploy fails loudly instead of signing with nothing.
 */
export function loadFeeWalletKeypair(): Keypair {
  const secret = process.env.CURV_FEE_WALLET_SECRET;
  if (!secret) {
    throw new Error(
      'CURV_FEE_WALLET_SECRET is not set; add the fee wallet secret (base58) to the server environment',
    );
  }
  return Keypair.fromSecretKey(bs58.decode(secret.trim()));
}

/**
 * Poll getSignatureStatus until the signature is confirmed/finalized.
 * Throws when the transaction failed on-chain or after 60s without
 * confirmation.
 */
export async function confirmSignature(connection: Connection, signature: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    const { value } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: false,
    });
    if (value?.err) throw new Error('Transaction failed on-chain');
    if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') return;
    if (Date.now() - start > 60_000) throw new Error('Timed out waiting for confirmation');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Sign with the fee wallet, send, and await on-chain confirmation.
 * Returns the signature. When confirmation fails after the transaction was
 * submitted, the thrown error carries the signature so the caller can
 * still report it for later inspection.
 */
export async function sendSigned(
  connection: Connection,
  tx: Transaction,
  signer: Keypair,
  onStatus?: (s: 'sending' | 'confirming') => void,
): Promise<string> {
  tx.feePayer = signer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(signer);
  onStatus?.('sending');
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  onStatus?.('confirming');
  try {
    await confirmSignature(connection, sig);
  } catch (e) {
    (e as Error & { signature?: string }).signature = sig;
    throw e;
  }
  return sig;
}

/**
 * Full platform claim flow, server-side: build, sign with the fee wallet,
 * send, confirm. Returns the transaction signature.
 */
export async function claimPartnerFeesFlow(args: {
  connection: Connection;
  feeWallet: Keypair;
  poolAddress: string;
  onStatus?: (s: 'sending' | 'confirming') => void;
}): Promise<string> {
  const tx = await buildClaimPartnerFeesTx({
    poolAddress: args.poolAddress,
    feeClaimer: args.feeWallet.publicKey.toBase58(),
  });
  return sendSigned(args.connection, tx, args.feeWallet, args.onStatus);
}

/** Withdraw Curv's 6% migration fee for a graduated pool, server-side. */
export async function withdrawPartnerMigrationFeeFlow(args: {
  connection: Connection;
  feeWallet: Keypair;
  poolAddress: string;
  onStatus?: (s: 'sending' | 'confirming') => void;
}): Promise<string> {
  const tx = await buildWithdrawPartnerMigrationFeeTx({
    poolAddress: args.poolAddress,
    sender: args.feeWallet.publicKey.toBase58(),
  });
  return sendSigned(args.connection, tx, args.feeWallet, args.onStatus);
}
