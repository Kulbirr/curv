import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { fetchVanityHandout } from './vanity-handout';

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function errResponse(status: number) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

describe('fetchVanityHandout', () => {
  it('returns the keypair on a valid 200 handout', async () => {
    const kp = Keypair.generate();
    const fetchFn = (async () =>
      okResponse({
        publicKey: kp.publicKey.toBase58(),
        secretKey: Buffer.from(kp.secretKey).toString('base64'),
      })) as unknown as typeof fetch;
    const got = await fetchVanityHandout(fetchFn);
    expect(got?.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('returns null on 503 (pool dry) — caller grinds locally', async () => {
    const fetchFn = (async () => errResponse(503)) as unknown as typeof fetch;
    expect(await fetchVanityHandout(fetchFn)).toBeNull();
  });

  it('returns null on 429 (rate limited)', async () => {
    const fetchFn = (async () => errResponse(429)) as unknown as typeof fetch;
    expect(await fetchVanityHandout(fetchFn)).toBeNull();
  });

  it('returns null on network failure', async () => {
    const fetchFn = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await fetchVanityHandout(fetchFn)).toBeNull();
  });

  it('rejects a handout whose secret does not match the public key', async () => {
    const other = Keypair.generate();
    const fetchFn = (async () =>
      okResponse({
        publicKey: Keypair.generate().publicKey.toBase58(),
        secretKey: Buffer.from(other.secretKey).toString('base64'),
      })) as unknown as typeof fetch;
    expect(await fetchVanityHandout(fetchFn)).toBeNull();
  });

  it('rejects malformed bodies', async () => {
    for (const body of [null, {}, { publicKey: 'x' }, { secretKey: 'eA==' }, 'nope']) {
      const fetchFn = (async () => okResponse(body)) as unknown as typeof fetch;
      expect(await fetchVanityHandout(fetchFn)).toBeNull();
    }
  });

  it('sends a POST to /api/vanity-mint', async () => {
    let seenUrl = '';
    let seenMethod = '';
    const fetchFn = (async (url: unknown, init: unknown) => {
      seenUrl = String(url);
      seenMethod = (init as { method: string }).method;
      return errResponse(503);
    }) as unknown as typeof fetch;
    await fetchVanityHandout(fetchFn);
    expect(seenUrl).toBe('/api/vanity-mint');
    expect(seenMethod).toBe('POST');
  });
});
