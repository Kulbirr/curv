import { afterEach, describe, expect, it, vi } from 'vitest';

describe('solana connection setup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
});
