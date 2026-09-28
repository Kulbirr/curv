import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from './metadata';
import { mockReqRes } from '@/test-support/http';

// Capture every command the route "uploads".
const sentCommands: { input: Record<string, unknown> }[] = [];
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send(cmd: { input: Record<string, unknown> }) {
      sentCommands.push(cmd);
      return {};
    }
  },
  PutObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

const ENV_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_URL',
];
const savedEnv: Record<string, string | undefined> = {};

function setR2Env() {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.R2_ACCOUNT_ID = 'acct';
  process.env.R2_ACCESS_KEY_ID = 'keyid';
  process.env.R2_SECRET_ACCESS_KEY = 'secret';
  process.env.R2_BUCKET = 'bucket';
  process.env.R2_PUBLIC_URL = 'https://pub.example.com';
}

function clearR2Env() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Test Token',
  symbol: 'TEST',
  description: 'A test token',
  ...overrides,
});

beforeEach(() => {
  sentCommands.length = 0;
  vi.clearAllMocks();
});
afterEach(() => restoreEnv());

describe('GET /api/metadata', () => {
  it('reports whether uploads are configured', async () => {
    clearR2Env();
    const { req, res } = mockReqRes('GET');
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.configured).toBe(false);

    setR2Env();
    const { req: req2, res: res2 } = mockReqRes('GET');
    await handler(req2, res2);
    expect(res2.body.configured).toBe(true);
  });

  it('rejects non-GET/POST methods: 405', async () => {
    const { req, res } = mockReqRes('DELETE');
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});

describe('POST /api/metadata', () => {
  it('returns 503 when uploads are not configured', async () => {
    clearR2Env();
    const { req, res } = mockReqRes('POST', { body: validBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(503);
  });

  it('uploads metadata without an image: 201 with the public URI', async () => {
    setR2Env();
    const { req, res } = mockReqRes('POST', { body: validBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.uri).toMatch(/^https:\/\/pub\.example\.com\/tokens\/[^/]+\/metadata\.json$/);
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0].input.Key).toMatch(/\/metadata\.json$/);
    expect(sentCommands[0].input.ContentType).toBe('application/json');
    const parsed = JSON.parse(String(sentCommands[0].input.Body));
    expect(parsed.name).toBe('Test Token');
    expect(parsed.symbol).toBe('TEST');
    expect(parsed.image).toBe(''); // no image: empty string, never undefined
  });

  it('uploads a data-URI image first, then references it from the metadata', async () => {
    setR2Env();
    const pngBytes = Buffer.alloc(64, 0x89);
    const dataUri = 'data:image/png;base64,' + pngBytes.toString('base64');
    const { req, res } = mockReqRes('POST', { body: validBody({ image: dataUri }) });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(sentCommands).toHaveLength(2);
    expect(sentCommands[0].input.Key).toMatch(/\.png$/);
    expect(sentCommands[0].input.ContentType).toBe('image/png');
    const parsed = JSON.parse(String(sentCommands[1].input.Body));
    expect(parsed.image).toBe(`https://pub.example.com/${sentCommands[0].input.Key}`);
  });

  it('passes an https image URL through untouched (no upload)', async () => {
    setR2Env();
    const { req, res } = mockReqRes('POST', {
      body: validBody({ image: 'https://example.com/icon.png' }),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(sentCommands).toHaveLength(1);
    expect(JSON.parse(String(sentCommands[0].input.Body)).image).toBe('https://example.com/icon.png');
  });

  it('rejects oversized images: 400 before any upload', async () => {
    setR2Env();
    // 2.5MB decoded: passes the 4MB payload pre-check, fails the 2MB image cap.
    const big = 'data:image/png;base64,' + Buffer.alloc(2.5 * 1024 * 1024).toString('base64');
    const { req, res } = mockReqRes('POST', { body: validBody({ image: big }) });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('2 MB');
    expect(sentCommands).toHaveLength(0);
  });

  it('rejects absurd payloads before base64 decoding: 400', async () => {
    setR2Env();
    const huge = 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024);
    const { req, res } = mockReqRes('POST', { body: validBody({ image: huge }) });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('too large');
    expect(sentCommands).toHaveLength(0);
  });

  it('rejects non-image data URIs: 400', async () => {
    setR2Env();
    const { req, res } = mockReqRes('POST', {
      body: validBody({ image: 'data:text/plain;base64,aGVsbG8=' }),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid metadata fields: 400', async () => {
    setR2Env();
    for (const body of [
      validBody({ name: '' }),
      validBody({ symbol: 'WAYTOOLONGFORASYM' }),
      validBody({ description: 'x'.repeat(1001) }),
    ]) {
      const { req, res } = mockReqRes('POST', { body });
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(sentCommands).toHaveLength(0);
    }
  });

  it('returns 500 when the upload itself fails', async () => {
    setR2Env();
    const { S3Client } = await import('@aws-sdk/client-s3');
    const spy = vi.spyOn(S3Client.prototype, 'send').mockRejectedValueOnce(new Error('R2 down'));
    const { req, res } = mockReqRes('POST', { body: validBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    spy.mockRestore();
  });
});
