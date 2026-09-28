import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQuoteUsdPrice, KNOWN_QUOTES } from './quote-prices';

describe('getQuoteUsdPrice (devnet)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('HONESTY: on devnet it always returns null without any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const price = await getQuoteUsdPrice('So11111111111111111111111111111111111111112');
    expect(price).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('getQuoteUsdPrice (mainnet branch, fetch mocked)', () => {
  const MINT = 'So11111111111111111111111111111111111111112';
  let getQuoteUsdPriceMainnet: typeof getQuoteUsdPrice;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'mainnet-beta');
    ({ getQuoteUsdPrice: getQuoteUsdPriceMainnet } = await import('./quote-prices'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function mockFetchJson(json: unknown, ok = true) {
    return vi.fn().mockResolvedValue({ ok, json: async () => json });
  }

  it('returns the parsed USD price and queries by mint id', async () => {
    const fetchMock = mockFetchJson({ [MINT]: { usdPrice: 123.45 } });
    vi.stubGlobal('fetch', fetchMock);
    await expect(getQuoteUsdPriceMainnet(MINT)).resolves.toBe(123.45);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`ids=${MINT}`);
  });

  it('caches for 60s: the second call makes no fetch', async () => {
    const fetchMock = mockFetchJson({ [MINT]: { usdPrice: 100 } });
    vi.stubGlobal('fetch', fetchMock);
    await getQuoteUsdPriceMainnet(MINT);
    await getQuoteUsdPriceMainnet(MINT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HONESTY: garbage or missing prices become null, never NaN or 0', async () => {
    for (const body of [
      {},
      { [MINT]: {} },
      { [MINT]: { usdPrice: 'high' } },
      { [MINT]: { usdPrice: NaN } },
      { [MINT]: { usdPrice: -5 } },
      { [MINT]: { usdPrice: 0 } },
    ]) {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'mainnet-beta');
      const m = await import('./quote-prices');
      vi.stubGlobal('fetch', mockFetchJson(body));
      await expect(m.getQuoteUsdPrice(MINT), JSON.stringify(body)).resolves.toBeNull();
    }
  });

  it('returns null when the price API is down or throws', async () => {
    vi.stubGlobal('fetch', mockFetchJson({}, false));
    await expect(
      getQuoteUsdPriceMainnet('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    ).resolves.toBeNull();

    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'mainnet-beta');
    const m2 = await import('./quote-prices');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(m2.getQuoteUsdPrice(MINT)).resolves.toBeNull();
  });
});

describe('KNOWN_QUOTES', () => {
  it('labels the canonical mainnet quote mints', () => {
    expect(KNOWN_QUOTES['So11111111111111111111111111111111111111112']).toBe('SOL');
    expect(KNOWN_QUOTES['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']).toBe('USDC');
  });
});
