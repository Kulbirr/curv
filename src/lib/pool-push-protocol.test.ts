import { describe, expect, it } from 'vitest';
import {
  buildSubscribeFrame,
  buildUnsubscribeFrame,
  computePushReconnectDelay,
  MAX_SUBSCRIBE_POOLS,
  mergePushedState,
  parsePushClientMessage,
  parsePushServerMessage,
  POOL_STATE_POLL_MS,
  PUSH_RECONNECT_BASE_MS,
  PUSH_RECONNECT_MAX_MS,
  resolvePoolStateRefetchInterval,
} from './pool-push-protocol';
import type { PoolStateResponse } from '@/components/Pool/types';

const ADDR_A = 'HGGtnXhcPgX8LdyKuiY4BT7K87XubgzZPzktGF6KttRT';
const ADDR_B = '9Rt6KW2SY3c431mvMYAur9HnXdRiofzosLrQWGBc4qA5';

describe('parsePushClientMessage', () => {
  it('parses a valid subscribe frame', () => {
    expect(
      parsePushClientMessage(JSON.stringify({ type: 'subscribe', pools: [ADDR_A] })),
    ).toEqual({ type: 'subscribe', pools: [ADDR_A] });
  });

  it('parses a valid unsubscribe frame', () => {
    expect(
      parsePushClientMessage(JSON.stringify({ type: 'unsubscribe', pools: [ADDR_A, ADDR_B] })),
    ).toEqual({ type: 'unsubscribe', pools: [ADDR_A, ADDR_B] });
  });

  it('rejects malformed frames without throwing', () => {
    expect(parsePushClientMessage('not json')).toBeNull();
    expect(parsePushClientMessage('')).toBeNull();
    expect(parsePushClientMessage(JSON.stringify({ type: 'subscribe' }))).toBeNull();
    expect(parsePushClientMessage(JSON.stringify({ type: 'bogus', pools: [] }))).toBeNull();
    expect(parsePushClientMessage(JSON.stringify({ pools: [ADDR_A] }))).toBeNull();
    expect(parsePushClientMessage(JSON.stringify({ type: 'subscribe', pools: 'x' }))).toBeNull();
    expect(parsePushClientMessage(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parsePushClientMessage(JSON.stringify(null))).toBeNull();
  });

  it('drops implausible addresses but keeps the valid ones', () => {
    const msg = parsePushClientMessage(
      JSON.stringify({ type: 'subscribe', pools: [ADDR_A, 'x', 42, ''] }),
    );
    expect(msg).toEqual({ type: 'subscribe', pools: [ADDR_A] });
  });

  it('caps the subscription list', () => {
    const pools = Array.from({ length: MAX_SUBSCRIBE_POOLS + 50 }, (_, i) =>
      ADDR_A.slice(0, 40) + String(i).padStart(4, '0'),
    );
    const msg = parsePushClientMessage(JSON.stringify({ type: 'subscribe', pools }));
    expect(msg?.pools).toHaveLength(MAX_SUBSCRIBE_POOLS);
  });
});

describe('build frames round-trip', () => {
  it('subscribe frame parses back', () => {
    expect(parsePushClientMessage(buildSubscribeFrame([ADDR_A]))).toEqual({
      type: 'subscribe',
      pools: [ADDR_A],
    });
  });

  it('unsubscribe frame parses back', () => {
    expect(parsePushClientMessage(buildUnsubscribeFrame([ADDR_A, ADDR_B]))).toEqual({
      type: 'unsubscribe',
      pools: [ADDR_A, ADDR_B],
    });
  });
});

function minimalState(): PoolStateResponse {
  return {
    poolAddress: ADDR_A,
    baseSymbol: 'TEST',
    baseName: 'Test',
    baseMint: 'Mint111111111111111111111111111111111111111',
    quoteSymbol: 'SOL',
    baseDecimals: 9,
    quoteDecimals: 9,
    imageUrl: null,
    description: null,
    twitter: null,
    creator: ADDR_B,
    createdAt: 1,
    price: 0.5,
    priceUsd: null,
    quoteReserve: 10,
    baseReserve: 20,
    progress: 42,
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

describe('parsePushServerMessage', () => {
  it('parses a valid pool-state frame', () => {
    const state = minimalState();
    const msg = parsePushServerMessage(
      JSON.stringify({ type: 'pool-state', poolAddress: ADDR_A, state }),
    );
    expect(msg).toEqual({ type: 'pool-state', poolAddress: ADDR_A, state });
  });

  it('rejects malformed frames without throwing', () => {
    expect(parsePushServerMessage('nope')).toBeNull();
    expect(
      parsePushServerMessage(JSON.stringify({ type: 'pool-state', poolAddress: ADDR_A })),
    ).toBeNull();
    expect(
      parsePushServerMessage(JSON.stringify({ type: 'pool-state', state: minimalState() })),
    ).toBeNull();
    expect(
      parsePushServerMessage(
        JSON.stringify({ type: 'other', poolAddress: ADDR_A, state: minimalState() }),
      ),
    ).toBeNull();
    const bad = minimalState() as unknown as Record<string, unknown>;
    delete bad.stale;
    expect(
      parsePushServerMessage(JSON.stringify({ type: 'pool-state', poolAddress: ADDR_A, state: bad })),
    ).toBeNull();
  });
});

describe('computePushReconnectDelay', () => {
  it('backs off exponentially with jitter, deterministic when rand is fixed', () => {
    expect(computePushReconnectDelay(0, () => 0)).toBe(PUSH_RECONNECT_BASE_MS / 2);
    expect(computePushReconnectDelay(0, () => 1)).toBe(PUSH_RECONNECT_BASE_MS);
    expect(computePushReconnectDelay(1, () => 0)).toBe(PUSH_RECONNECT_BASE_MS);
    expect(computePushReconnectDelay(2, () => 0)).toBe(2 * PUSH_RECONNECT_BASE_MS);
  });

  it('caps at the maximum', () => {
    expect(computePushReconnectDelay(100, () => 1)).toBe(PUSH_RECONNECT_MAX_MS);
    expect(computePushReconnectDelay(100, () => 0)).toBe(PUSH_RECONNECT_MAX_MS / 2);
  });

  it('treats negative attempts as zero', () => {
    expect(computePushReconnectDelay(-5, () => 0)).toBe(
      computePushReconnectDelay(0, () => 0),
    );
  });
});

describe('resolvePoolStateRefetchInterval', () => {
  it('disables polling while the push socket is connected', () => {
    expect(
      resolvePoolStateRefetchInterval({ wsUrl: 'ws://localhost:8787', wsConnected: true }),
    ).toBe(false);
  });

  it('falls back to 2s polling when the URL is unset', () => {
    expect(
      resolvePoolStateRefetchInterval({ wsUrl: undefined, wsConnected: false }),
    ).toBe(POOL_STATE_POLL_MS);
  });

  it('falls back to 2s polling when the socket dropped', () => {
    expect(
      resolvePoolStateRefetchInterval({ wsUrl: 'ws://localhost:8787', wsConnected: false }),
    ).toBe(POOL_STATE_POLL_MS);
  });
});

describe('mergePushedState', () => {
  it('keeps the cached baseMint when a push frame omits it', () => {
    const cached = minimalState();
    const pushed = { ...minimalState(), price: 0.75 } as PoolStateResponse;
    delete (pushed as Partial<PoolStateResponse>).baseMint;
    const merged = mergePushedState(cached, pushed);
    expect(merged.baseMint).toBe(cached.baseMint);
    expect(merged.price).toBe(0.75);
  });

  it('prefers the pushed baseMint when present', () => {
    const cached = minimalState();
    const pushed = { ...minimalState(), baseMint: 'NewMint11111111111111111111111111111111111' };
    expect(mergePushedState(cached, pushed).baseMint).toBe(pushed.baseMint);
  });

  it('degrades to empty string when neither side has a mint', () => {
    const pushed = { ...minimalState() } as PoolStateResponse;
    delete (pushed as Partial<PoolStateResponse>).baseMint;
    expect(mergePushedState(undefined, pushed).baseMint).toBe('');
  });

  it('keeps the cached twitter link when a push frame omits it', () => {
    const cached = { ...minimalState(), twitter: 'https://x.com/test' };
    const pushed = { ...minimalState(), price: 0.75 } as PoolStateResponse;
    delete (pushed as Partial<PoolStateResponse>).twitter;
    const merged = mergePushedState(cached, pushed);
    expect(merged.twitter).toBe('https://x.com/test');
    expect(merged.price).toBe(0.75);
  });

  it('prefers the pushed twitter link when present', () => {
    const cached = minimalState();
    const pushed = { ...minimalState(), twitter: 'https://x.com/new' };
    expect(mergePushedState(cached, pushed).twitter).toBe('https://x.com/new');
  });

  it('degrades twitter to null when neither side has one', () => {
    expect(mergePushedState(undefined, minimalState()).twitter).toBeNull();
  });
});
