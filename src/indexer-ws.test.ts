import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('node:events');

  class FakeWSServer extends EE {
    static instances: FakeWSServer[] = [];
    closed = false;
    options: unknown;
    constructor(options: unknown) {
      super();
      this.options = options;
      FakeWSServer.instances.push(this);
    }
    close(cb?: () => void) {
      this.closed = true;
      if (cb) cb();
    }
  }

  class FakeWebSocket extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    sent: string[] = [];
    send(data: string) {
      this.sent.push(String(data));
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }

  return { WebSocketServer: FakeWSServer, WebSocket: FakeWebSocket };
});

import { WebSocket, WebSocketServer } from 'ws';
import { PoolStateBroadcaster } from './indexer-ws';
import type { PoolStateResponse } from './components/Pool/types';

type FakeServer = EventEmitter & { closed: boolean };
type FakeSocket = EventEmitter & {
  sent: string[];
  readyState: number;
  send(data: string): void;
  close(): void;
};

const servers = () =>
  (WebSocketServer as unknown as { instances: FakeServer[] }).instances;
const makeSocket = () =>
  new (WebSocket as unknown as new () => FakeSocket)();

const POOL_A = 'HGGtnXhcPgX8LdyKuiY4BT7K87XubgzZPzktGF6KttRT';
const POOL_B = '9Rt6KW2SY3c431mvMYAur9HnXdRiofzosLrQWGBc4qA5';

function fakeState(poolAddress: string): PoolStateResponse {
  return {
    poolAddress,
    baseSymbol: 'TEST',
    baseName: 'Test',
    baseMint: 'Mint111111111111111111111111111111111111111',
    quoteSymbol: 'SOL',
    baseDecimals: 9,
    quoteDecimals: 9,
    imageUrl: null,
    description: null,
    twitter: null,
    creator: 'creator',
    createdAt: 1,
    price: 1.5,
    priceUsd: null,
    quoteReserve: 10,
    baseReserve: 20,
    progress: 50,
    graduated: false,
    hasSwap: true,
    marketCap: 100,
    marketCapUsd: null,
    usdReference: false,
    migrationQuoteThreshold: 1000,
    tradeStats24h: null,
    creatorBaseFeeRaw: '0',
    creatorQuoteFeeRaw: '0',
    sampledAt: Date.now(),
    stale: false,
  };
}

function connect(b: PoolStateBroadcaster): FakeSocket {
  const server = servers()[servers().length - 1];
  const ws = makeSocket();
  server.emit('connection', ws, { url: '/' });
  return ws;
}

describe('PoolStateBroadcaster', () => {
  beforeEach(() => {
    servers().length = 0;
  });

  it('routes broadcasts only to subscribed clients', () => {
    const b = new PoolStateBroadcaster(0);
    const a = connect(b);
    const c = connect(b);
    expect(b.connectionCount).toBe(2);

    a.emit('message', JSON.stringify({ type: 'subscribe', pools: [POOL_A] }));
    c.emit('message', JSON.stringify({ type: 'subscribe', pools: [POOL_B] }));

    b.broadcast(POOL_A, fakeState(POOL_A));

    expect(a.sent).toHaveLength(1);
    expect(c.sent).toHaveLength(0);
    const parsed = JSON.parse(a.sent[0]);
    expect(parsed.type).toBe('pool-state');
    expect(parsed.poolAddress).toBe(POOL_A);
    expect(parsed.state.price).toBe(1.5);
    void b.close();
  });

  it('stops delivery after unsubscribe and drops closed sockets', () => {
    const b = new PoolStateBroadcaster(0);
    const ws = connect(b);
    ws.emit('message', JSON.stringify({ type: 'subscribe', pools: [POOL_A] }));
    ws.emit('message', JSON.stringify({ type: 'unsubscribe', pools: [POOL_A] }));

    b.broadcast(POOL_A, fakeState(POOL_A));
    expect(ws.sent).toHaveLength(0);

    ws.emit('message', JSON.stringify({ type: 'subscribe', pools: [POOL_A] }));
    ws.close();
    expect(b.connectionCount).toBe(0);
    // Broadcast after close must not throw and must not deliver.
    expect(() => b.broadcast(POOL_A, fakeState(POOL_A))).not.toThrow();
    expect(ws.sent).toHaveLength(0);
    void b.close();
  });

  it('ignores malformed frames without crashing', () => {
    const b = new PoolStateBroadcaster(0);
    const ws = connect(b);
    expect(() => {
      ws.emit('message', 'not json');
      ws.emit('message', JSON.stringify({ type: 'subscribe' }));
      ws.emit('message', JSON.stringify({ type: 'subscribe', pools: [POOL_A] }));
    }).not.toThrow();
    b.broadcast(POOL_A, fakeState(POOL_A));
    expect(ws.sent).toHaveLength(1);
    void b.close();
  });

  it('rejects connections when the verifier denies them', async () => {
    const b = new PoolStateBroadcaster(0, { verifyClient: () => false });
    const ws = connect(b);
    await new Promise((r) => setImmediate(r));
    expect(b.connectionCount).toBe(0);
    expect(ws.readyState).toBe(3); // closed with 4401
    void b.close();
  });

  it('accepts connections when the verifier allows them', async () => {
    const b = new PoolStateBroadcaster(0, { verifyClient: async () => true });
    const ws = connect(b);
    await new Promise((r) => setImmediate(r));
    expect(b.connectionCount).toBe(1);
    ws.emit('message', JSON.stringify({ type: 'subscribe', pools: [POOL_A] }));
    b.broadcast(POOL_A, fakeState(POOL_A));
    expect(ws.sent).toHaveLength(1);
    void b.close();
  });

  it('close() shuts down clients and the server', async () => {
    const b = new PoolStateBroadcaster(0);
    const ws = connect(b);
    await b.close();
    expect(ws.readyState).toBe(3);
    const server = servers()[servers().length - 1];
    expect(server.closed).toBe(true);
  });
});
