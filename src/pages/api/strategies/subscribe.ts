import type { NextApiRequest, NextApiResponse } from 'next';
import { parseAddress, parseSignature } from '@/lib/api-validation';
import {
  SUBSCRIPTION_DURATION_MS,
  SUBSCRIPTION_PRICE_LAMPORTS,
} from '@/lib/strategies';
import { claimPaymentSignature, recordSubscription } from '@/lib/db/strategies';
import { platformFeeWallet } from '@/lib/launch';
import { resolveProxyUpstream } from '@/lib/rpc-proxy';

export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/**
 * POST /api/strategies/subscribe { wallet, signature }
 *
 * Activates a 30 day strategies feed pass after verifying, on chain, that
 * `signature` is a plain SOL transfer of at least the pass price from
 * `wallet` to the Curv fee wallet. The user signs and sends the transfer
 * themselves in their own wallet; this route only reads the chain.
 *
 * The payment signature is claimed exactly once (idempotency): a signature
 * that already paid for a pass is rejected.
 */

/** A payment older than this is rejected as stale. */
const PAYMENT_FRESHNESS_MS = 30 * 60_000;
const RPC_TIMEOUT_MS = 15_000;

interface ParsedInstruction {
  program?: string;
  parsed?: {
    type?: string;
    info?: { source?: string; destination?: string; lamports?: number };
  };
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const upstream = resolveProxyUpstream();
  if (!upstream) throw new Error('no upstream');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message || 'rpc error');
    return json.result as T;
  } finally {
    clearTimeout(timer);
  }
}

interface ParsedTx {
  meta?: { err?: unknown } | null;
  blockTime?: number | null;
  transaction?: {
    message?: {
      instructions?: ParsedInstruction[];
    };
  } | null;
}

/**
 * True when the transaction is a plain SOL transfer of at least
 * minLamports from wallet to feeWallet, confirmed recently.
 */
export function isValidPassPayment(
  tx: ParsedTx | null | undefined,
  wallet: string,
  feeWallet: string,
  minLamports: number,
  nowMs: number,
): boolean {
  if (!tx || !tx.meta || tx.meta.err) return false;
  if (typeof tx.blockTime !== 'number' || nowMs - tx.blockTime * 1000 > PAYMENT_FRESHNESS_MS) {
    return false;
  }
  const instructions = tx.transaction?.message?.instructions;
  if (!Array.isArray(instructions)) return false;
  return instructions.some((ix) => {
    if (ix.program !== 'system') return false;
    const info = ix.parsed?.info;
    if (ix.parsed?.type !== 'transfer' || !info) return false;
    return (
      info.source === wallet &&
      info.destination === feeWallet &&
      typeof info.lamports === 'number' &&
      info.lamports >= minLamports
    );
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const wallet = parseAddress(body.wallet);
  if (!wallet) return res.status(400).json({ error: 'A valid wallet address is required' });
  const signature = parseSignature(body.signature);
  if (!signature) return res.status(400).json({ error: 'A valid payment signature is required' });

  const feeWallet = platformFeeWallet();
  if (!feeWallet) {
    return res.status(503).json({ error: 'Pass payments are not configured yet' });
  }
  const feeWalletStr = feeWallet.toBase58();

  // Verify the payment on chain before claiming the signature, so a
  // transient RPC failure does not burn a valid payment.
  let tx: ParsedTx | null;
  try {
    tx = await rpcCall<ParsedTx | null>('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
  } catch {
    return res.status(502).json({ error: 'Could not reach the chain, try again' });
  }
  if (!tx) {
    return res.status(422).json({ error: 'Payment not found on chain yet, try again in a few seconds' });
  }
  if (!isValidPassPayment(tx, wallet, feeWalletStr, SUBSCRIPTION_PRICE_LAMPORTS, Date.now())) {
    return res.status(422).json({ error: 'That transaction is not a valid pass payment' });
  }

  // Atomic claim: one signature pays for one pass, even under concurrency.
  let claimed: boolean;
  try {
    claimed = await claimPaymentSignature(signature, wallet);
  } catch {
    return res.status(500).json({ error: 'Could not record the payment' });
  }
  if (!claimed) {
    return res.status(409).json({ error: 'This payment was already used' });
  }

  try {
    const sub = await recordSubscription(wallet, signature, SUBSCRIPTION_DURATION_MS, Date.now());
    return res.status(200).json({ active: true, expiresAt: sub.expiresAt });
  } catch {
    return res.status(500).json({ error: 'Could not activate the pass' });
  }
}
