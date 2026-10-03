import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { requireAdmin } from '@/lib/strategies/admin-auth';
import { listUniverse, setUniverseActive } from '@/lib/db/strategy-pipeline';
import { execute } from '@/lib/db';

export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/**
 * Signal universe management. Operator only.
 *
 * GET /api/strategies/universe
 *   List every universe coin with tier and active flag.
 * POST /api/strategies/universe { action: 'toggle', baseMint, active }
 *   Activate or deactivate a coin.
 * POST /api/strategies/universe { action: 'add', baseMint, symbol, coingeckoId, tier }
 *   Add a coin to the universe.
 */

function validMint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

function validSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().toUpperCase();
  if (t.length === 0 || t.length > 12 || !/^[A-Z0-9]+$/.test(t)) return null;
  return t;
}

function validId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().toLowerCase();
  if (t.length === 0 || t.length > 64 || !/^[a-z0-9-]+$/.test(t)) return null;
  return t;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!requireAdmin(req, res)) return;
  if (req.method === 'GET') {
    try {
      const universe = await listUniverse();
      return res.status(200).json({ universe });
    } catch {
      return res.status(500).json({ error: 'Could not load the universe' });
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.action === 'toggle') {
    const baseMint = validMint(body.baseMint);
    if (!baseMint) return res.status(400).json({ error: 'baseMint must be a valid Solana address' });
    try {
      const ok = await setUniverseActive(baseMint, body.active === true);
      if (!ok) return res.status(404).json({ error: 'Coin not found in the universe' });
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not update the universe' });
    }
  }

  if (body.action === 'add') {
    const baseMint = validMint(body.baseMint);
    const symbol = validSymbol(body.symbol);
    const coingeckoId = validId(body.coingeckoId);
    const tier = body.tier === 'satellite' ? 'satellite' : 'core';
    if (!baseMint) return res.status(400).json({ error: 'baseMint must be a valid Solana address' });
    if (!symbol) return res.status(400).json({ error: 'symbol must be 1 to 12 letters or digits' });
    if (!coingeckoId) return res.status(400).json({ error: 'coingeckoId must be a valid CoinGecko id' });
    try {
      await execute(
        `INSERT INTO strategy_universe (base_mint, symbol, coingecko_id, tier, active, created_at)
         VALUES ($1, $2, $3, $4, 1, $5)
         ON CONFLICT (base_mint) DO UPDATE SET symbol = EXCLUDED.symbol,
           coingecko_id = EXCLUDED.coingecko_id, tier = EXCLUDED.tier, active = 1`,
        [baseMint, symbol, coingeckoId, tier, Date.now()],
      );
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not add the coin' });
    }
  }

  return res.status(400).json({ error: "action must be 'toggle' or 'add'" });
}
