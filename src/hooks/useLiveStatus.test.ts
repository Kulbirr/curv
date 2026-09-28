import { describe, expect, it } from 'vitest';
import { deriveLiveStatus } from './useLiveStatus';

const NOW = 1_000_000;

describe('deriveLiveStatus', () => {
  it('is live when data is fresh', () => {
    expect(
      deriveLiveStatus({ dataUpdatedAt: NOW - 1_000, isFetching: false, isError: false, now: NOW }),
    ).toBe('live');
  });

  it('stays live while a background refetch is in flight', () => {
    expect(
      deriveLiveStatus({ dataUpdatedAt: NOW - 1_000, isFetching: true, isError: false, now: NOW }),
    ).toBe('live');
  });

  it('is reconnecting when fetching after a failure', () => {
    expect(
      deriveLiveStatus({ dataUpdatedAt: NOW - 2_000, isFetching: true, isError: true, now: NOW }),
    ).toBe('reconnecting');
  });

  it('is reconnecting when a fetch is in flight and data is old', () => {
    expect(
      deriveLiveStatus({ dataUpdatedAt: NOW - 20_000, isFetching: true, isError: false, now: NOW }),
    ).toBe('reconnecting');
  });

  it('is stale when polls have silently stopped succeeding', () => {
    expect(
      deriveLiveStatus({ dataUpdatedAt: NOW - 60_000, isFetching: false, isError: false, now: NOW }),
    ).toBe('stale');
  });

  it('is error only when the query failed with no data at all', () => {
    expect(
      deriveLiveStatus({ dataUpdatedAt: 0, isFetching: false, isError: true, now: NOW }),
    ).toBe('error');
  });

  it('prefers reconnecting over error while a retry is in flight', () => {
    expect(
      deriveLiveStatus({ dataUpdatedAt: 0, isFetching: true, isError: true, now: NOW }),
    ).toBe('reconnecting');
  });

  it('is idle before the first load with no fetch in flight', () => {
    expect(
      deriveLiveStatus({ dataUpdatedAt: 0, isFetching: false, isError: false, now: NOW }),
    ).toBe('idle');
  });

  it('is reconnecting on first load while fetching', () => {
    expect(
      deriveLiveStatus({ dataUpdatedAt: 0, isFetching: true, isError: false, now: NOW }),
    ).toBe('reconnecting');
  });
});
