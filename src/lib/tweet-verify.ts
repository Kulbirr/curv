import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';

/**
 * Tweet verification for handle-only fee split recipients.
 *
 * Flow: the claim page shows the recipient a deterministic code for
 * their split entry. They post a public tweet from the named X handle
 * containing the code AND the Solana wallet that should receive their
 * share, paste the tweet URL, and the server verifies through X's own
 * free embed infrastructure (no API key, no credits):
 *
 *   1. cdn.syndication.twimg.com/tweet-result (X first-party, JSON)
 *   2. publish.twitter.com/oembed (X first-party, fallback)
 *   3. api.fxtwitter.com (community, fallback)
 *
 * The author check is the real security: X asserts authorship
 * server-side, so an attacker cannot forge screen_name. The code binds
 * the tweet to this specific claim (replaying someone else's tweet
 * fails the author check; reusing an old tweet of your own fails the
 * code check). The wallet in the tweet binds the payout destination:
 * because only the handle owner can author the tweet, nobody can
 * front-run the binding with a copied link, the copied link names the
 * owner's wallet, not the attacker's. No wallet signature is needed;
 * X authorship is the authentication.
 */

const CODE_PREFIX = 'CURV';

/**
 * Deterministic verification code for a split entry. Unique per
 * (pool, entry). Guessable by design: the author check is what stops
 * impersonation, the code only binds a tweet to this claim.
 */
export function tweetCodeFor(poolAddress: string, entryIndex: number): string {
  const hash = createHash('sha256')
    .update(`${poolAddress}:${entryIndex}:curv-tweet-verify`)
    .digest();
  // 30 bits -> 6 base32 chars, unambiguous alphabet (no 0/O, 1/I)
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let n = hash.readUInt32BE(0) & 0x3fffffff;
  let out = '';
  for (let i = 0; i < 6; i++) {
    out = alphabet[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return `${CODE_PREFIX}-${out}`;
}

/** Extract a numeric tweet/status ID from an x.com or twitter.com URL. */
export function extractTweetId(url: string): string | null {
  const m = String(url || '')
    .trim()
    .match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d{5,25})/i);
  return m ? m[1] : null;
}

export interface VerifiedTweet {
  /** X handle of the tweet author, without @ */
  authorHandle: string;
  /** Full tweet text */
  text: string;
  /** Tweet ID that was verified */
  tweetId: string;
  /** Which source in the chain answered */
  source: 'syndication' | 'oembed' | 'fxtwitter';
}

async function fetchJson(url: string, timeoutMs = 12_000): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CurvFeeClaim/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

async function trySyndication(tweetId: string): Promise<VerifiedTweet | null> {
  const j = await fetchJson(
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0&lang=en`
  );
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const user = o.user as Record<string, unknown> | undefined;
  const screenName = user?.screen_name;
  const text = o.text;
  const idStr = o.id_str;
  if (typeof screenName !== 'string' || typeof text !== 'string') return null;
  if (typeof idStr === 'string' && idStr !== tweetId) return null;
  return { authorHandle: screenName, text, tweetId, source: 'syndication' };
}

async function tryOembed(tweetId: string): Promise<VerifiedTweet | null> {
  const j = await fetchJson(
    `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://x.com/i/status/${tweetId}`)}`
  );
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const authorUrl = o.author_url;
  const html = o.html;
  if (typeof authorUrl !== 'string' || typeof html !== 'string') return null;
  const handleMatch = String(authorUrl).match(/(?:x\.com|twitter\.com)\/(\w{1,15})\/?$/i);
  if (!handleMatch) return null;
  // Tweet text lives in the first <p> block of the embed HTML.
  const textMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const text = textMatch
    ? textMatch[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
    : '';
  return { authorHandle: handleMatch[1], text, tweetId, source: 'oembed' };
}

async function tryFxtwitter(tweetId: string): Promise<VerifiedTweet | null> {
  const j = await fetchJson(`https://api.fxtwitter.com/i/status/${tweetId}`);
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (o.code !== 200) return null;
  const tweet = o.tweet as Record<string, unknown> | undefined;
  const author = tweet?.author as Record<string, unknown> | undefined;
  const screenName = author?.screen_name;
  const text = tweet?.text;
  if (typeof screenName !== 'string' || typeof text !== 'string') return null;
  return { authorHandle: screenName, text, tweetId, source: 'fxtwitter' };
}

/**
 * Fetch a tweet and return its verified author and text, trying the
 * free sources in order. Returns null when none of them can resolve
 * the tweet (deleted, protected, or network failure).
 */
export async function fetchVerifiedTweet(tweetId: string): Promise<VerifiedTweet | null> {
  return (
    (await trySyndication(tweetId)) ??
    (await tryOembed(tweetId)) ??
    (await tryFxtwitter(tweetId))
  );
}

export interface TweetCheck {
  ok: boolean;
  /** User-safe reason when the check fails */
  reason?: string;
  tweet?: VerifiedTweet;
  /** Solana wallet named in the tweet, set when ok */
  wallet?: string;
}

/**
 * Extract the single Solana wallet address named in a tweet.
 * Returns the address when the text contains exactly one valid
 * base58 public key, otherwise null. Requiring exactly one keeps
 * the binding unambiguous: a tweet naming two wallets cannot say
 * which one should be paid.
 */
export function extractWalletFromText(text: string): string | null {
  const candidates = String(text || '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
  const valid: string[] = [];
  for (const c of candidates) {
    try {
      valid.push(new PublicKey(c).toBase58());
    } catch {
      // Not a real public key, ignore.
    }
  }
  const unique = [...new Set(valid)];
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Full verification: the tweet must be authored by the expected
 * handle, contain the expected code, and name exactly one Solana
 * wallet that will receive the share. The wallet comes from the
 * tweet itself, so no wallet signature is required.
 */
export async function verifyTweetForEntry(
  tweetUrl: string,
  expectedHandle: string,
  expectedCode: string
): Promise<TweetCheck> {
  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) {
    return { ok: false, reason: 'That does not look like an X post link.' };
  }
  const tweet = await fetchVerifiedTweet(tweetId);
  if (!tweet) {
    return {
      ok: false,
      reason: 'Could not read that post. It must be public, not deleted, and from a public account.',
    };
  }
  if (tweet.authorHandle.toLowerCase() !== expectedHandle.toLowerCase()) {
    return {
      ok: false,
      reason: `That post is from @${tweet.authorHandle}, but this share is reserved for @${expectedHandle}.`,
    };
  }
  if (!tweet.text.includes(expectedCode)) {
    return {
      ok: false,
      reason: `That post does not contain the code ${expectedCode}. Post a new public post with the code and try again.`,
    };
  }
  const wallet = extractWalletFromText(tweet.text);
  if (!wallet) {
    return {
      ok: false,
      reason:
        'That post does not name exactly one Solana wallet. Include the wallet that should receive your share in the same post as the code.',
    };
  }
  return { ok: true, tweet, wallet };
}

/** Suggested tweet text, pre-filled through x.com/intent/post. */
export function tweetIntentUrl(code: string): string {
  const text =
    `Claiming my Curv creator fee share. Verification code: ${code}\n` +
    `My wallet: PASTE_YOUR_SOLANA_WALLET_HERE`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
