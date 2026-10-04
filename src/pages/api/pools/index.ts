import type { NextApiRequest, NextApiResponse } from 'next';
import { listTrackedPools, registerPool } from '@/lib/pool-registry';
import type { TrackedPool } from '@/lib/pool-registry';
import { getPoolStatesBatch } from '@/lib/db/states';
import type { StoredPoolState } from '@/lib/db/states';
import { isSampleStale } from '@/lib/db/config';
import { claimNonce, pruneNonces } from '@/lib/db/nonces';
import { healMissingPoolImages } from '@/lib/pool-image-heal';
import {
  REGISTRATION_IP_LIMIT,
  REGISTRATION_IP_WINDOW_MS,
  REGISTRATION_WALLET_LIMIT,
  REGISTRATION_WALLET_WINDOW_MS,
  hitRateLimit,
  pruneRateLimits,
} from '@/lib/db/rate-limits';
import { getPrices24hAgoBatch, getSparklinesBatch, getVolumes24hBatch } from '@/lib/price-history';
import { insertFeeSplits } from '@/lib/db/fee-splits';
import { getQuoteUsdPrice, isUsdReferencePrice } from '@/lib/quote-prices';
import { SOLANA_NETWORK } from '@/lib/solana';
import {
  REGISTRATION_TTL_MS,
  buildRegistrationMessage,
  isFreshTimestamp,
  verifyWalletSignature,
} from '@/lib/signatures';
import { getClientIp, validateRegistrationBody } from '@/lib/api-validation';
import { verifyAndRecord } from '@/lib/pool-verification';
import {
  paginatePools,
  parsePoolsPagination,
  sortPoolSummaries,
} from '@/lib/pools-pagination';

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
  /**
   * Card sparkline: real sampled prices (quote units), oldest first,
   * bucketed across the trailing 24h. Null when fewer than 2 samples
   * exist; the UI must draw nothing rather than invent a shape.
   */
  sparkline: number[] | null;
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
  sparklines: Map<string, number[]>;
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
    sparkline: batch.sparklines.get(tracked.poolAddress) ?? null,
    stale,
    verified: tracked.verified === true,
  };
}

/** 3s list cache (see handleGet). Module-level: shared across requests. */
const LIST_CACHE_TTL_MS = 3_000;

interface ListBody {
  network: typeof SOLANA_NETWORK;
  /** True on devnet: USD figures are a mainnet reference, not real value. */
  usdReference: boolean;
  pools: PoolSummary[];
}

let listCache: { at: number; body: ListBody; json: string } | null = null;
/**
 * In-flight list rebuild, shared by concurrent requests (singleflight).
 * Without this, every cache expiry under load makes every concurrent
 * request run its own full multi-query rebuild, collapsing the DB pool.
 * Load-tested 2026-09-30: 5k pools, c=50 went from p50 ~46s to ~1.4s.
 */
let listRebuild: Promise<ListBody> | null = null;

/** A new registration must be visible immediately: drop the cached list. */
function invalidateListCache(): void {
  listCache = null;
}

/**
 * Build the list, retrying once after a short pause. Aiven flaps
 * transiently (EAI_AGAIN DNS errors seen 2026-10-03) and a retry a
 * couple of seconds later usually succeeds.
 */
async function buildListBodyResilient(): Promise<ListBody> {
  try {
    return await buildListBody();
  } catch {
    await new Promise((r) => setTimeout(r, 2500));
    return buildListBody();
  }
}

export async function buildListBody(): Promise<ListBody> {
  const pools = await listTrackedPools();
  // Backfill card images for pools whose imageUrl never reached the
  // registry (pre-Oct-2026 launches hit R2 CORS on the browser-side
  // metadata fetch). Server-side only, best-effort, never fails the list.
  // Skipped under test so API tests stay hermetic (no live RPC).
  if (process.env.NODE_ENV !== 'test') {
    await healMissingPoolImages(pools);
  }
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
  // Sequential on purpose: the shared pg pool is small (max 5) and the
  // history route's parallel reads were reverted for starving it. A list
  // rebuild is singleflight and cached, so the extra serial query costs
  // latency only on rebuild, never per request.
  const sparklines = await getSparklinesBatch(addresses);
  const batch: BatchReads = { states, prices24hAgo, volumes24h, sparklines };
  const summaries = pools.map((p) =>
    buildSummary(p, quoteUsdByMint.get(p.quoteMint) ?? null, batch),
  );
  return {
    network: SOLANA_NETWORK,
    /** True on devnet: USD figures are a mainnet reference, not real value. */
    usdReference: isUsdReferencePrice(),
    pools: summaries.filter((s): s is PoolSummary => s !== null),
  };
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  try {
    return await handleGetInner(req, res);
  } catch (e) {
    console.error('[api/pools] list build failed', e);
    // Degraded but honest: a stale list beats a bare 500. Only a cold
    // cache with no list at all gets a 503 with a retryable message.
    if (process.env.NODE_ENV !== 'test' && listCache) {
      const pagination = parsePoolsPagination(req.query ?? {});
      if (!pagination) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).send(listCache.json);
      }
      const sorted = sortPoolSummaries(listCache.body.pools, pagination.sort);
      const { pools, pagination: pageInfo } = paginatePools(sorted, pagination);
      return res.status(200).json({
        network: listCache.body.network,
        pools,
        pagination: {
          ...pageInfo,
          graduatedCount: listCache.body.pools.filter((p) => p.graduated).length,
        },
      });
    }
    return res
      .status(503)
      .json({ error: 'Pool list temporarily unavailable, please try again shortly' });
  }
}

