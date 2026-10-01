import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VIEWER_PRUNE_MS,
  VIEWER_TTL_MS,
  countViewers,
  heartbeatViewer,
  isValidSessionId,
} from './viewers';
import { query } from './index';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
});
afterEach(async () => {
  await db.cleanup();
});

const NOW = 1_700_000_000_000;
const SID1 = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';

describe('isValidSessionId', () => {
  it('accepts UUID-shaped ids', () => {
    expect(isValidSessionId(SID1)).toBe(true);
  });
  it('rejects junk, empty, and overlong values', () => {
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('drop table pool_viewers')).toBe(false);
    expect(isValidSessionId('x'.repeat(65))).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
  });
});

describe('heartbeatViewer / countViewers', () => {
  it('counts one heartbeat as one viewer', async () => {
    const pool = randomAddress();
    const n = await heartbeatViewer(pool, SID1, NOW);
    expect(n).toBe(1);
    expect(await countViewers(pool, NOW)).toBe(1);
  });

  it('counts distinct sessions separately', async () => {
    const pool = randomAddress();
    await heartbeatViewer(pool, SID1, NOW);
    const n = await heartbeatViewer(pool, SID2, NOW);
    expect(n).toBe(2);
  });

  it('refreshing the same session does not double count', async () => {
    const pool = randomAddress();
    await heartbeatViewer(pool, SID1, NOW);
    const n = await heartbeatViewer(pool, SID1, NOW + 10_000);
    expect(n).toBe(1);
  });

  it('does not count sessions older than the TTL', async () => {
    const pool = randomAddress();
    await heartbeatViewer(pool, SID1, NOW - VIEWER_TTL_MS - 1);
    await heartbeatViewer(pool, SID2, NOW);
    expect(await countViewers(pool, NOW)).toBe(1);
  });

  it('isolates counts per pool', async () => {
    const poolA = randomAddress();
    const poolB = randomAddress();
    await heartbeatViewer(poolA, SID1, NOW);
    await heartbeatViewer(poolB, SID1, NOW);
    expect(await countViewers(poolA, NOW)).toBe(1);
    expect(await countViewers(poolB, NOW)).toBe(1);
  });

  it('prunes rows older than the prune window', async () => {
    const pool = randomAddress();
    await heartbeatViewer(pool, SID1, NOW - VIEWER_PRUNE_MS - 1);
    await heartbeatViewer(pool, SID2, NOW);
    const rows = await query<{ session_id: string }>(
      'SELECT session_id FROM pool_viewers WHERE pool_address = $1',
      [pool],
    );
    expect(rows.map((r) => r.session_id)).toEqual([SID2]);
  });
});
