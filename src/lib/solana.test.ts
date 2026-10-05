import { afterEach, describe, expect, it, vi } from 'vitest';

describe('solana connection setup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadSolana(env: Record<string, string | undefined>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) vi.stubEnv(k, '');
      else vi.stubEnv(k, v);
    }
    return import('./solana');
  }

  it('defaults to devnet', async () => {
    const m = await loadSolana({});
    expect(m.SOLANA_NETWORK).toBe('devnet');
    expect(m.isDevnet()).toBe(true);
  });

  it('recognizes mainnet-beta (and the bare "mainnet" alias)', async () => {
    expect((await loadSolana({ NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta' })).isDevnet()).toBe(
      false,
    );
    expect((await loadSolana({ NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet' })).SOLANA_NETWORK).toBe(
      'mainnet-beta',
    );
    expect(
      (await loadSolana({ NEXT_PUBLIC_SOLANA_NETWORK: 'MAINNET-BETA' })).SOLANA_NETWORK,
    ).toBe('mainnet-beta');
  });

  it('treats unknown network values as devnet (fail closed)', async () => {
    const m = await loadSolana({ NEXT_PUBLIC_SOLANA_NETWORK: 'testnet-xyz' });
    expect(m.SOLANA_NETWORK).toBe('devnet');
    expect(m.isDevnet()).toBe(true);
  });

  it('getConnection returns a REST-only confirmed singleton', async () => {
    const m = await loadSolana({});
    const a = m.getConnection();
    const b = m.getConnection();
    expect(a).toBe(b);
    expect(a.rpcEndpoint).toBe(m.SOLANA_RPC_URL);
    expect(a.commitment).toBe('confirmed');
  });

  it('prefers a private server-side RPC URL and never leaks it to the client bundle', async () => {
    const m = await loadSolana({ SOLANA_RPC_URL: 'https://private.example/rpc?key=secret' });
    expect(m.SOLANA_RPC_URL).toBe('https://private.example/rpc?key=secret');
    expect(m.getConnection().rpcEndpoint).toBe('https://private.example/rpc?key=secret');
  });

  it('getDbcClient is a singleton bound to the shared connection', async () => {
    const m = await loadSolana({});
    expect(m.getDbcClient()).toBe(m.getDbcClient());
  });

  it('enforces a per-RPC-call timeout budget', async () => {
    const m = await import('./solana');
    expect(m.RPC_TIMEOUT_MS).toBe(8_000);
  });

  it('falls back to the public endpoint when the primary RPC is unreachable', async () => {
    const m = await loadSolana({ SOLANA_RPC_URL: 'https://primary.example/rpc?key=secret' });
    const attempted: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: unknown) => {
        attempted.push(String(input));
        if (String(input).startsWith('https://primary.example')) {
          throw new Error('primary down');
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'test-id', result: 123456 }), {
          status: 200,
        });
      },
    );
    const slot = await m.getConnection().getSlot();
    expect(slot).toBe(123456);
    expect(attempted[0]).toContain('primary.example');
    const fallbackAttempt = attempted[attempted.length - 1];
    expect(fallbackAttempt).toBe(m.SOLANA_RPC_FALLBACK_URL);
    expect(fallbackAttempt).not.toContain('secret');
    expect(m.getRpcStatus().lastFallbackAt).toEqual(expect.any(Number));
  });

  it('falls back on HTTP 429 from the primary RPC', async () => {
    const m = await loadSolana({ SOLANA_RPC_URL: 'https://primary.example/rpc?key=secret' });
    const attempted: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: unknown) => {
        attempted.push(String(input));
        if (String(input).startsWith('https://primary.example')) {
          return new Response('rate limited', { status: 429 });
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'test-id', result: 42 }), { status: 200 });
      },
    );
    expect(await m.getConnection().getSlot()).toBe(42);
    expect(attempted.some((u) => u === m.SOLANA_RPC_FALLBACK_URL)).toBe(true);
  });

  it('does not touch the fallback when the primary RPC is healthy', async () => {
    const m = await loadSolana({ SOLANA_RPC_URL: 'https://primary.example/rpc?key=secret' });
    const attempted: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: unknown) => {
        attempted.push(String(input));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'test-id', result: 7 }), { status: 200 });
      },
    );
    expect(await m.getConnection().getSlot()).toBe(7);
    expect(attempted).toHaveLength(1);
    expect(m.getRpcStatus().lastFallbackAt).toBeNull();
  });

  it('getRpcStatus redacts the API key from the primary endpoint', async () => {
    const m = await loadSolana({ SOLANA_RPC_URL: 'https://primary.example/rpc?key=secret' });
    const status = m.getRpcStatus();
    expect(status.primary).toBe('https://primary.example/rpc');
    expect(status.primary).not.toContain('secret');
    expect(status.fallback).toBe(m.SOLANA_RPC_FALLBACK_URL);
    expect(status.primaryIsPublic).toBe(false);
  });

  it('reports a single tier when no private RPC is configured', async () => {
    const m = await loadSolana({});
    expect(m.getRpcStatus().primaryIsPublic).toBe(true);
    expect(m.SOLANA_RPC_URL).toBe(m.SOLANA_RPC_FALLBACK_URL);
  });

  it('fails over through the Alchemy lane before the public endpoint', async () => {
    const alchemyKey = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const m = await loadSolana({
      SOLANA_RPC_URL: 'https://primary.example/rpc?key=secret',
      ALCHEMY_RPC_URL: `https://alchemy.example/v2/${alchemyKey}`,
    });
    const attempted: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: unknown) => {
        attempted.push(String(input));
        const u = String(input);
        if (u.startsWith('https://primary.example')) {
          throw new Error('primary down');
        }
        if (u.startsWith('https://alchemy.example')) {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 'test-id', result: 999 }),
            { status: 200 },
          );
        }
        throw new Error('should not reach the public endpoint');
      },
    );
    expect(await m.getConnection().getSlot()).toBe(999);
    expect(attempted[0]).toContain('primary.example');
    expect(attempted[1]).toBe(`https://alchemy.example/v2/${alchemyKey}`);
    const status = m.getRpcStatus();
    expect(status.activeTier).toBe('alchemy');
    expect(status.alchemy).toBe('https://alchemy.example/v2/<redacted>');
    expect(status.alchemy).not.toContain(alchemyKey);
    expect(status.lastFallbackAt).toEqual(expect.any(Number));
  });

  it('fails over on a -32603 JSON-RPC error inside HTTP 200 (degraded lane)', async () => {
    const alchemyKey = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const m = await loadSolana({
      SOLANA_RPC_URL: 'https://primary.example/rpc?key=secret',
      ALCHEMY_RPC_URL: `https://alchemy.example/v2/${alchemyKey}`,
    });
    const attempted: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: unknown) => {
        attempted.push(String(input));
        if (String(input).startsWith('https://primary.example')) {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 'test-id', error: { code: -32603, message: 'Internal error' } }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 'test-id', result: 555 }),
          { status: 200 },
        );
      },
    );
    expect(await m.getConnection().getSlot()).toBe(555);
    expect(attempted).toHaveLength(2);
    expect(attempted[1]).toBe(`https://alchemy.example/v2/${alchemyKey}`);
    expect(m.getRpcStatus().activeTier).toBe('alchemy');
  });

  it('skips the Alchemy tier when unset and reports it as null', async () => {
    const m = await loadSolana({
      SOLANA_RPC_URL: 'https://primary.example/rpc?key=secret',
      ALCHEMY_RPC_URL: undefined,
    });
    expect(m.ALCHEMY_RPC_URL).toBe('');
    const status = m.getRpcStatus();
    expect(status.alchemy).toBeNull();
    expect(status.activeTier).toBe('primary');
  });

  it('never exposes the Alchemy URL in the browser bundle', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.invalid' } });
    const m = await loadSolana({ ALCHEMY_RPC_URL: 'https://alchemy.example/v2/key2' });
    expect(m.ALCHEMY_RPC_URL).toBe('');
    expect(m.SOLANA_RPC_URL).toBe('https://example.invalid/api/rpc');
    vi.unstubAllGlobals();
  });
});
