import { createHash, createHmac, randomBytes } from 'crypto';

/**
 * Twitch OAuth 2.0 (authorization code flow) for fee split recipient
 * verification.
 *
 * Flow: /api/auth/twitch/authorize redirects to Twitch, Twitch calls
 * back /api/auth/twitch/callback, we exchange the code, fetch the
 * verified username, and set a short lived signed cookie proving the
 * identity. The claim page then lets the recipient bind a wallet,
 * reusing the signature based binding flow.
 *
 * Twitch app registration is free: https://dev.twitch.tv/console
 * Register https://curvpad.fun/api/auth/twitch/callback as an OAuth
 * redirect URL.
 *
 * Required env: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET,
 * OAUTH_SESSION_SECRET (shared with Reddit).
 */

const TWITCH_AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_USERS_URL = 'https://api.twitch.tv/helix/users';

export interface TwitchUser {
  id: string;
  login: string;
  displayName: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newState(): string {
  return base64url(randomBytes(16));
}

function callbackUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://curvpad.fun';
  return `${base.replace(/\/$/, '')}/api/auth/twitch/callback`;
}

export function twitchConfigured(): boolean {
  return !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET && process.env.OAUTH_SESSION_SECRET);
}

export function buildTwitchAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.TWITCH_CLIENT_ID ?? '',
    redirect_uri: callbackUrl(),
    scope: '',
    state,
  });
  return `${TWITCH_AUTHORIZE_URL}?${params.toString()}`;
}

interface TwitchTokenResponse {
  access_token: string;
  token_type: string;
}

export async function exchangeTwitchCode(code: string): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: process.env.TWITCH_CLIENT_ID ?? '',
    client_secret: process.env.TWITCH_CLIENT_SECRET ?? '',
    redirect_uri: callbackUrl(),
  });
  let res: Response;
  try {
    res = await fetch(TWITCH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const j = (await res.json()) as Partial<TwitchTokenResponse>;
    if (typeof j.access_token !== 'string') return null;
    return j.access_token;
  } catch {
    return null;
  }
}

export async function fetchTwitchMe(accessToken: string): Promise<TwitchUser | null> {
  let res: Response;
  try {
    res = await fetch(TWITCH_USERS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': process.env.TWITCH_CLIENT_ID ?? '',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const j = (await res.json()) as { data?: Array<{ id?: unknown; login?: unknown; display_name?: unknown }> };
    const u = j.data?.[0];
    if (typeof u?.id !== 'string' || typeof u?.login !== 'string') return null;
    return { id: u.id, login: u.login, displayName: typeof u.display_name === 'string' ? u.display_name : u.login };
  } catch {
    return null;
  }
}

export interface OAuthIdentity {
  platform: 'twitch' | 'reddit';
  username: string;
  userId: string;
  poolAddress: string;
  entryIndex: number;
  issuedAt: number;
}

const SESSION_TTL_MS = 15 * 60 * 1000;

function sessionSecret(): string {
  return process.env.OAUTH_SESSION_SECRET ?? '';
}

export function signOAuthSession(s: OAuthIdentity): string {
  const payload = base64url(Buffer.from(JSON.stringify(s)));
  const sig = base64url(createHmac('sha256', sessionSecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyOAuthSession(token: string): OAuthIdentity | null {
  const secret = sessionSecret();
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = base64url(createHmac('sha256', secret).update(payload).digest());
  if (sig.length !== expected.length) return null;
  let ok = true;
  for (let i = 0; i < sig.length; i++) ok = ok && sig[i] === expected[i];
  if (!ok) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as OAuthIdentity;
    if ((s.platform !== 'twitch' && s.platform !== 'reddit') || typeof s.username !== 'string') return null;
    if (typeof s.poolAddress !== 'string' || !Number.isInteger(s.entryIndex)) return null;
    if (Date.now() - s.issuedAt > SESSION_TTL_MS) return null;
    return s;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function oauthSessionCookie(token: string): string {
  return `curv_oauth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearOAuthSessionCookie(): string {
  return 'curv_oauth=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
}

/** Short lived state cookie helpers shared by the authorize endpoints. */
export function oauthStateCookie(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`;
}

export function clearOAuthStateCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

/** Timing safe string compare for state validation. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let ok = true;
  for (let i = 0; i < a.length; i++) ok = ok && a[i] === b[i];
  return ok;
}

/** SHA256 hex, for logging-friendly state fingerprints. */
export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
