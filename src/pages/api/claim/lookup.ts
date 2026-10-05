import type { NextApiRequest, NextApiResponse } from 'next';
import { query } from '@/lib/db';

/**
 * GET /api/claim/lookup?platform=x|twitch|reddit&handle=...
 *
 * Finds unclaimed fee split entries for a social handle across all
 * pools, so recipients can find their claim link without the pool
 * creator having to send it. Handle matching is case-insensitive;
 * a leading @ (X/Twitch) or u/ (Reddit) is stripped.
 *
 * Only reveals that a claim exists and its link. The claim itself
 * still requires the platform's verification (tweet for X, OAuth
 * for Twitch/Reddit), so looking up someone else's handle is harmless.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '4kb' } },
};

const PLATFORMS = new Set(['x', 'twitch']);

function normalizeHandle(platform: string, raw: string): string {
  let h = raw.trim();
  if (h.startsWith('@')) h = h.slice(1);
  if (platform === 'reddit' && h.toLowerCase().startsWith('u/')) h = h.slice(2);
  return h;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const platform = String(req.query.platform ?? '').toLowerCase();
  const handle = normalizeHandle(platform, String(req.query.handle ?? ''));
  if (!PLATFORMS.has(platform)) {
    return res.status(400).json({ error: 'platform must be x or twitch' });
  }
  if (handle.length < 1 || handle.length > 30) {
    return res.status(400).json({ error: 'handle is required' });
  }

  // recipients is a JSON text column; entries without a platform default to 'x'.
  const rows = await query<{
    pool_address: string;
    recipients: string;
  }>(
    `SELECT pool_address, recipients FROM fee_splits
     WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements(recipients::jsonb) AS r
       WHERE LOWER(r->>'handle') = LOWER($1)
         AND COALESCE(r->>'platform', 'x') = $2
     )
     ORDER BY pool_address`,
    [handle, platform],
  );

  const claims: Array<{
    poolAddress: string;
    entryIndex: number;
    bps: number;
    bound: boolean;
    claimUrl: string;
  }> = [];

  for (const row of rows) {
    let recipients: Array<{ bps?: number; handle?: string; platform?: string; wallet?: string }>;
    try {
      recipients = JSON.parse(row.recipients);
      if (!Array.isArray(recipients)) continue;
    } catch {
      continue;
    }
    const boundRows = await query<{ entry_index: number }>(
      'SELECT entry_index FROM fee_split_bindings WHERE pool_address = $1',
      [row.pool_address],
    );
    const boundSet = new Set(boundRows.map((b) => b.entry_index));
    recipients.forEach((r, i) => {
      if (
        typeof r.handle === 'string' &&
        r.handle.toLowerCase() === handle.toLowerCase() &&
        (r.platform ?? 'x') === platform
      ) {
        const bound = boundSet.has(i) || !!r.wallet;
        claims.push({
          poolAddress: row.pool_address,
          entryIndex: i,
          bps: typeof r.bps === 'number' ? r.bps : 0,
          bound,
          claimUrl: `/claim/onboard/${row.pool_address}/${i}`,
        });
      }
    });
  }

  return res.status(200).json({ platform, handle, claims });
}