async function handleGetInner(req: NextApiRequest, res: NextApiResponse) {
  // Opt-in pagination: ?limit=&cursor=&sort=. With none of these params
  // the full list is served exactly as before (backward compatible).
  const pagination = parsePoolsPagination(req.query ?? {});
  // Short-lived cache: the Discover page polls this endpoint every 5s per
  // client, so without a cache N clients = N full list builds per 5s.
  // 3s is well within the page's own 5s poll rhythm and the honest-stale
  // contract (state older than STALE_AFTER_MS is still labeled stale).
  // Skipped under test so tests stay deterministic.
  const skipCache = process.env.NODE_ENV === 'test';

  // Serve one list body, full or paginated, from a cached full build.
  // Paginated slices are small (<= POOLS_MAX_LIMIT pools) so they are
  // serialized per request; the unpaginated full list keeps the
  // pre-serialized fast path (stringify of a 5k-pool list costs ~50ms of
  // single-threaded CPU, so re-serializing per request caps throughput).
  const serveBody = (body: ListBody) => {
    if (!pagination) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(JSON.stringify(body));
    }
    const sorted = sortPoolSummaries(body.pools, pagination.sort);
    const { pools, pagination: pageInfo } = paginatePools(sorted, pagination);
    return res.status(200).json({
      network: body.network,
      pools,
      pagination: {
        ...pageInfo,
        graduatedCount: body.pools.filter((p) => p.graduated).length,
      },
    });
  };

  if (!skipCache) {
    const cacheBody = (body: ListBody) => {
      listCache = { at: Date.now(), body, json: JSON.stringify(body) };
    };
    const sendJson = (json: string) => {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(json);
    };
    // Serve from the cache entry: the pre-serialized full list, or a
    // fresh slice of the cached body for paginated requests.
    const serveCached = () => {
      if (!listCache) throw new Error('list cache unexpectedly empty');
      if (!pagination) return sendJson(listCache.json);
      return serveBody(listCache.body);
    };
    const now = Date.now();
    if (listCache && now - listCache.at < LIST_CACHE_TTL_MS) {
      return serveCached();
    }
    if (listRebuild) {
      // A rebuild is already running: share it instead of stampeding the
      // database. Serve the stale list immediately when we have one
      // (stale-while-revalidate); only a cold cache waits for the build.
      if (listCache) return serveCached();
      const body = await listRebuild;
      return serveBody(body);
    }
    if (listCache) {
      // Stale-while-revalidate: serve the stale list now, refresh in the
      // background. Failures keep serving stale; the next expiry retries.
      const rebuild = buildListBodyResilient();
      listRebuild = rebuild;
      rebuild.then(
        (body) => {
          cacheBody(body);
        },
        () => {
          /* keep serving stale; next expiry retries */
        },
      ).finally(() => {
        if (listRebuild === rebuild) listRebuild = null;
      });
      return serveCached();
    }
    // Cold cache: this request must wait for the first build.
    const rebuild = buildListBodyResilient();
    listRebuild = rebuild;
    try {
      const body = await rebuild;
      cacheBody(body);
      return serveBody(body);
    } finally {
      if (listRebuild === rebuild) listRebuild = null;
    }
  }
  return serveBody(await buildListBody());
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
  const message = buildRegistrationMessage(
    input.poolAddress,
    input.creator,
    input.timestamp,
    input.feeSplits,
    input.devBuyLamports,
    input.buybackBps || undefined,
    input.traderReward || undefined,
  );
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

  // 6. Transactional registry insert, then the fee split terms (fixed
  // forever once written). Splits go in after the pool row exists; a
  // splits failure does not roll back a pool that is real on chain, so
  // it is logged loudly instead of failing the registration.
  try {
    const { feeSplits, ...poolInput } = input;
    const entry = await registerPool({ ...poolInput, verified: verification.status === 'verified' });
    if (feeSplits && feeSplits.length > 0) {
      try {
        await insertFeeSplits(entry.poolAddress, feeSplits);
      } catch (e) {
        console.error('[registration] fee splits insert failed', entry.poolAddress, e);
      }
    }
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
