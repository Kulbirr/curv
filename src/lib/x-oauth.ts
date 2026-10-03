import { createHash, createHmac, randomBytes } from 'crypto';

/**
 * Login with X (OAuth 2.0 with PKCE).
 *
 * Flow: /api/auth/x/login redirects to X, X calls back
 * /api/auth/x/callback, we exchange the code, fetch the verified
 * user (numeric ID + username), and set a signed httpOnly session
 * cookie. The numeric X user ID is the stable identity key: handles
 * can be renamed, IDs cannot.
 *
 * Required env: X_CLIENT_ID, X_CLIENT_SECRET, X_SESSION_SECRET.
 * Register https://<app>/api/auth/x/callback in the X developer app.
 */

const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const X_ME_URL = 'https://api.x.com/2/users/me?user.fields=id,username';

export interface XUser {
  id: string;
  username: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function codeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function newState(): string {
  return base64url(randomBytes(16));
}

function callbackUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://curvpad.fun';
  return `${base.replace(/\/$/, '')}/api/auth/x/callback`;
}

export function xConfigured(): boolean {
  return !!(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET && process.env.X_SESSION_SECRET);
}

export function buildAuthorizeUrl(state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.X_CLIENT_ID ?? '',
    redirect_uri: callbackUrl(),
    scope: 'users.read offline.access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${X_AUTHORIZE_URL}?${params.toString()}`;
}

interface XTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function exchangeCode(code: string, verifier: string): Promise<XTokenResponse | null> {
  const clientId = process.env.X_CLIENT_ID ?? '';
  const clientSecret = process.env.X_CLIENT_SECRET ?? '';
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl(),
    code_verifier: verifier,
  });
  let res: Response;
  try {
    res = await fetch(X_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const j = (await res.json()) as Partial<XTokenResponse>;
    if (typeof j.access_token !== 'string') return null;
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in ?? 7200 };
  } catch {
    return null;
  }
}

export async function fetchXMe(accessToken: string): Promise<XUser | null> {
  // X API is flaky; retry once on network errors or 5xx before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(X_ME_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      console.error(`[x-oauth] fetchXMe network error (attempt ${attempt + 1}):`, e instanceof Error ? e.message : e);
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return null;
    }
    if (!res.ok) {
      console.error(`[x-oauth] fetchXMe HTTP ${res.status} (attempt ${attempt + 1})`);
      // Retry on 5xx or 429, not on 4xx (bad token, bad scope).
      if (attempt === 0 && (res.status >= 500 || res.status === 429)) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return null;
    }
    try {
      const j = (await res.json()) as { data?: { id?: unknown; username?: unknown } };
      const id = j.data?.id;
      const username = j.data?.username;
      if (typeof id !== 'string' || typeof username !== 'string') {
        console.error('[x-oauth] fetchXMe malformed response:', JSON.stringify(j).slice(0, 200));
        return null;
      }
      return { id, username };
    } catch (e) {
      console.error('[x-oauth] fetchXMe JSON parse error:', e instanceof Error ? e.message : e);
      return null;
    }
  }
  return null;
}

export interface XSession {
  xUserId: string;
  xUsername: string;
  issuedAt: number;
}

const SESSION_TTL_MS = 30 * 24 * 3600_000;

function sessionSecret(): string {
  return process.env.X_SESSION_SECRET ?? '';
}

/** Signed session token: base64url(payload).base64url(hmac). */
export function signXSession(s: XSession): string {
  const payload = base64url(Buffer.from(JSON.stringify(s)));
  const sig = base64url(createHmac('sha256', sessionSecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyXSession(token: string): XSession | null {
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
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as XSession;
    if (typeof s.xUserId !== 'string' || typeof s.xUsername !== 'string') return null;
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

export function sessionCookie(token: string): string {
  return `x_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookie(): string {
  return 'x_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
}
