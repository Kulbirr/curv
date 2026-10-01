import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockGetAccountInfo, mockUpdatePoolImage } = vi.hoisted(() => ({
  mockGetAccountInfo: vi.fn(),
  mockUpdatePoolImage: vi.fn(),
}));

vi.mock('./solana', () => ({
  getConnection: () => ({ getAccountInfo: mockGetAccountInfo }),
}));

vi.mock('./db/pools', () => ({
  updatePoolImage: mockUpdatePoolImage,
}));

import { healMissingPoolImages, healPoolImage } from './pool-image-heal';
import type { TrackedPool } from './db/pools';

const MINT = 'So11111111111111111111111111111111111111112';

function pool(overrides: Partial<TrackedPool> = {}): TrackedPool {
  return {
    poolAddress: 'Pool111111111111111111111111111111111111111',
    configAddress: 'Cfg1111111111111111111111111111111111111111',
    baseMint: MINT,
    quoteMint: MINT,
    creator: 'Cre11111111111111111111111111111111111111111',
    baseSymbol: 'TEST',
    baseName: 'Test',
    quoteSymbol: 'SOL',
    createdAt: Date.now(),
    verified: false,
    ...overrides,
  } as TrackedPool;
}

/** A fake Metaplex metadata account whose only URL is the metadata URI. */
function metadataAccount(uri: string) {
  return {
    data: Buffer.concat([
      Buffer.from([0x04, 0x33, 0x54, 0x65, 0x73, 0x74]),
      Buffer.from(uri, 'utf8'),
      Buffer.alloc(200),
    ]),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  mockGetAccountInfo.mockReset();
  mockUpdatePoolImage.mockReset();
});

describe('healPoolImage', () => {
  it('derives the image from on-chain metadata and updates the registry', async () => {
    mockGetAccountInfo.mockResolvedValue(metadataAccount('https://example.com/meta.json'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ image: 'https://example.com/img.png' }),
      }),
    );
    mockUpdatePoolImage.mockResolvedValue(true);

    const image = await healPoolImage(pool());
    expect(image).toBe('https://example.com/img.png');
    expect(mockUpdatePoolImage).toHaveBeenCalledWith(
      'Pool111111111111111111111111111111111111111',
      'https://example.com/img.png',
    );
  });

  it('skips pools that already have an image (no chain reads)', async () => {
    const image = await healPoolImage(pool({ imageUrl: 'https://example.com/old.png' }));
    expect(image).toBeNull();
    expect(mockGetAccountInfo).not.toHaveBeenCalled();
    expect(mockUpdatePoolImage).not.toHaveBeenCalled();
  });

  it('returns null when the metadata account does not exist', async () => {
    mockGetAccountInfo.mockResolvedValue(null);
    expect(await healPoolImage(pool())).toBeNull();
    expect(mockUpdatePoolImage).not.toHaveBeenCalled();
  });

  it('returns null when the metadata has no https image', async () => {
    mockGetAccountInfo.mockResolvedValue(metadataAccount('https://example.com/meta.json'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ image: 'ipfs://QmHash/img.png' }),
      }),
    );
    expect(await healPoolImage(pool())).toBeNull();
    expect(mockUpdatePoolImage).not.toHaveBeenCalled();
  });
});

describe('healMissingPoolImages', () => {
  it('mirrors healed URLs into the in-memory rows', async () => {
    mockGetAccountInfo.mockResolvedValue(metadataAccount('https://example.com/meta.json'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ image: 'https://example.com/img.png' }),
      }),
    );
    mockUpdatePoolImage.mockResolvedValue(true);

    const rows = [pool(), pool({ imageUrl: 'https://example.com/old.png' })];
    await healMissingPoolImages(rows);
    expect(rows[0].imageUrl).toBe('https://example.com/img.png');
    expect(rows[1].imageUrl).toBe('https://example.com/old.png');
    expect(mockGetAccountInfo).toHaveBeenCalledTimes(1);
  });
});
