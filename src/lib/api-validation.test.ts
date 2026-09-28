import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { randomBytes } from 'crypto';
import {
  getClientIp,
  parseAddress,
  parseSignature,
  validateRegistrationBody,
} from './api-validation';
import { DEVNET_USDC_MINT, MAINNET_USDC_MINT, SOL_MINT } from './quote-assets';
import { randomAddress } from '@/test-support/db';

function sig64(): string {
  return bs58.encode(randomBytes(64));
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    poolAddress: randomAddress(),
    configAddress: randomAddress(),
    baseMint: randomAddress(),
    quoteMint: SOL_MINT,
    creator: randomAddress(),
    baseSymbol: 'TEST',
    baseName: 'Test Token',
    quoteSymbol: 'SOL',
    timestamp: Date.now(),
    signature: sig64(),
    ...overrides,
  };
}

describe('parseAddress', () => {
  it('accepts a valid base58 address and normalizes it', async () => {
    const a = randomAddress();
    expect(parseAddress(a)).toBe(a);
  });

  it('rejects non-strings, empties, overlong and malformed input', async () => {
    expect(parseAddress('')).toBeNull();
    expect(parseAddress(null)).toBeNull();
    expect(parseAddress(undefined)).toBeNull();
    expect(parseAddress(123)).toBeNull();
    expect(parseAddress('x'.repeat(65))).toBeNull();
    expect(parseAddress('not a base58 address!!!')).toBeNull();
  });
});

describe('parseSignature', () => {
  it('accepts a 64-byte base58 signature', async () => {
    const s = sig64();
    expect(parseSignature(s)).toBe(s);
  });

  it('rejects wrong-length or undecodable signatures', async () => {
    expect(parseSignature(bs58.encode(randomBytes(32)))).toBeNull(); // 32 bytes
    expect(parseSignature(bs58.encode(randomBytes(65)))).toBeNull(); // 65 bytes
    expect(parseSignature('!!!')).toBeNull();
    expect(parseSignature('')).toBeNull();
    expect(parseSignature(null)).toBeNull();
    expect(parseSignature('x'.repeat(200))).toBeNull(); // over length cap
  });
});

