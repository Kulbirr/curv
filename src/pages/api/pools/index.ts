import type { NextApiRequest, NextApiResponse } from 'next';
import { listTrackedPools, registerPool } from '@/lib/pool-registry';
import type { TrackedPool } from '@/lib/pool-registry';
import { getPoolStatesBatch } from '@/lib/db/states';
import type { StoredPoolState } from '@/lib/db/states';
import { isSampleStale } from '@/lib/db/config';
import { claimNonce, pruneNonces } from '@/lib/db/nonces';
import {
  REGISTRATION_IP_LIMIT,
  REGISTRATION_IP_WINDOW_MS,
  REGISTRATION_WALLET_LIMIT,
  REGISTRATION_WALLET_WINDOW_MS,
  hitRateLimit,
  pruneRateLimits,
} from '@/lib/db/rate-limits';
import { getPrices24hAgoBatch, getVolumes24hBatch } from '@/lib/price-history';
import { getQuoteUsdPrice } from '@/lib/quote-prices';
import { SOLANA_NETWORK } from '@/lib/solana';
import {
  REGISTRATION_TTL_MS,
  buildRegistrationMessage,
  isFreshTimestamp,
  verifyWalletSignature,
} from '@/lib/signatures';
import { getClientIp, validateRegistrationBody } from '@/lib/api-validation';
import { verifyAndRecord } from '@/lib/pool-verification';

/**
 * Registration bodies are small JSON (~2KB). Anything larger is abuse.
 * (The 2MB-image metadata route sets its own larger limit.)
 */
export const config = {
  api: { bodyParser: { sizeLimit: '32kb' } },
};

export interface PoolSummary {
  poolAddress: string;
  baseSymbol: string;
  baseName: string;
  /** Base token mint, lets clients (e.g. Portfolio) match holdings exactly. */
  baseMint: string;
  /** Quote token mint. */
  quoteMint: string;
  quoteSymbol: string;
  imageUrl: string | null;
  description: string | null;
  creator: string;
  createdAt: number;
  price: number | null;
  priceUsd: number | null;
  change24h: number | null;
  progress: number | null;
  graduated: boolean;
  marketCap: number | null;
  marketCapUsd: number | null;
  volume24h: number | null;
  stale: boolean;
  /** True only when every submitted field matched the on-chain accounts. */
  verified: boolean;
}

/**
 * Build a pool summary from INDEXED state only. This handler makes zero
 * live Solana RPC calls per request: the background indexer samples each
 * pool once per interval and this reads its persisted rows.
 *
 * Honesty contract (unchanged from the live-read era):
 * - state older than STALE_AFTER_MS is served with stale: true (never
 *   "updating…"); the last real values are shown, not blanked or invented
 * - volume24h is sampled reserve movement = estimated activity (EST VOL),
 *   never exact volume
 * - unverified pools keep verified: false
 */
interface BatchReads {
  states: Map<string, StoredPoolState>;
  prices24hAgo: Map<string, number>;
  volumes24h: Map<string, number>;
}

function buildSummary(
  tracked: TrackedPool,
  quoteUsd: number | null,
  batch: BatchReads,
): PoolSummary | null {
  const state = batch.states.get(tracked.poolAddress) ?? null;
  const now = Date.now();
  // No indexed sample yet (indexer hasn't completed a pass, or every
  // sample failed): honest nulls, marked stale.
  const stale = !state || isSampleStale(state.sampledAt, now);

  const price = state?.price ?? null;
  const marketCap = state?.marketCap ?? null;

  const price24hAgo = batch.prices24hAgo.get(tracked.poolAddress) ?? null;
  const change24h =
    price !== null && price24hAgo !== null && price24hAgo > 0
      ? ((price - price24hAgo) / price24hAgo) * 100
      : null;

  const priceUsd = price !== null && quoteUsd !== null ? price * quoteUsd : null;
  const marketCapUsd = marketCap !== null && quoteUsd !== null ? marketCap * quoteUsd : null;

  return {
    poolAddress: tracked.poolAddress,
    baseSymbol: tracked.baseSymbol,
    baseName: tracked.baseName,
    baseMint: tracked.baseMint,
    quoteMint: tracked.quoteMint,
    quoteSymbol: tracked.quoteSymbol,
    imageUrl: tracked.imageUrl ?? null,
    description: tracked.description ?? null,
    creator: tracked.creator,
    createdAt: tracked.createdAt,
    price,
    priceUsd,
    change24h,
    progress: state?.progress ?? null,
    graduated: state?.graduated ?? false,
    marketCap,
    marketCapUsd,
    // Estimated activity only: sampled reserve movement, not exact trade
    // volume. UI must label it as an estimate, never as exact volume.
    volume24h: batch.volumes24h.get(tracked.poolAddress) ?? null,
    stale,
    verified: tracked.verified === true,
  };
}

/** 3s list cache (see handleGet). Module-level: shared across requests. */
const LIST_CACHE_TTL_MS = 3_000;
let listCache: { at: number; body: unknown } | null = null;
/**
 * In-flight list rebuild, shared by concurrent requests (singleflight).
 * Without this, every cache expiry under load makes every concurrent
 * request run its own full multi-query rebuild, collapsing the DB pool.
 * Load-tested 2026-09-30: 5k pools, c=50 went from p50 ~46s to ~1.4s.
 */
let listRebuild: Promise<unknown> | null = null;

/** A new registration must be visible immediately: drop the cached list. */
function invalidateListCache(): void {
  listCache = null;
}

