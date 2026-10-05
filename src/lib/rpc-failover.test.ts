import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFailoverConnection,
  createFailoverFetch,
  resolveRpcLanes,
  RETRYABLE_RPC_ERROR_CODES,
  type RpcLane,
} from './rpc-failover';

const PRIMARY = 'https://primary.example/rpc?api-key=secret1';
const ALCHEMY = 'https://alchemy.example/v2/secret2';

function lanes(): RpcLane[] {
  return [
    { name: 'primary', url: PRIMARY },
    { name: 'alchemy', url: ALCHEMY },
  ];
}

function okResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
}

function rpcError(code: number): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message: 'lane degraded' } }),
    { status: 200 },
  );
}

describe('resolveRpcLanes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the primary lane only when Alchemy is unset', () => {
    vi.stubEnv('SOLANA_RPC_URL', PRIMARY);
    vi.stubEnv('ALCHEMY_RPC_URL', '');
    expect(resolveRpcLanes()).toEqual([{ name: 'primary', url: PRIMARY }]);
  });

  it('appends the Alchemy lane when configured', () => {
    vi.stubEnv('SOLANA_RPC_URL', PRIMARY);
    vi.stubEnv('ALCHEMY_RPC_URL', ALCHEMY);
    expect(resolveRpcLanes()).toEqual([
      { name: 'primary', url: PRIMARY },
      { name: 'alchemy', url: ALCHEMY },
    ]);
  });

  it('falls back to RPC_URL for the primary lane', () => {
    vi.stubEnv('SOLANA_RPC_URL', '');
    vi.stubEnv('RPC_URL', PRIMARY);
    vi.stubEnv('ALCHEMY_RPC_URL', '');
    expect(resolveRpcLanes()).toEqual([{ name: 'primary', url: PRIMARY }]);
  });

  it('dedupes identical URLs and returns empty when nothing is set', () => {
    vi.stubEnv('SOLANA_RPC_URL', PRIMARY);
    vi.stubEnv('ALCHEMY_RPC_URL', PRIMARY);
    expect(resolveRpcLanes()).toEqual([{ name: 'primary', url: PRIMARY }]);

    vi.stubEnv('SOLANA_RPC_URL', '');
    vi.stubEnv('RPC_URL', '');
    vi.stubEnv('ALCHEMY_RPC_URL', '');
    expect(resolveRpcLanes()).toEqual([]);
  });
});

describe('createFailoverFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws when no lanes are configured', () => {
    expect(() => createFailoverFetch([])).toThrow(/no RPC lanes/);
  });

  it('uses the primary lane when healthy (single call)', async () => {
    const attempted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        attempted.push(String(input));
        return okResult(7);
      }),
    );
    const fetch = createFailoverFetch(lanes(), { logFailovers: false });
    const res = await fetch(PRIMARY, { method: 'POST', body: '{}' });
    expect(await res.json()).toMatchObject({ result: 7 });
    expect(attempted).toEqual([PRIMARY]);
  });

  it('fails over to Alchemy on HTTP 500 from the primary', async () => {
    const events: Array<{ from: string; to: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input).startsWith('https://primary.example')) {
          return new Response('broken', { status: 500 });
        }
        return okResult(42);
      }),
    );
    const fetch = createFailoverFetch(lanes(), {
      logFailovers: false,
      onFailover: (e) => events.push(e),
    });
    const res = await fetch(PRIMARY, { method: 'POST', body: '{}' });
    expect(await res.json()).toMatchObject({ result: 42 });
    expect(events).toEqual([{ from: 'primary', to: 'alchemy', reason: 'HTTP 500' }]);
  });

  it('fails over on a -32603 JSON-RPC error inside HTTP 200 (the Helius failure mode)', async () => {
    const attempted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        attempted.push(String(input));
        if (String(input).startsWith('https://primary.example')) {
          return rpcError(-32603);
        }
        return okResult(99);
      }),
    );
    const fetch = createFailoverFetch(lanes(), { logFailovers: false });
    const res = await fetch(PRIMARY, { method: 'POST', body: '{}' });
    expect(await res.json()).toMatchObject({ result: 99 });
    expect(attempted).toHaveLength(2);
    expect(attempted[1]).toBe(ALCHEMY);
  });

  it('returns non-retryable JSON-RPC errors as-is without failing over', async () => {
    const attempted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        attempted.push(String(input));
        return rpcError(-32602); // invalid params: a legitimate answer
      }),
    );
    const fetch = createFailoverFetch(lanes(), { logFailovers: false });
    const res = await fetch(PRIMARY, { method: 'POST', body: '{}' });
    expect(await res.json()).toMatchObject({ error: { code: -32602 } });
    expect(attempted).toHaveLength(1);
  });

  it('fails over on transport failure and throws when every lane fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    const fetch = createFailoverFetch(lanes(), { logFailovers: false });
    await expect(fetch(PRIMARY, { method: 'POST', body: '{}' })).rejects.toThrow(
      /all 2 RPC lane\(s\) failed/,
    );
  });

  it('returns the last degraded response when every lane is rate limited', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('slow down', { status: 429 })),
    );
    const fetch = createFailoverFetch(lanes(), { logFailovers: false });
    const res = await fetch(PRIMARY, { method: 'POST', body: '{}' });
    expect(res.status).toBe(429);
  });

  it('never logs raw URLs on failover (keys stay out of logs)', async () => {
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((msg: unknown) => {
      warned.push(String(msg));
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input).startsWith('https://primary.example')) {
          throw new Error('primary down');
        }
        return okResult(1);
      }),
    );
    const fetch = createFailoverFetch(lanes());
    await fetch(PRIMARY, { method: 'POST', body: '{}' });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"primary"');
    expect(warned[0]).toContain('"alchemy"');
    expect(warned[0]).not.toContain('secret1');
    expect(warned[0]).not.toContain('secret2');
  });

  it('fires onLaneUsed with the serving lane name', async () => {
    const used: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResult(3)),
    );
    const fetch = createFailoverFetch(lanes(), {
      logFailovers: false,
      onLaneUsed: (name) => used.push(name),
    });
    await fetch(PRIMARY, { method: 'POST', body: '{}' });
    expect(used).toEqual(['primary']);
  });

  it('treats -32603 as retryable', () => {
    expect(RETRYABLE_RPC_ERROR_CODES.has(-32603)).toBe(true);
  });
});

describe('createFailoverConnection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws a clear error when no lane is configured', () => {
    vi.stubEnv('SOLANA_RPC_URL', '');
    vi.stubEnv('RPC_URL', '');
    vi.stubEnv('ALCHEMY_RPC_URL', '');
    expect(() => createFailoverConnection({ logFailovers: false })).toThrow(/SOLANA_RPC_URL/);
  });

  it('builds a confirmed Connection on the primary endpoint', () => {
    vi.stubEnv('SOLANA_RPC_URL', PRIMARY);
    vi.stubEnv('ALCHEMY_RPC_URL', ALCHEMY);
    const conn = createFailoverConnection({ logFailovers: false });
    expect(conn.rpcEndpoint).toBe(PRIMARY);
    expect(conn.commitment).toBe('confirmed');
  });
});
