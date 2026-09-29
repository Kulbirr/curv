import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { parseAddress } from '@/lib/api-validation';
import { getConnection, getDbcClient } from '@/lib/solana';
import {
  buildClaimPartnerFeesTx,
  buildClaimPartnerPoolCreationFeeTx,
  buildWithdrawPartnerMigrationFeeTx,
  getPartnerClaimable,
  loadFeeWalletKeypair,
} from '@/lib/claim-partner-fees';

/**
 * POST /api/claims/partner
 *
 * Server-side claim of Curv's own on-chain fees for one pool. The fee
 * wallet signs, so this never touches a user wallet. Only Curv's fees
 * move, and only into Curv's fee wallet.
 *
 * Body: { poolAddress: string, kind: 'trading' | 'migration' | 'creation' }
 *   trading:   Curv's ~0.652% bonding-curve trading fees
 *   migration: Curv's 6% migration fee (graduated pools)
 *   creation:  Curv's 90% of the 0.02 SOL pool creation fee
 *
 * Auth: x-claim-secret header must equal CURV_CLAIM_SECRET. Without it,
 * anyone could trigger claims and burn our SOL on transaction fees.
 *
 * Env: CURV_FEE_WALLET_SECRET (base58 secret key of the fee wallet),
 *      CURV_CLAIM_SECRET (shared secret for this route).
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

const KINDS = new Set(['trading', 'migration', 'creation']);

function unauthorized(res: NextApiResponse) {
  return res.status(401).json({ error: 'Missing or invalid x-claim-secret' });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CURV_CLAIM_SECRET;
  if (!secret || req.headers['x-claim-secret'] !== secret) return unauthorized(res);

  const poolAddress = parseAddress(req.body?.poolAddress);
  const kind = req.body?.kind;
  if (!poolAddress) return res.status(400).json({ error: 'poolAddress is not a valid Solana address' });
  if (!KINDS.has(kind))
    return res.status(400).json({ error: "kind must be 'trading', 'migration' or 'creation'" });

  let feeWallet;
  try {
    feeWallet = loadFeeWalletKeypair();
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
  const feeClaimer = feeWallet.publicKey.toBase58();

  // Safety: only claim for pools whose on-chain feeClaimer is our wallet.
  // Claiming anyone else's pool would just burn our transaction fee.
  try {
    const client = getDbcClient();
    const pool: unknown = await client.state.getPool(new PublicKey(poolAddress));
    if (!pool) return res.status(404).json({ error: 'Pool not found on-chain' });
    const ps = ((pool as { poolState?: unknown }).poolState ?? pool) as Record<string, unknown>;
    const onChainClaimer = ps['feeClaimer'];
    const onChainClaimerStr =
      onChainClaimer && typeof onChainClaimer === 'object'
        ? (onChainClaimer as { toBase58?: () => string }).toBase58?.()
        : String(onChainClaimer ?? '');
    if (onChainClaimerStr !== feeClaimer) {
      return res.status(403).json({ error: 'Pool feeClaimer is not the Curv fee wallet' });
    }
  } catch (e) {
    return res.status(502).json({ error: `Failed to read pool: ${(e as Error).message}` });
  }

  const connection = getConnection();
  try {
    let tx;
    if (kind === 'trading') {
      const claimable = await getPartnerClaimable(poolAddress);
      if (claimable.baseRaw === '0' && claimable.quoteRaw === '0') {
        return res.status(200).json({ signature: null, claimed: false, reason: 'nothing to claim' });
      }
      tx = await buildClaimPartnerFeesTx({ poolAddress, feeClaimer });
    } else if (kind === 'migration') {
      tx = await buildWithdrawPartnerMigrationFeeTx({ poolAddress, sender: feeClaimer });
    } else {
      tx = await buildClaimPartnerPoolCreationFeeTx({ poolAddress, feeReceiver: feeClaimer });
    }

    tx.feePayer = feeWallet.publicKey;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(feeWallet);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    return res.status(200).json({ signature, claimed: true, kind, poolAddress });
  } catch (e) {
    return res.status(502).json({ error: `Claim failed: ${(e as Error).message}` });
  }
}