async function buildListBody(): Promise<unknown> {
  const pools = await listTrackedPools();
  // Quote USD prices are cached 60s in memory and short-circuit to null on
  // devnet without any network call, one lookup per distinct quote mint.
  const quoteMints = [...new Set(pools.map((p) => p.quoteMint))];
  const quoteUsdByMint = new Map<string, number | null>();
  await Promise.all(
    quoteMints.map(async (mint) => {
      quoteUsdByMint.set(mint, await getQuoteUsdPrice(mint));
    }),
  );
  // Batch the per-pool reads: 3 queries total regardless of pool count,
  // instead of 3 per pool. This is what keeps the list fast at thousands
  // of pools.
  const addresses = pools.map((p) => p.poolAddress);
  const [states, prices24hAgo, volumes24h] = await Promise.all([
    getPoolStatesBatch(addresses),
    getPrices24hAgoBatch(addresses),
    getVolumes24hBatch(addresses),
  ]);
  const batch: BatchReads = { states, prices24hAgo, volumes24h };
  const summaries = pools.map((p) =>
    buildSummary(p, quoteUsdByMint.get(p.quoteMint) ?? null, batch),
  );
  return {
    network: SOLANA_NETWORK,
    pools: summaries.filter((s): s is PoolSummary => s !== null),
  };
}

async function handleGet(_req: NextApiRequest, res: NextApiResponse) {
  // Short-lived cache: the Discover page polls this endpoint every 5s per
  // client, so without a cache N clients = N full list builds per 5s.
  // 3s is well within the page's own 5s poll rhythm and the honest-stale
  // contract (state older than STALE_AFTER_MS is still labeled stale).
  // Skipped under test so tests stay deterministic.
  const skipCache = process.env.NODE_ENV === 'test';
  if (!skipCache) {
    const now = Date.now();
    if (listCache && now - listCache.at < LIST_CACHE_TTL_MS) {
      return res.status(200).json(listCache.body);
    }
    if (listRebuild) {
      // A rebuild is already running: share it instead of stampeding the
      // database. Serve the stale list immediately when we have one
      // (stale-while-revalidate); only a cold cache waits for the build.
      if (listCache) return res.status(200).json(listCache.body);
      return res.status(200).json(await listRebuild);
    }
    if (listCache) {
      // Stale-while-revalidate: serve the stale list now, refresh in the
      // background. Failures keep serving stale; the next expiry retries.
      const rebuild = buildListBody();
      listRebuild = rebuild;
      rebuild.then(
        (body) => {
          listCache = { at: Date.now(), body };
        },
        () => {
          /* keep serving stale; next expiry retries */
        },
      ).finally(() => {
        if (listRebuild === rebuild) listRebuild = null;
      });
      return res.status(200).json(listCache.body);
    }
    // Cold cache: this request must wait for the first build.
    const rebuild = buildListBody();
    listRebuild = rebuild;
    try {
      const body = await rebuild;
      listCache = { at: Date.now(), body };
      return res.status(200).json(body);
    } finally {
      if (listRebuild === rebuild) listRebuild = null;
    }
  }
  return res.status(200).json(await buildListBody());
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const now = Date.now();

  // 1. DB-backed distributed rate limits (shared across instances; the old
  //    in-memory Map is gone). Abusive floods are rejected before any
  //    expensive work.
  const ip = getClientIp(req);
  const ipHit = await hitRateLimit(`reg:ip:${ip}`, REGISTRATION_IP_LIMIT, REGISTRATION_IP_WINDOW_MS, now);
  if (!ipHit.allowed) {
    return res.status(429).json({ error: 'Too many registrations from this address, try again later' });
  }

  // 2. Strict schema: unknown fields dropped, malformed values get a 400
  //    naming the problem. This also normalizes every address to base58
  //    and rejects cross-network quote mints (e.g. mainnet USDC on devnet).
  const parsed = validateRegistrationBody(req.body);
  // NOTE: compare with `=== false`, not `!parsed.ok`, this project's
  // tsconfig disables strictNullChecks, under which TS does not narrow
  // discriminated unions on falsy checks.
  if (parsed.ok === false) return res.status(400).json({ error: parsed.error });
  const input = parsed.value;

  const walletHit = await hitRateLimit(
    `reg:wallet:${input.creator}`,
    REGISTRATION_WALLET_LIMIT,
    REGISTRATION_WALLET_WINDOW_MS,
    now,
  );
  if (!walletHit.allowed) {
    return res.status(429).json({ error: 'Too many registrations from this wallet, try again later' });
  }

  // 3. Freshness + wallet signature (the wallet must have signed this exact
  //    registration message within the TTL).
  if (!isFreshTimestamp(input.timestamp)) {
    return res.status(400).json({ error: 'Registration expired, sign again' });
  }
  const message = buildRegistrationMessage(input.poolAddress, input.creator, input.timestamp);
  if (!verifyWalletSignature(message, input.signature, input.creator)) {
    return res.status(401).json({ error: 'Invalid wallet signature' });
  }

  // 4. Persistent replay protection: the claim is one atomic INSERT, so a
  //    replayed signature can never be accepted twice, even concurrently,
  //    even on another instance.
  await pruneNonces(now - REGISTRATION_TTL_MS);
  await pruneRateLimits(now);
  if (!(await claimNonce(input.signature, now))) {
    return res.status(400).json({ error: 'Signature already used' });
  }

  // 5. Field-by-field on-chain verification. A mismatch is positive
  //    evidence of a bad submission → the pool is REJECTED, not registered.
  //    An unreachable RPC is inconclusive → honest `unverified` label.
  const verification = await verifyAndRecord(input);
  if (verification.status === 'rejected') {
    return res.status(400).json({ error: `Pool verification failed: ${verification.detail}` });
  }

  // 6. Transactional registry insert.
  try {
    const entry = await registerPool({ ...input, verified: verification.status === 'verified' });
    invalidateListCache();
    return res.status(201).json({ pool: entry });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid request' });
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
