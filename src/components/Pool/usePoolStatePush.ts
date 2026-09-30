import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PoolStateResponse } from './types';
import { fetchJson } from './usePoolData';
import { PUSH_WS_URL, resolvePoolStateRefetchInterval } from '@/lib/pool-push-protocol';
import { PoolPushClient } from '@/lib/pool-push-client';

/**
 * Pool state with WebSocket push when NEXT_PUBLIC_CURV_WS_URL is set.
 *
 * While the push socket is connected, the 2s REST poll is disabled and
 * fresh states arrive at the indexer sample cadence (INDEXER_POLL_MS,
 * default 10s); each push is written straight into the react-query cache
 * under the same ['pool-state', poolAddress] key. When the URL is unset
 * or the socket drops, the hook falls back to the existing 2s REST
 * polling automatically, with reconnect backoff.
 *
 * The return shape is identical to usePoolState (same useQuery), so call
 * sites need no other changes. An initial REST fetch always runs so the
 * page is populated before the first push arrives.
 *
 * Socket lifecycle lives in PoolPushClient (unit-tested); the pure
 * polling decision lives in resolvePoolStateRefetchInterval (unit-tested).
 */
export function usePoolStatePush(
  poolAddress: string | null,
  wsUrl: string | undefined = PUSH_WS_URL,
) {
  const queryClient = useQueryClient();
  const [wsConnected, setWsConnected] = useState(false);

  const query = useQuery<PoolStateResponse>({
    queryKey: ['pool-state', poolAddress],
    queryFn: () => fetchJson<PoolStateResponse>(`/api/pools/${poolAddress}/state`),
    enabled: !!poolAddress,
    refetchInterval: resolvePoolStateRefetchInterval({ wsUrl, wsConnected }),
    refetchIntervalInBackground: false,
    // A 404 means "not registered", retrying won't help.
    retry: (count, err) => (err as Error).message !== 'Pool not registered' && count < 2,
    staleTime: 1500,
  });

  // Latest values for the socket callbacks without re-subscribing.
  const latestRef = useRef({ poolAddress, queryClient });
  latestRef.current = { poolAddress, queryClient };

  useEffect(() => {
    if (!poolAddress || !wsUrl || typeof WebSocket === 'undefined') return;
    const client = new PoolPushClient(wsUrl, poolAddress, {
      onConnectionChange: setWsConnected,
      onState: (state) => {
        const current = latestRef.current;
        // Guard against a stale in-flight frame after an address switch.
        if (current.poolAddress === state.poolAddress) {
          current.queryClient.setQueryData<PoolStateResponse>(
            ['pool-state', current.poolAddress],
            state,
          );
        }
      },
    });
    client.start();
    return () => client.stop();
  }, [poolAddress, wsUrl]);

  return query;
}
