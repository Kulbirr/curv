import { BN } from '@coral-xyz/anchor';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { getDbcClient } from './solana';
import { rawToUi } from './swap-math';

/**
 * Creator earnings: read accrued on-chain fees and claim them.
 *
 * The 0.3% creator trading fee accrues per pool on-chain as
 * creatorBaseFee / creatorQuoteFee (raw u64 in the pool account). The
 * indexer samples these into the DB; this module formats them and builds
 * the claim transaction the creator signs with their own wallet.
 *
 * Amounts stay in raw integer (BN/decimal-string) space until display
 * formatting, never floats.
 */

const U64_MAX = new BN('18446744073709551615');

/**
 * Build the claim transaction for creator fees on a pool.
 *
 * maxBaseAmount/maxQuoteAmount are caps, not exact amounts: the
 * instruction pulls min(accrued, cap) per leg. Omitting them claims
 * everything accrued. Passing exact caps performs a PARTIAL claim:
 * Curv sets the caps to the bound recipients' shares plus the
 * creator's remainder, so unbound X-handle shares stay accrued in the
 * pool (the pool is the vault) until their owners bind. Using u64 max
 * avoids a stale-indexer under-claim when fees accrued since sampling.
 */
export async function buildClaimCreatorFeesTx(args: {
  poolAddress: string;
  creator: string;
  maxBaseAmount?: bigint;
  maxQuoteAmount?: bigint;
}): Promise<Transaction> {
  const client = getDbcClient();
  const creator = new PublicKey(args.creator);
  return client.creator.claimCreatorTradingFee({
    creator,
    payer: creator,
    pool: new PublicKey(args.poolAddress),
    maxBaseAmount: args.maxBaseAmount ?? U64_MAX,
    maxQuoteAmount: args.maxQuoteAmount ?? U64_MAX,
  });
}

/**
 * Build the transaction withdrawing the creator's 2% migration fee for a
 * graduated pool. Signed by the creator's own wallet in the browser, never
 * by the Curv fee wallet.
 */
export async function buildWithdrawCreatorMigrationFeeTx(args: {
  poolAddress: string;
  sender: string;
}): Promise<Transaction> {
  const client = getDbcClient();
  return client.creator.creatorWithdrawMigrationFee({
    pool: new PublicKey(args.poolAddress),
    sender: new PublicKey(args.sender),
  });
}

/**
 * Bit in the pool's migrationFeeWithdrawStatus set once the creator has
 * withdrawn their migration fee (bit 1, 0b010; bit 2 is the partner).
 */
export const CREATOR_MIGRATION_FEE_WITHDRAWN_BIT = 0b010;

/**
 * True when the creator already withdrew the 2% migration fee for this
 * pool. Reads the live pool account; throws when the pool is not found.
 */
export async function getCreatorMigrationFeeWithdrawn(
  poolAddress: string,
): Promise<boolean> {
  const client = getDbcClient();
  const pool = await client.state.getPool(new PublicKey(poolAddress));
  if (!pool) throw new Error('Pool not found on-chain');
  // The IDL wraps the struct: { poolState: { ... } }. Handle both shapes,
  // same as pool-state.ts.
  const ps = ((pool as unknown as { poolState?: unknown }).poolState ?? pool) as Record<
    string,
    unknown
  >;
  const status = Number(ps['migrationFeeWithdrawStatus'] ?? 0);
  return (status & CREATOR_MIGRATION_FEE_WITHDRAWN_BIT) !== 0;
}

async function pollSignatureStatus(connection: Connection, signature: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    const { value } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: false,
    });
    const status = value;
    if (status?.err) throw new Error('Transaction failed on-chain');
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
    if (Date.now() - start > 60_000) throw new Error('Timed out waiting for confirmation');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Full claim flow: build, sign in the connected wallet, send, confirm.
 * Mirrors the swap execution pattern in TradePanel.
 */
export async function claimCreatorFeesFlow(args: {
  connection: Connection;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  poolAddress: string;
  creator: string;
  onStatus: (s: 'signing' | 'sending' | 'confirming') => void;
}): Promise<string> {
  const tx = await buildClaimCreatorFeesTx({
    poolAddress: args.poolAddress,
    creator: args.creator,
  });
  tx.feePayer = new PublicKey(args.creator);
  const { blockhash } = await args.connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  args.onStatus('signing');
  const signed = await args.signTransaction(tx);
  args.onStatus('sending');
  const sig = await args.connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
  });
  args.onStatus('confirming');
  await pollSignatureStatus(args.connection, sig);
  return sig;
}

