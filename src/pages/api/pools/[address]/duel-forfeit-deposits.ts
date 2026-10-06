import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getTrackedPool } from '@/lib/pool-registry';
import { getConnection } from '@/lib/solana';
import { getDuel, forfeitApplies, forfeitWinnerWallet, recordForfeitPayout } from '@/lib/db/duels';
import { parseAddress } from '@/lib/api-validation';

/**
 * POST /api/pools/[address]/duel-forfeit-deposits
 *
 * Record a verified duel forfeit payout in the ledger. The client calls
 * this after a successful creator claim on the losing pool that
 * redirected the creator remainder to the duel winner; the server
 * verifies the transfer on-chain from the claim transaction and only
 * records what the chain confirms.
 *
 * Body: { duelId: number, txSignature: string }
 * Idempotent: the same signature can never credit the ledger twice.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });
  const tracked = await getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  const duelId = Number(req.body?.duelId);
  const txSignature = typeof req.body?.txSignature === 'string' ? req.body.txSignature.trim() : '';
  if (!Number.isInteger(duelId) || duelId <= 0) {
    return res.status(400).json({ error: 'duelId is required' });
  }
  if (!txSignature || txSignature.length > 128) {
    return res.status(400).json({ error: 'txSignature is required' });
  }

  const duel = await getDuel(duelId);
  if (!duel || !forfeitApplies(address, duel, Date.now())) {
    return res.status(400).json({ error: 'No live forfeit applies to this pool' });
  }
  const winnerWallet = forfeitWinnerWallet(duel);
  if (!winnerWallet) return res.status(500).json({ error: 'Duel has no winner wallet' });

  let quoteMint: PublicKey;
  let winner: PublicKey;
  try {
    quoteMint = new PublicKey(tracked.quoteMint);
    winner = new PublicKey(winnerWallet);
  } catch {
    return res.status(500).json({ error: 'Invalid mint or winner wallet' });
  }
  const winnerAta = getAssociatedTokenAddressSync(quoteMint, winner);

  let baseRaw = '0';
  let quoteRaw = '0';
  try {
    const connection = getConnection();
    const tx = await connection.getTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx || tx.meta?.err) {
      return res.status(400).json({ error: 'Transaction not found or failed on-chain' });
    }
    const accountKeys = tx.transaction.message.getAccountKeys();
    const ataIndex = accountKeys.staticAccountKeys.findIndex((k) => k.equals(winnerAta));
    if (ataIndex < 0) {
      return res.status(400).json({ error: 'Transaction did not touch the winner wallet' });
    }
    const mintStr = quoteMint.toBase58();
    const deltaFor = (mint: string) => {
      const balFor = (list: typeof tx.meta.preTokenBalances) => {
        const entry = list?.find((b) => b.accountIndex === ataIndex && b.mint === mint);
        return entry ? BigInt(entry.uiTokenAmount.amount) : BigInt(0);
      };
      return balFor(tx.meta.postTokenBalances) - balFor(tx.meta.preTokenBalances);
    };
    const qDelta = deltaFor(quoteMint.toBase58());
    if (qDelta <= BigInt(0)) {
      return res.status(400).json({ error: 'Transaction did not pay the winner' });
    }
    quoteRaw = qDelta.toString();
    try {
      const baseMint = new PublicKey(tracked.baseMint);
      const bDelta = deltaFor(baseMint.toBase58());
      if (bDelta > BigInt(0)) baseRaw = bDelta.toString();
    } catch {
      // Base leg optional; quote leg is the prize.
    }
  } catch (e) {
    return res.status(502).json({ error: `Could not verify transaction: ${(e as Error).message}` });
  }

  await recordForfeitPayout({
    duelId,
    poolAddress: address,
    winnerWallet,
    baseAmountRaw: baseRaw,
    quoteAmountRaw: quoteRaw,
    quoteMint: quoteMint.toBase58(),
    txSignature,
  });
  return res.status(200).json({ ok: true, duelId, poolAddress: address, quoteAmountRaw: quoteRaw });
}
