import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PoolPushClient, type PushSocketLike } from './pool-push-client';
import { buildSubscribeFrame } from './pool-push-protocol';
import type { PoolStateResponse } from '@/components/Pool/types';

const POOL = 'HGGtnXhcPgX8LdyKuiY4BT7K87XubgzZPzktGF6KttRT';
const OTHER = '9Rt6KW2SY3c431mvMYAur9HnXdRiofzosLrQWGBc4qA5';

class FakeSocket implements PushSocketLike {
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.onclose?.();
  }
  fail(): void {
    this.onerror?.();
  }
}

function stateFor(poolAddress: string): PoolStateResponse {
  return {
    poolAddress,
    baseSymbol: 'TEST',
    baseName: 'Test',
    quoteSymbol: 'SOL',
    baseDecimals: 9,
    quoteDecimals: 9,
    imageUrl: null,
    description: null,
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
    migrationQuoteThreshold: 1000,
    tradeStats24h: null,
    creatorBaseFeeRaw: '0',
    creatorQuoteFeeRaw: '0',
    sampledAt: 123,
    stale: false,
  };
}

const stateFrame = (poolAddress: string) =>
  JSON.stringify({ type: 'pool-state', poolAddress, state: stateFor(poolAddress) });

describe('PoolPushClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(delayFn: (n: number) => number = (n) => 1000 * (n + 1)) {
    const created: FakeSocket[] = [];
    const changes: boolean[] = [];
    const states: PoolStateResponse[] = [];
    const client = new PoolPushClient(
      'ws://push.local:8787',
      POOL,
      {
        onConnectionChange: (v) => changes.push(v),
        onState: (s) => states.push(s),
      },
      (url) => {
        const s = new FakeSocket(url);
        created.push(s);
        return s;
      },
      delayFn,
    );
    return { client, created, changes, states };
  }

  it('connects, subscribes, and delivers matching pool states', () => {
    const { client, created, changes, states } = setup();
    client.start();
    expect(created).toHaveLength(1);
    expect(created[0].url).toBe('ws://push.local:8787');

    created[0].open();
    expect(changes).toEqual([true]);
    expect(created[0].sent).toEqual([buildSubscribeFrame([POOL])]);

    created[0].receive(stateFrame(POOL));
    expect(states).toHaveLength(1);
    expect(states[0].price).toBe(1.5);
    client.stop();
  });

  it('ignores frames for other pools and malformed frames', () => {
    const { client, created, states } = setup();
    client.start();
    created[0].open();

    created[0].receive(stateFrame(OTHER));
    created[0].receive('not json');
    created[0].receive(JSON.stringify({ type: 'pool-state' }));
    expect(states).toHaveLength(0);
    client.stop();
  });

  it('reconnects with growing backoff and resets the attempt on success', () => {
    const { client, created, changes } = setup();
    client.start();
    created[0].open();

    // First drop: attempt 0 -> 1000ms.
    created[0].drop();
    expect(changes).toEqual([true, false]);
    vi.advanceTimersByTime(999);
    expect(created).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(created).toHaveLength(2);

    // Second failure without a successful open: attempt 1 -> 2000ms.
    created[1].fail();
    vi.advanceTimersByTime(1999);
    expect(created).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(created).toHaveLength(3);

    // A successful open resets the backoff to attempt 0 -> 1000ms.
    created[2].open();
    created[2].drop();
    vi.advanceTimersByTime(1000);
    expect(created).toHaveLength(4);

    client.stop();
  });

  it('schedules a single reconnect when error and close both fire', () => {
    const { client, created } = setup();
    client.start();
    created[0].open();

    created[0].fail();
    created[0].drop(); // browsers fire error then close for one failure
    vi.advanceTimersByTime(1000);
    expect(created).toHaveLength(2);
    client.stop();
  });

  it('reconnects when the socket factory throws', () => {
    const created: FakeSocket[] = [];
    let failFirst = true;
    const client = new PoolPushClient(
      'ws://push.local:8787',
      POOL,
      { onConnectionChange: () => undefined, onState: () => undefined },
      () => {
        if (failFirst) {
          failFirst = false;
          throw new Error('nope');
        }
        const s = new FakeSocket('ws://push.local:8787');
        created.push(s);
        return s;
      },
      () => 500,
    );
    client.start();
    expect(created).toHaveLength(0);
    vi.advanceTimersByTime(500);
    expect(created).toHaveLength(1);
    client.stop();
  });

  it('stop() closes the live socket, reports disconnect, and cancels reconnects', () => {
    const { client, created, changes } = setup();
    client.start();
    created[0].open();
    client.stop();

    expect(changes).toEqual([true, false]);
    expect(created[0].closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(created).toHaveLength(1);
  });

  it('stop() after a drop cancels the pending reconnect', () => {
    const { client, created, changes } = setup();
    client.start();
    created[0].open();
    created[0].drop(); // reconnect pending
    client.stop();

    expect(changes).toEqual([true, false]);
    vi.advanceTimersByTime(60_000);
    expect(created).toHaveLength(1);
  });

  it('start() is idempotent and stop() before start is safe', () => {
    const { client, created } = setup();
    client.stop();
    client.start();
    client.start();
    expect(created).toHaveLength(1);
    client.stop();
    client.stop();
    expect(created[0].closed).toBe(true);
  });
});
