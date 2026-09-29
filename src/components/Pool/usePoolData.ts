import { useQuery } from '@tanstack/react-query';
import type { HistoryResponse, PoolStateResponse } from './types';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Pool not registered');
    throw new Error(`Request failed (HTTP ${res.status})`);
  }
  const data = (await res.json()) as T;
  if (!data || typeof data !== 'object') throw new Error('Malformed response');
  return data;
}

/** Live indexed pool state, polled every 2s (price, MC, reserves, stats). No WebSockets; no invented ticks between polls. */
export function usePoolState(poolAddress: string | null) {
  return useQuery<PoolStateResponse>({
    queryKey: ['pool-state', poolAddress],
    queryFn: () => fetchJson<PoolStateResponse>(`/api/pools/${poolAddress}/state`),
    enabled: !!poolAddress,
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    // A 404 means "not registered", retrying won't help.
    retry: (count, err) => (err as Error).message !== 'Pool not registered' && count < 2,
    staleTime: 1500,
  });
}

/** Bucketed real price history, polled every 15s. Pass `from` to select a
 *  time window (the API defaults `to` to now); omitted means the last 24h. */
export function usePoolHistory(poolAddress: string | null, points = 300, from?: number) {
  return useQuery<HistoryResponse>({
    queryKey: ['pool-history', poolAddress, points, from ?? 0],
    queryFn: () => {
      const params = new URLSearchParams({ points: String(points) });
      if (typeof from === 'number') params.set('from', String(from));
      return fetchJson<HistoryResponse>(
        `/api/pools/${poolAddress}/history?${params.toString()}`
      );
    },
    enabled: !!poolAddress,
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    retry: (count, err) => (err as Error).message !== 'Pool not registered' && count < 2,
    staleTime: 10000,
  });
}

/** 24h change computed from the history window's first/last real samples. */
export function changeFromHistory(points: { t: number; price: number }[]): number | null {
  if (points.length < 2) return null;
  const first = points[0].price;
  const last = points[points.length - 1].price;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
  return ((last - first) / first) * 100;
}
