import { Keypair } from '@solana/web3.js';

/**
 * Client-side handout fetch for instant launch.
 *
 * At wizard start the app tries POST /api/vanity-mint for a pre-ground
 * "...curv" keypair. Any failure mode, 503 (pool dry), 429 (rate
 * limited), network error, malformed body, resolves to null and the
 * caller falls back to the local background grind. The handout path is
 * best-effort by design: a launch must never be blocked by the pool.
 *
 * The returned Keypair is handled exactly like the ephemeral mint
 * keypair the launch flow already used: browser memory only,
 * client-side partial signing, never sent to any server.
 */

export interface VanityHandout {
  keypair: Keypair;
  /** 'pool' = pre-ground handout, 'grind' = local background grind. */
  source: 'pool' | 'grind';
}

interface HandoutBody {
  publicKey?: unknown;
  secretKey?: unknown;
}

function parseHandoutBody(json: unknown): Keypair | null {
  if (!json || typeof json !== 'object') return null;
  const { publicKey, secretKey } = json as HandoutBody;
  if (typeof publicKey !== 'string' || typeof secretKey !== 'string') return null;
  try {
    const secret = Buffer.from(secretKey, 'base64');
    if (secret.length !== 64) return null;
    const kp = Keypair.fromSecretKey(secret);
    if (kp.publicKey.toBase58() !== publicKey) return null;
    return kp;
  } catch {
    return null;
  }
}

/**
 * Attempt one handout claim. Resolves to the keypair on 200, or null on
 * every other outcome (the caller must grind locally instead).
 */
export async function fetchVanityHandout(
  fetchFn: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<Keypair | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn('/api/vanity-mint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json: unknown = await res.json().catch((): unknown => null);
    return parseHandoutBody(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
