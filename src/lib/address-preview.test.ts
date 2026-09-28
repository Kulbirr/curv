import { describe, expect, it, vi } from 'vitest';
import { parsePreviewAddress, previewAddress } from './address-preview';

function mockFetch(status: number): typeof fetch {
  return vi.fn().mockResolvedValue({ status, ok: status >= 200 && status < 300 }) as unknown as typeof fetch;
}

describe('parsePreviewAddress', () => {
  it('accepts a valid base58 address and trims whitespace', () => {
    const addr = 'AcdyunXSN1dLgS8tPCRPLTauZxmi84mLLQvi2xhKQoP4';
    expect(parsePreviewAddress(`  ${addr}  `)).toBe(addr);
  });

  it('rejects non-addresses: too short, bad chars, empty', () => {
    expect(parsePreviewAddress('nope')).toBeNull();
    expect(parsePreviewAddress('')).toBeNull();
    expect(parsePreviewAddress('0'.repeat(44))).toBeNull(); // 0 is not base58
    expect(parsePreviewAddress('O'.repeat(44))).toBeNull(); // O is not base58
    expect(parsePreviewAddress('I'.repeat(44))).toBeNull(); // I is not base58
    expect(parsePreviewAddress('l'.repeat(44))).toBeNull(); // l is not base58
  });
});

describe('previewAddress', () => {
  const addr = 'AcdyunXSN1dLgS8tPCRPLTauZxmi84mLLQvi2xhKQoP4';

  it('returns invalid without hitting the network', async () => {
    const fetchFn = mockFetch(200);
    expect(await previewAddress('nope', fetchFn)).toEqual({ kind: 'invalid' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns pool when the registry tracks the address', async () => {
    const fetchFn = mockFetch(200);
    expect(await previewAddress(addr, fetchFn)).toEqual({ kind: 'pool', poolAddress: addr });
    expect(fetchFn).toHaveBeenCalledWith(`/api/pools/${addr}/state`);
  });

  it('HONESTY: returns unknown on 404 — a valid address that is not a Curv pool', async () => {
    expect(await previewAddress(addr, mockFetch(404))).toEqual({ kind: 'unknown', address: addr });
  });

  it('HONESTY: returns error (not unknown) when the check itself fails', async () => {
    expect(await previewAddress(addr, mockFetch(500))).toEqual({ kind: 'error' });
    const failing = vi.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch;
    expect(await previewAddress(addr, failing)).toEqual({ kind: 'error' });
  });
});
