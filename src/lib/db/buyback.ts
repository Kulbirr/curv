import { execute, query } from './index';

export interface BuybackBurn {
  id: number;
  poolAddress: string;
  txSignature: string;
  quoteAmountRaw: string;
  baseAmountRaw: string;
  burnedAt: number;
}

/**
 * Storage half of the buyback and burn feature. The creator commits a
 * percentage of their fee share at launch; it is written once and never
 * edited, same immutability rule as fee splits.
 */

export async function setBuybackBps(poolAddress: string, bps: number): Promise<void> {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new Error('buyback_bps must be an integer between 0 and 10000');
  }
  await execute('UPDATE pools SET buyback_bps = $1 WHERE pool_address = $2', [bps, poolAddress]);
}

export async function getBuybackBps(poolAddress: string): Promise<number> {
  const rows = await query<{ buyback_bps: number }>(
    'SELECT buyback_bps FROM pools WHERE pool_address = $1',
    [poolAddress],
  );
  return rows[0]?.buyback_bps ?? 0;
}

/** All pools with buyback enabled, for the keeper to sweep. */
export async function listBuybackPools(): Promise<Array<{ poolAddress: string; buybackBps: number }>> {
  const rows = await query<{ pool_address: string; buyback_bps: number }>(
    'SELECT pool_address, buyback_bps FROM pools WHERE buyback_bps > 0',
  );
  return rows.map((r) => ({ poolAddress: r.pool_address, buybackBps: r.buyback_bps }));
}

export async function recordBurn(
  poolAddress: string,
  txSignature: string,
  quoteAmountRaw: string,
  baseAmountRaw: string,
): Promise<void> {
  await execute(
    `INSERT INTO buyback_burns (pool_address, tx_signature, quote_amount_raw, base_amount_raw, burned_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tx_signature) DO NOTHING`,
    [poolAddress, txSignature, quoteAmountRaw, baseAmountRaw, Date.now()],
  );
}

export async function getBurns(poolAddress: string, limit = 50): Promise<BuybackBurn[]> {
  const rows = await query<{
    id: number;
    pool_address: string;
    tx_signature: string;
    quote_amount_raw: string;
    base_amount_raw: string;
    burned_at: number;
  }>(
    'SELECT id, pool_address, tx_signature, quote_amount_raw, base_amount_raw, burned_at FROM buyback_burns WHERE pool_address = $1 ORDER BY burned_at DESC LIMIT $2',
    [poolAddress, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    poolAddress: r.pool_address,
    txSignature: r.tx_signature,
    quoteAmountRaw: r.quote_amount_raw,
    baseAmountRaw: r.base_amount_raw,
    burnedAt: r.burned_at,
  }));
}

export async function getBurnStats(poolAddress: string): Promise<{
  totalBurns: number;
  lastBurnAt: number | null;
}> {
  const rows = await query<{ count: string; max_burned: number | null }>(
    'SELECT COUNT(*) as count, MAX(burned_at) as max_burned FROM buyback_burns WHERE pool_address = $1',
    [poolAddress],
  );
  return {
    totalBurns: Number(rows[0]?.count ?? 0),
    lastBurnAt: rows[0]?.max_burned ?? null,
  };
}
