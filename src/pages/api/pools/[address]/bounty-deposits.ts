import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getTrackedPool } from '@/lib/pool-registry';
import { getConnection } from '@/lib/solana';
import { resolveBountyVault } from '@/lib/fee-split-claim';
import { recordBountyDeposit } from '@/lib/db/bounties';
import { parseAddress } from '@/lib/api-validation';

/**
 * POST /api/pools/[address]/bounty-deposits
 *
 * Record a verified bounty deposit in the per-pool ledger. The client
 * calls this after a successful creator claim that diverted a bounty
 * slice to the bounty vault; the server verifies the transfer on-chain
 * from the claim transaction and only records what the chain confirms.
 *
 * Why verification matters: the keeper's payout budget comes from this
 * ledger, and the vault is shared across pools. If the client could
 * self-report amounts, a pool could inflate its budget and pay its
 * winners from another pool's funds. The on-chain check makes that
 * impossible.
 *
 * Body: { txSignature: string } — a confirmed claim transaction.
 * Idempotent: the same signature can never credit a pool twice.
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
  if (!tracked.bountyBps || tracked.bountyBps <= 0) {
    return res.status(400).json({ error: 'This pool has no bounty commitment' });
  }

  const txSignature = typeof req.body?.txSignature === 'string' ? req.body.txSignature.trim() : '';
  if (!txSignature || txSignature.length > 128) {
    return res.status(400).json({ error: 'txSignature is required' });
  }

  const vault = resolveBountyVault();
  if (!vault) return res.status(500).json({ error: 'Bounty vault is not configured' });

  let quoteMint: PublicKey;
  try {
    quoteMint = new PublicKey(tracked.quoteMint);
  } catch {
    return res.status(500).json({ error: 'Pool has an invalid quote mint' });
  }
  const vaultAta = getAssociatedTokenAddressSync(quoteMint, vault);

  let depositedRaw = '0';
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
    const ataIndex = accountKeys.staticAccountKeys.findIndex((k) => k.equals(vaultAta));
    if (ataIndex < 0) {
      return res.status(400).json({ error: 'Transaction did not touch the bounty vault' });
    }
    const mintStr = quoteMint.toBase58();
    const balFor = (list: typeof tx.meta.preTokenBalances) => {
      const entry = list?.find((b) => b.accountIndex === ataIndex && b.mint === mintStr);
      return entry ? BigInt(entry.uiTokenAmount.amount) : BigInt(0);
    };
    const delta = balFor(tx.meta.postTokenBalances) - balFor(tx.meta.preTokenBalances);
    if (delta <= BigInt(0)) {
      return res.status(400).json({ error: 'Transaction did not deposit to the bounty vault' });
    }
    depositedRaw = delta.toString();
  } catch (e) {
    return res.status(502).json({ error: `Could not verify transaction: ${(e as Error).message}` });
  }

  const inserted = await recordBountyDeposit(tracked.poolAddress, quoteMint.toBase58(), depositedRaw, txSignature);
  return res.status(200).json({
    ok: true,
    poolAddress: tracked.poolAddress,
    amountRaw: depositedRaw,
    recorded: inserted,
  });
}
