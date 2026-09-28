import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from './health';
import { getConnection, getRpcStatus } from '@/lib/solana';
import { mockReqRes } from '@/test-support/http';
import { useTempDb } from '@/test-support/db';

vi.mock('@/lib/solana', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/solana')>();
  return { ...actual, getConnection: vi.fn(), getRpcStatus: vi.fn() };
});

const mockGetConnection = getConnection as unknown as ReturnType<typeof vi.fn>;
const mockGetRpcStatus = getRpcStatus as unknown as ReturnType<typeof vi.fn>;

describe('GET /api/health', () => {
  let db: ReturnType<typeof useTempDb>;

  beforeEach(() => {
    db = useTempDb();
    mockGetConnection.mockReturnValue({ getSlot: async () => 999_999 });
    mockGetRpcStatus.mockReturnValue({
      primary: 'https://primary.example',
      fallback: 'https://fallback.example',
      primaryIsPublic: false,
      lastFallbackAt: null,
    });
  });

  afterEach(() => {
    db.cleanup();
    vi.clearAllMocks();
  });

  it('returns 200 with db, rpc and redacted endpoint info when healthy', async () => {
    const { req, res } = mockReqRes('GET');
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.ok).toBe(true);
    expect(body.db.ok).toBe(true);
    expect(body.db.pools).toBe(0);
    expect(body.rpc.ok).toBe(true);
    expect(body.rpc.slot).toBe(999_999);
    expect(body.rpc.primary).toBe('https://primary.example');
    expect(JSON.stringify(body)).not.toContain('api-key');
    expect(typeof body.uptimeSec).toBe('number');
  });

  it('returns 503 when the RPC is down', async () => {
    mockGetConnection.mockReturnValue({
      getSlot: async () => {
        throw new Error('rpc down');
      },
    });
    const { req, res } = mockReqRes('GET');
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    const body = res.body;
    expect(body.ok).toBe(false);
    expect(body.rpc.ok).toBe(false);
    expect(body.db.ok).toBe(true);
  });
});
