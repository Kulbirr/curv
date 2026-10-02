import { BN } from '@coral-xyz/anchor';
import { getCurrentPoint } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey, type Transaction } from '@solana/web3.js';
import { getConnection, getDbcClient } from '@/lib/solana';
import { fetchOnChainPool } from '@/components/Pool/useOnChainPool';

/** Slippage protection on the dev buy, 100 bps = 1%, the same default the trade panel uses. */
export const DEV_BUY_SLIPPAGE_BPS = 100;

/**
 * Build the dev buy transaction: a quote -> base swap through the freshly
 * created DBC pool, signed and sent by the creator's wallet exactly like a
 * normal trade. The server never sees this transaction; it only stores the
 * disclosed amount the creator signed at registration.
 *
 * Reuses the DBC SDK swap path the trade panel uses (swapQuote for a fresh
 * minimumAmountOut, then pool.swap), so there is exactly one swap
 * implementation to audit.
 */
export async function buildDevBuyTransaction(args: {
  poolAddress: string;
  owner: PublicKey;
  amountRaw: BN;
  slippageBps?: number;
}): Promise<Transaction> {
  const client = getDbcClient();
  const connection = getConnection();
  const oc = await fetchOnChainPool(args.poolAddress);
  const config = oc.config as { activationType?: number };
  const currentPoint = await getCurrentPoint(connection, (config.activationType ?? 1) as 0 | 1);

  // Re-quote immediately before building so minimumAmountOut is fresh.
  const q = client.pool.swapQuote({
    virtualPool: oc.virtualPool as never,
    config: oc.config as never,
    swapBaseForQuote: false,
    amountIn: args.amountRaw,
    slippageBps: args.slippageBps ?? DEV_BUY_SLIPPAGE_BPS,
    hasReferral: false,
    // The pool has no swaps yet at dev buy time, and launches disable the
    // first-swap min-fee flag, so this is always false here.
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  }) as unknown as { outputAmount: BN; minimumAmountOut: BN };

  const tx = await client.pool.swap({
    owner: args.owner,
    payer: args.owner,
    pool: new PublicKey(args.poolAddress),
    amountIn: args.amountRaw,
    minimumAmountOut: q.minimumAmountOut,
    swapBaseForQuote: false,
    referralTokenAccount: null,
  });
  tx.feePayer = args.owner;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  return tx;
}
