import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { parseAddress } from '@/lib/api-validation';
import { getConnection } from '@/lib/solana';
import {
  buildClaimPartnerFeesTx,
  buildClaimPartnerPoolCreationFeeTx,
  buildWithdrawPartnerMigrationFeeTx,
} from '@/lib/claim-partner-fees';

/**
 * POST /api/claims/partner/build
 *
 * Build an UNSIGNED Curv partner-fee claim transaction for the connected
 * fee wallet to sign in the browser. This is the manual-claim path: the
 * server never sees the fee wallet secret.
 *
 * Body: { poolAddress: string, kind: 'trading' | 'migration' | 'creation', feeWallet: string }
 *   trading:   Curv's bonding-curve trading fees
 *   migration: Curv's migration fee (graduated pools)
 *   creation:  Curv's share of the pool creation fee
 *
 * Returns: { transaction: base64 } — unsigned, with a fresh blockhash and
 * the fee wallet set as fee payer. The client signs and sends it.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

const KINDS = new Set(['trading', 'migration', 'creation']);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const poolAddress = parseAddress(req.body?.poolAddress);
  const feeWallet = parseAddress(req.body?.feeWallet);
  const kind = req.body?.kind;
  if (!poolAddress) return res.status(400).json({ error: 'poolAddress is not a valid Solana address' });
  if (!feeWallet) return res.status(400).json({ error: 'feeWallet is not a valid Solana address' });
  if (!KINDS.has(kind))
    return res.status(400).json({ error: "kind must be 'trading', 'migration' or 'creation'" });

  try {
    let tx;
    if (kind === 'trading') {
      tx = await buildClaimPartnerFeesTx({ poolAddress, feeClaimer: feeWallet });
    } else if (kind === 'migration') {
      tx = await buildWithdrawPartnerMigrationFeeTx({ poolAddress, sender: feeWallet });
    } else {
      tx = await buildClaimPartnerPoolCreationFeeTx({ poolAddress, feeReceiver: feeWallet });
    }

    // Fresh blockhash + fee payer so the client only has to sign and send.
    const connection = getConnection();
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.feePayer = new PublicKey(feeWallet);
    tx.recentBlockhash = blockhash;

    return res.status(200).json({
      transaction: Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64'),
      lastValidBlockHeight,
    });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
