/** Live connection status derived from a react-query result's metadata. */

import { useEffect, useState } from 'react';

export type LiveStatus = 'live' | 'reconnecting' | 'stale' | 'error' | 'idle';

export interface LiveStatusInput {
  /** From query.dataUpdatedAt — 0 when nothing has loaded yet. */
  dataUpdatedAt: number;
  /** From query.isFetching. */
  isFetching: boolean;
  /** From query.isError. */
  isError: boolean;
  /** Now, unix ms. */
  now: number;
}

/**
 * Pure status derivation, extracted for testing. A feed is "live" when it
 * has data and the last successful poll is recent; "reconnecting" when a
 * fetch is in flight after a failure or while data is stale; "stale" when
 * polls have silently stopped succeeding; "error" only when there is no
 * data at all and the query failed.
 */
export function deriveLiveStatus(input: LiveStatusInput): LiveStatus {
  const { dataUpdatedAt, isFetching, isError, now } = input;
  const hasData = dataUpdatedAt > 0;
  const ageMs = hasData ? now - dataUpdatedAt : Number.POSITIVE_INFINITY;

  if (isError && !hasData && !isFetching) return 'error';
  if (isFetching && (isError || ageMs > 10_000)) return 'reconnecting';
  if (hasData && ageMs > 30_000) return 'stale';
  if (hasData) return 'live';
  return isFetching ? 'reconnecting' : 'idle';
}

/** Re-render on an interval so time-based statuses (stale) transition without new data. */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
