import { PublicKey } from '@solana/web3.js';
import { getConnection } from './solana';
import { updatePoolImage } from './db/pools';
import type { TrackedPool } from './db/pools';

/**
 * Self-heal for pool card images.
 *
 * In Oct 2026 a launch's image reached R2 and the on-chain metadata but
 * never reached the registry: the launch page re-fetched the metadata
 * JSON from the browser to extract the image URL, and the R2 public
 * bucket sends no CORS headers, so the fetch died silently and the pool
 * was registered with image_url NULL. New launches now take the image
 * URL straight from the upload response; this module backfills rows
 * that slipped through before that fix.
 *
 * It runs server-side (no CORS involved): derive the Metaplex metadata
 * PDA for the pool's base mint, read the metadata URI off chain, fetch
 * the JSON, and store a valid https image URL. Best-effort only, it
 * never throws: a failed heal just leaves the letter avatar in place.
 */

/** Metaplex Token Metadata program (verified against the DBC SDK bundle). */
const TOKEN_METADATA_PROGRAM = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

const FETCH_TIMEOUT_MS = 8000;

function metadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM,
  );
  return pda;
}

/** Pull the metadata URI out of a raw Metaplex metadata account. */
function extractMetadataUri(data: Buffer): string | null {
  // The uri is a length-prefixed UTF-8 string, null-padded to 200 bytes.
  // The account's only URL is the metadata URI.
  const m = /https:\/\/[^\x00"'\s]{8,500}/.exec(data.toString('latin1'));
  return m ? m[0] : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try to heal one pool's missing image. Returns the healed https image
 * URL, or null when there is nothing to heal or the heal failed. The
 * DB row is updated as a side effect (only when it currently has no
 * image); the caller mirrors the return value into its in-memory row.
 */
export async function healPoolImage(pool: TrackedPool): Promise<string | null> {
  try {
    if (pool.imageUrl) return null;
    let mint: PublicKey;
    try {
      mint = new PublicKey(pool.baseMint);
    } catch {
      return null;
    }
    const connection = getConnection();
    const info = await connection.getAccountInfo(metadataPda(mint));
    if (!info?.data) return null;
    const uri = extractMetadataUri(Buffer.from(info.data));
    if (!uri) return null;
    const meta = await fetchJson(uri);
    const image =
      meta && typeof meta === 'object'
        ? (meta as Record<string, unknown>).image
        : null;
    if (typeof image !== 'string' || !image.startsWith('https://')) return null;
    const updated = await updatePoolImage(pool.poolAddress, image);
    return updated ? image : null;
  } catch {
    return null;
  }
}

/**
 * Heal every pool in the list that is missing its card image, mirroring
 * healed URLs into the in-memory rows so the same response carries the
 * image. Never throws; intended to be awaited near the top of the pools
 * list builder.
 */
export async function healMissingPoolImages(
  pools: TrackedPool[],
): Promise<void> {
  const missing = pools.filter((p) => !p.imageUrl);
  if (missing.length === 0) return;
  const healed = await Promise.all(missing.map((p) => healPoolImage(p)));
  healed.forEach((image, i) => {
    if (image) missing[i].imageUrl = image;
  });
}
