/**
 * Reddit OAuth 2.0 (authorization code flow) for fee split recipient
 * verification.
 *
 * Same pattern as Twitch: /api/auth/reddit/authorize redirects to
 * Reddit, Reddit calls back /api/auth/reddit/callback, we exchange
 * the code, fetch the verified username, and set a short lived signed
 * cookie proving the identity.
 *
 * Reddit app registration is free: https://www.reddit.com/prefs/apps
 * Create a "web app", register
 * https://curvpad.fun/api/auth/reddit/callback as the redirect URI.
 * Reddit requires a unique User-Agent header on every API call.
 *
 * Required env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET,
 * OAUTH_SESSION_SECRET (shared with Twitch).
 *
 * Pricing note: Reddit's free OAuth tier (100 queries/min) excludes
 * commercial use. Our verification volume is a handful of calls per
 * claim; if Reddit ever enforces, the paid tier (~$0.24 per 1,000
 * calls) is the fallback.
 */

const REDDIT_AUTHORIZE_URL = 'https://www.reddit.com/api/v1/authorize';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_ME_URL = 'https://oauth.reddit.com/api/v1/me';

const USER_AGENT = 'curvpad-fee-verification/1.0 by Curv';

export interface RedditUser {
  id: string;
  name: string;
}

function callbackUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://curvpad.fun';
  return `${base.replace(/\/$/, '')}/api/auth/reddit/callback`;
}

export function redditConfigured(): boolean {
  return !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET && process.env.OAUTH_SESSION_SECRET);
}

export function buildRedditAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.REDDIT_CLIENT_ID ?? '',
    redirect_uri: callbackUrl(),
    scope: 'identity',
    state,
    duration: 'temporary',
  });
  return `${REDDIT_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeRedditCode(code: string): Promise<string | null> {
  const clientId = process.env.REDDIT_CLIENT_ID ?? '';
  const clientSecret = process.env.REDDIT_CLIENT_SECRET ?? '';
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl(),
  });
  let res: Response;
  try {
    res = await fetch(REDDIT_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const j = (await res.json()) as { access_token?: unknown };
    if (typeof j.access_token !== 'string') return null;
    return j.access_token;
  } catch {
    return null;
  }
}

export async function fetchRedditMe(accessToken: string): Promise<RedditUser | null> {
  let res: Response;
  try {
    res = await fetch(REDDIT_ME_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const j = (await res.json()) as { id?: unknown; name?: unknown };
    if (typeof j.id !== 'string' || typeof j.name !== 'string') return null;
    return { id: j.id, name: j.name };
  } catch {
    return null;
  }
}
