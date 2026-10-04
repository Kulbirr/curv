import { describe, expect, it } from 'vitest';
import {
  parseProxyRequest,
  resolveProxyUpstream,
  resolveProxyUpstreams,
  RPC_PROXY_ALLOWED_METHODS,
  RPC_PROXY_TIMEOUT_MS,
} from './rpc-proxy';

describe('rpc-proxy request validation', () => {
  it('accepts an allowlisted read method', () => {
    const r = parseProxyRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: ['11111111111111111111111111111111', { encoding: 'jsonParsed' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.method).toBe('getAccountInfo');
  });

  it('accepts sendTransaction (trades send through the app connection)', () => {
    expect(RPC_PROXY_ALLOWED_METHODS.has('sendTransaction')).toBe(true);
  });

  it('accepts getSlot and getBlockTime (the DBC SDK needs both for swap quotes)', () => {
    expect(RPC_PROXY_ALLOWED_METHODS.has('getSlot')).toBe(true);
    expect(RPC_PROXY_ALLOWED_METHODS.has('getBlockTime')).toBe(true);
  });

  it('rejects non-allowlisted methods', () => {
    const r = parseProxyRequest({ jsonrpc: '2.0', id: 1, method: 'getInflationReward' });
    expect(r.ok).toBe(false);
  });

  it('rejects batch arrays', () => {
    const r = parseProxyRequest([{ jsonrpc: '2.0', id: 1, method: 'getBalance' }]);
    expect(r.ok).toBe(false);
  });

  it('rejects wrong jsonrpc version and missing id', () => {
    expect(parseProxyRequest({ jsonrpc: '1.0', id: 1, method: 'getBalance' }).ok).toBe(false);
    expect(parseProxyRequest({ jsonrpc: '2.0', method: 'getBalance' }).ok).toBe(false);
  });

  it('rejects non-object bodies', () => {
    expect(parseProxyRequest(null).ok).toBe(false);
    expect(parseProxyRequest('getBalance').ok).toBe(false);
  });

  it('keeps the timeout budget at 8s', () => {
    expect(RPC_PROXY_TIMEOUT_MS).toBe(8000);
  });
});

describe('rpc-proxy upstream resolution', () => {
  it('prefers RPC_PROXY_UPSTREAM_URL (the Alchemy slot) over the Helius lane', () => {
    process.env.RPC_PROXY_UPSTREAM_URL = 'https://example.invalid/alchemy';
    process.env.SOLANA_RPC_URL = 'https://example.invalid/helius';
    expect(resolveProxyUpstream()).toBe('https://example.invalid/alchemy');
    delete process.env.RPC_PROXY_UPSTREAM_URL;
    expect(resolveProxyUpstream()).toBe('https://example.invalid/helius');
    delete process.env.SOLANA_RPC_URL;
  });

  it('lists the Alchemy lane after Helius in the tiered upstreams', () => {
    process.env.SOLANA_RPC_URL = 'https://example.invalid/helius';
    process.env.ALCHEMY_RPC_URL = 'https://example.invalid/alchemy';
    expect(resolveProxyUpstream()).toBe('https://example.invalid/helius');
    expect(resolveProxyUpstreams()).toEqual([
      'https://example.invalid/helius',
      'https://example.invalid/alchemy',
    ]);
    delete process.env.ALCHEMY_RPC_URL;
    expect(resolveProxyUpstreams()).toEqual(['https://example.invalid/helius']);
    delete process.env.SOLANA_RPC_URL;
    expect(resolveProxyUpstreams()).toEqual([]);
    expect(resolveProxyUpstream()).toBe('');
  });
});