describe('validateRegistrationBody', () => {
  it('accepts a valid body and drops unknown fields', async () => {
    const r = validateRegistrationBody({ ...validBody(), evil: 'injection', admin: true });
    expect(r.ok).toBe(true);
    if (r.ok === false) throw new Error('unreachable');
    expect((r.value as unknown as Record<string, unknown>)['evil']).toBeUndefined();
    expect((r.value as unknown as Record<string, unknown>)['admin']).toBeUndefined();
    expect(r.value.baseSymbol).toBe('TEST');
  });

  it('normalizes symbols to uppercase and trims text', async () => {
    const r = validateRegistrationBody(validBody({ baseSymbol: ' test ', quoteSymbol: 'sol' }));
    expect(r.ok).toBe(true);
    if (r.ok === false) throw new Error('unreachable');
    expect(r.value.baseSymbol).toBe('TEST');
    expect(r.value.quoteSymbol).toBe('SOL');
  });

  it('names each malformed address field', async () => {
    for (const field of ['poolAddress', 'configAddress', 'baseMint', 'quoteMint', 'creator']) {
      const r = validateRegistrationBody(validBody({ [field]: 'bad' }));
      expect(r.ok).toBe(false);
      if (r.ok === true) throw new Error('unreachable');
      expect(r.error).toContain(field);
    }
  });

  it('rejects a non-JSON body', async () => {
    const r = validateRegistrationBody('hello');
    expect(r.ok).toBe(false);
    if (r.ok === true) throw new Error('unreachable');
    expect(r.error).toContain('JSON');
  });

  it('rejects identical base and quote mints', async () => {
    const m = randomAddress();
    const r = validateRegistrationBody(validBody({ baseMint: m, quoteMint: m }));
    expect(r.ok).toBe(false);
    if (r.ok === true) throw new Error('unreachable');
    expect(r.error).toContain('must differ');
  });

  it('rejects a mainnet USDC quote on this devnet deployment', async () => {
    const r = validateRegistrationBody(validBody({ quoteMint: MAINNET_USDC_MINT }));
    expect(r.ok).toBe(false);
    if (r.ok === true) throw new Error('unreachable');
    expect(r.error).toContain('different network');
  });

  it('accepts the devnet USDC mint as quote', async () => {
    const r = validateRegistrationBody(validBody({ quoteMint: DEVNET_USDC_MINT }));
    expect(r.ok).toBe(true);
  });

  it('requires symbol, name and a numeric timestamp', async () => {
    expect(validateRegistrationBody(validBody({ baseSymbol: '' })).ok).toBe(false);
    expect(validateRegistrationBody(validBody({ baseSymbol: 'x'.repeat(13) })).ok).toBe(false);
    expect(validateRegistrationBody(validBody({ baseName: '' })).ok).toBe(false);
    expect(validateRegistrationBody(validBody({ timestamp: 'yesterday' })).ok).toBe(false);
    expect(validateRegistrationBody(validBody({ signature: 'short' })).ok).toBe(false);
  });

  it('bounds launchedAt: negative or far-future timestamps rejected', async () => {
    expect(validateRegistrationBody(validBody({ launchedAt: -1 })).ok).toBe(false);
    expect(validateRegistrationBody(validBody({ launchedAt: Date.now() + 600_001 })).ok).toBe(false);
    const ok = validateRegistrationBody(validBody({ launchedAt: Date.now() - 1000 }));
    expect(ok.ok).toBe(true);
    if (ok.ok === false) throw new Error('unreachable');
    expect(typeof ok.value.launchedAt).toBe('number');
  });

  it('rejects overlong optional text with a clear error', async () => {
    const r = validateRegistrationBody(validBody({ description: 'x'.repeat(501) }));
    expect(r.ok).toBe(false);
    if (r.ok === true) throw new Error('unreachable');
    expect(r.error).toContain('too long');
  });

  it('rejects non-http image urls', async () => {
    const r = validateRegistrationBody(validBody({ imageUrl: 'ftp://x/y.png' }));
    expect(r.ok).toBe(false);
    if (r.ok === true) throw new Error('unreachable');
    expect(r.error).toContain('http(s)');
  });

  it('accepts valid optional fields', async () => {
    const r = validateRegistrationBody(
      validBody({
        description: 'A fine token',
        imageUrl: 'https://example.com/i.png',
        website: 'https://example.com',
        twitter: '@test',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok === false) throw new Error('unreachable');
    expect(r.value.description).toBe('A fine token');
    expect(r.value.website).toBe('https://example.com');
  });

  it('treats empty optional strings as absent', async () => {
    const r = validateRegistrationBody(validBody({ description: '   ', website: '' }));
    expect(r.ok).toBe(true);
    if (r.ok === false) throw new Error('unreachable');
    expect(r.value.description).toBeUndefined();
    expect(r.value.website).toBeUndefined();
  });
});

describe('getClientIp', () => {
  const base = { socket: { remoteAddress: '9.9.9.9' }, headers: {} };
  it('prefers x-forwarded-for, first entry only', async () => {
    expect(
      getClientIp({ ...base, headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } } as never),
    ).toBe('1.1.1.1');
  });
  it('handles the array form of the header', async () => {
    expect(
      getClientIp({ ...base, headers: { 'x-forwarded-for': ['3.3.3.3'] } } as never),
    ).toBe('3.3.3.3');
  });
  it('falls back to the socket address, then unknown', async () => {
    expect(getClientIp(base as never)).toBe('9.9.9.9');
    expect(getClientIp({ socket: {}, headers: {} } as never)).toBe('unknown');
  });
});
