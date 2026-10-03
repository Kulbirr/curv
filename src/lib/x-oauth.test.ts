import { describe, expect, it, vi } from 'vitest';

describe('x-oauth sessions', () => {
  it('signs and verifies a session round-trip', async () => {
    process.env.X_SESSION_SECRET = 'test-secret-for-unit-tests';
    const { signXSession, verifyXSession } = await import('./x-oauth');
    const token = signXSession({ xUserId: '12345', xUsername: 'alice', issuedAt: Date.now() });
    const back = verifyXSession(token);
    expect(back?.xUserId).toBe('12345');
    expect(back?.xUsername).toBe('alice');
  });

  it('rejects tampered tokens', async () => {
    process.env.X_SESSION_SECRET = 'test-secret-for-unit-tests';
    const { signXSession, verifyXSession } = await import('./x-oauth');
    const token = signXSession({ xUserId: '12345', xUsername: 'alice', issuedAt: Date.now() });
    const [payload] = token.split('.');
    expect(verifyXSession(`${payload}.tampered`)).toBeNull();
    expect(verifyXSession('garbage')).toBeNull();
  });

  it('rejects expired sessions', async () => {
    process.env.X_SESSION_SECRET = 'test-secret-for-unit-tests';
    const { signXSession, verifyXSession } = await import('./x-oauth');
    const token = signXSession({
      xUserId: '12345',
      xUsername: 'alice',
      issuedAt: Date.now() - 31 * 24 * 3600_000,
    });
    expect(verifyXSession(token)).toBeNull();
  });

  it('builds a PKCE challenge from a verifier', async () => {
    const { newCodeVerifier, codeChallenge } = await import('./x-oauth');
    const v = newCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    const c = codeChallenge(v);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c).not.toBe(v);
  });
});