/**
 * Full migration-fee claim flow: build, sign in the connected wallet,
 * send, confirm. Mirrors claimCreatorFeesFlow above; the only difference
 * is the instruction (creatorWithdrawMigrationFee) and that it is only
 * valid after the pool graduated.
 */
export async function withdrawCreatorMigrationFeeFlow(args: {
  connection: Connection;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  poolAddress: string;
  creator: string;
  onStatus: (s: 'signing' | 'sending' | 'confirming') => void;
}): Promise<string> {
  const tx = await buildWithdrawCreatorMigrationFeeTx({
    poolAddress: args.poolAddress,
    sender: args.creator,
  });
  tx.feePayer = new PublicKey(args.creator);
  const { blockhash } = await args.connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  args.onStatus('signing');
  const signed = await args.signTransaction(tx);
  args.onStatus('sending');
  const sig = await args.connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
  });
  args.onStatus('confirming');
  await pollSignatureStatus(args.connection, sig);
  return sig;
}

/**
 * Visibility rule for the Creator earnings panel. Pure and tested:
 * only the pool's creator, with a connected wallet, sees it. Everyone
 * else gets null, not an error state.
 */
export function shouldShowCreatorEarnings(args: {
  connected: boolean;
  walletAddress: string | null;
  creator: string;
}): boolean {
  return args.connected && args.walletAddress !== null && args.walletAddress === args.creator;
}

/** Format a raw fee amount to UI units; null when nothing was sampled. */
export function formatFeeRaw(raw: string | null | undefined, decimals: number): string | null {
  if (raw === null || raw === undefined) return null;
  let bn: BN;
  try {
    bn = new BN(raw);
  } catch {
    return null;
  }
  if (bn.isNeg()) return null;
  return rawToUi(bn, decimals);
}

/** True when both fee balances are present and zero. */
export function hasNoAccruedFees(
  baseRaw: string | null | undefined,
  quoteRaw: string | null | undefined,
): boolean {
  const zero = (r: string | null | undefined) => r !== null && r !== undefined && /^(0+)$/.test(r);
  return zero(baseRaw) && zero(quoteRaw);
}

export interface EarningsEntry {
  poolAddress: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  creatorBaseFeeRaw: string | null;
  creatorQuoteFeeRaw: string | null;
  /** Real indexed USD price per base token; null when unknown. */
  priceUsd: number | null;
}

export interface AggregatedEarning {
  mint: string;
  symbol: string;
  decimals: number;
  /** Summed raw integer units (decimal string). */
  rawTotal: string;
  /**
   * Summed fiat over entries that had a real indexed price. Null when no
   * entry had a price. `fiatComplete` is false when some entries lacked
   * prices, so the UI can say so instead of implying a full total.
   */
  usdTotal: number | null;
  fiatComplete: boolean;
}

/**
 * Sum accrued creator fees across pools, grouped by token mint.
 * Pure BN addition on raw strings, no float math.
 */
export function aggregateCreatorEarnings(entries: EarningsEntry[]): AggregatedEarning[] {
  const byMint = new Map<string, AggregatedEarning & { _missingFiat: boolean }>();
  const add = (
    mint: string,
    symbol: string,
    decimals: number,
    raw: string | null,
    usdPerToken: number | null,
  ) => {
    if (raw === null) return;
    let bn: BN;
    try {
      bn = new BN(raw);
    } catch {
      return;
    }
    if (bn.isZero()) return;
    let agg = byMint.get(mint);
    if (!agg) {
      agg = { mint, symbol, decimals, rawTotal: '0', usdTotal: null, fiatComplete: true, _missingFiat: false };
      byMint.set(mint, agg);
    }
    agg.rawTotal = new BN(agg.rawTotal).add(bn).toString(10);
    if (usdPerToken !== null && Number.isFinite(usdPerToken)) {
      // Display-only fiat math; raw totals above stay exact.
      const ui = Number(rawToUi(bn, decimals));
      agg.usdTotal = (agg.usdTotal ?? 0) + ui * usdPerToken;
    } else {
      agg._missingFiat = true;
    }
  };
  for (const e of entries) {
    add(e.baseMint, e.baseSymbol, e.baseDecimals, e.creatorBaseFeeRaw, e.priceUsd);
    // Quote-token fiat: we only have a real indexed USD price for the base
    // token, so quote fees aggregate as token amounts with no fiat claim.
    add(e.quoteMint, e.quoteSymbol, e.quoteDecimals, e.creatorQuoteFeeRaw, null);
  }
  return [...byMint.values()].map(({ _missingFiat, ...rest }) => ({
    ...rest,
    fiatComplete: !_missingFiat,
  }));
}
