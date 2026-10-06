import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { getTrackedPool } from '@/lib/pool-registry';
import { getPoolState } from '@/lib/db/states';
import { recordTrade } from '@/lib/db/trades';
import { hitRateLimit } from '@/lib/db/rate-limits';
import { parseAddress } from '@/lib/api-validation';
import { getConnection } from '@/lib/solana';
import { NATIVE_SOL_MINT } from '@/components/Pool/types';

/**
 * POST /api/pools/[address]/trades/record
 *
 * Records a post graduation Jupiter swap in the trades table so the dev
 * radar, wallet history, and holder stats keep working after the bonding
 * curve closes. The trade indexer only watches the DBC pool, so without
 * this endpoint post graduation swaps would be invisible.
 *
 * The server fetches the transaction on chain and derives side and
 * amounts from balance deltas. Nothing about the trade is trusted from
 * the client except the signature and the wallet that claims it.
 * Unverified signatures are rejected.
 */

export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

const IP_LIMIT = 30;
const IP_WINDOW_MS = 60 * 60 * 1000;

function clientIp(req: NextApiRequest): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.split(',')[0].trim();
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

/** Net token balance change for `wallet` on `mint`, in raw units. */
function tokenDelta(
  pre: TokenBalanceEntry[] | undefined,
  post: TokenBalanceEntry[] | undefined,
  mint: string,
  wallet: string,
): bigint {
  const preByAccount = new Map<number, bigint>();
  const postByAccount = new Map<number, bigint>();
  const ownerOf = new Map<number, string>();
  for (const b of pre ?? []) {
    if (b.mint !== mint) continue;
    preByAccount.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
    if (b.owner) ownerOf.set(b.accountIndex, b.owner);
  }
  for (const b of post ?? []) {
    if (b.mint !== mint) continue;
    postByAccount.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
    if (b.owner) ownerOf.set(b.accountIndex, b.owner);
  }
  let delta = BigInt(0);
  const seen = new Set<number>();
  for (const [idx, postAmt] of postByAccount) {
    seen.add(idx);
    if (ownerOf.get(idx) !== wallet) continue;
    delta += postAmt - (preByAccount.get(idx) ?? BigInt(0));
  }
  for (const [idx, preAmt] of preByAccount) {
    if (seen.has(idx)) continue;
    if (ownerOf.get(idx) !== wallet) continue;
    delta -= preAmt; // account closed mid transaction
  }
  return delta;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });
  const tracked = await getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  const now = Date.now();
  const ip = clientIp(req);
  const hit = await hitRateLimit(`trade-record:${address}:${ip}`, IP_LIMIT, IP_WINDOW_MS, now);
  if (!hit.allowed) {
    return res.status(429).json({ error: 'Too many requests, try again later' });
  }

  const txSignature = typeof req.body?.txSignature === 'string' ? req.body.txSignature.trim() : '';
  const wallet = typeof req.body?.wallet === 'string' ? req.body.wallet.trim() : '';
  if (!txSignature || !wallet) {
    return res.status(400).json({ error: 'txSignature and wallet are required' });
  }
  let walletKey: PublicKey;
  try {
    walletKey = new PublicKey(wallet);
  } catch {
    return res.status(400).json({ error: 'wallet is not a valid Solana address' });
  }

  const connection = getConnection();
  let tx;
  try {
    tx = await connection.getParsedTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
  } catch {
    return res.status(502).json({ error: 'Could not read the transaction, try again later' });
  }
  if (!tx || tx.meta?.err) {
    return res.status(400).json({ error: 'Transaction not found or it failed on chain' });
  }

  // The claimant must be the fee payer: only the trader can record it.
  const accountKeys = tx.transaction.message.accountKeys;
  const feePayer = accountKeys[0]?.pubkey?.toBase58?.() ?? null;
  if (feePayer !== walletKey.toBase58()) {
    return res.status(400).json({ error: 'Wallet did not sign this transaction' });
  }

  const baseDelta = tokenDelta(
    tx.meta.preTokenBalances as TokenBalanceEntry[] | undefined,
    tx.meta.postTokenBalances as TokenBalanceEntry[] | undefined,
    tracked.baseMint,
    wallet,
  );
  if (baseDelta === BigInt(0)) {
    return res.status(400).json({ error: 'No movement of this token in the transaction' });
  }
  const side: 'buy' | 'sell' = baseDelta > BigInt(0) ? 'buy' : 'sell';

  let quoteDelta: bigint;
  if (tracked.quoteMint === NATIVE_SOL_MINT) {
    // Native SOL moves as lamports. With wrapAndUnwrapSol the wSOL temp
    // account nets to zero, so the fee payer lamport delta plus the tx
    // fee is the SOL side of the swap: negative when the user spent SOL
    // (buy), positive when they received SOL (sell). Note: if the swap
    // created a new token account for the user, its rent comes out of
    // the same delta and the buy side quote amount reads slightly high.
    // Acceptable for a history feed; the base side stays exact.
    const pre = BigInt(tx.meta.preBalances?.[0] ?? 0);
    const post = BigInt(tx.meta.postBalances?.[0] ?? 0);
    const fee = BigInt(tx.meta.fee ?? 0);
    quoteDelta = post - pre + fee;
    if (quoteDelta === BigInt(0)) {
      return res.status(400).json({ error: 'Could not read the SOL side of the swap' });
    }
  } else {
    quoteDelta = tokenDelta(
      tx.meta.preTokenBalances as TokenBalanceEntry[] | undefined,
      tx.meta.postTokenBalances as TokenBalanceEntry[] | undefined,
      tracked.quoteMint,
      wallet,
    );
    if (quoteDelta === BigInt(0)) {
      return res.status(400).json({ error: 'No movement of the quote token in the transaction' });
    }
  }

  // Sanity: the two sides must move in opposite directions.
  if ((baseDelta > BigInt(0)) === (quoteDelta > BigInt(0))) {
    return res.status(400).json({ error: 'Transaction does not look like a swap of this pair' });
  }

  const state = await getPoolState(tracked.poolAddress);
  const baseDecimals = state?.baseDecimals ?? 9;
  const quoteDecimals = state?.quoteDecimals ?? 9;
  const baseAbs = baseDelta < BigInt(0) ? -baseDelta : baseDelta;
  const quoteAbs = quoteDelta < BigInt(0) ? -quoteDelta : quoteDelta;
  const price =
    baseAbs > BigInt(0)
      ? (Number(quoteAbs) / 10 ** quoteDecimals / (Number(baseAbs) / 10 ** baseDecimals)).toString()
      : null;
  const tradedAt = tx.blockTime ? tx.blockTime * 1000 : now;

  const inserted = await recordTrade({
    poolAddress: tracked.poolAddress,
    wallet: walletKey.toBase58(),
    side,
    baseAmountRaw: baseAbs.toString(),
    quoteAmountRaw: quoteAbs.toString(),
    price,
    txSignature,
    slot: tx.slot ?? null,
    tradedAt,
    baseDecimals,
    quoteDecimals,
    source: 'jupiter',
  });

  return res.status(200).json({
    recorded: inserted,
    side,
    baseAmountRaw: baseAbs.toString(),
    quoteAmountRaw: quoteAbs.toString(),
  });
}
