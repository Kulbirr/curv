import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getVerification, setVerification } from './verifications';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
});
afterEach(async () => { await db.cleanup(); });

describe('pool verifications', () => {
  it('returns null when never checked', async () => {
    expect(await getVerification(randomAddress())).toBeNull();
  });

  it('stores and reads back a verification record', async () => {
    const addr = randomAddress();
    await setVerification(addr, 'verified', 'all fields match', 1000);
    const v = (await getVerification(addr))!;
    expect(v.poolAddress).toBe(addr);
    expect(v.status).toBe('verified');
    expect(v.detail).toBe('all fields match');
    expect(v.checkedAt).toBe(1000);
  });

  it('upserts: a re-check overwrites the previous outcome', async () => {
    const addr = randomAddress();
    await setVerification(addr, 'pending', null, 1000);
    await setVerification(addr, 'unverified', 'RPC unreachable', 2000);
    const v = (await getVerification(addr))!;
    expect(v.status).toBe('unverified');
    expect(v.detail).toBe('RPC unreachable');
    expect(v.checkedAt).toBe(2000);
  });

  it('records rejections as unverified with the reason in the detail', async () => {
    const addr = randomAddress();
    await setVerification(addr, 'unverified', 'rejected: On-chain mismatch in: creator', 3000);
    expect((await getVerification(addr))!.detail).toContain('rejected:');
  });
});
