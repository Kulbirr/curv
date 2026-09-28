import { describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_ASSETS,
  JUP_PRICE_BATCH_SIZE,
  enrichWithPrices,
  mapXstocksAssets,
  mergeWithFallback,
  searchQuoteAssets,
  type QuoteAsset,
} from './quote-directory'

const XSTOCKS_SAMPLE = {
  nodes: [
    {
      name: 'Tesla xStock',
      symbol: 'TSLAx',
      logo: 'https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.png',
      isTradingHalted: false,
      deployments: [
        {
          address: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
          network: 'Solana',
        },
        { address: '0x1234', network: 'Ethereum' },
      ],
    },
    {
      name: 'Halted xStock',
      symbol: 'HALTx',
      logo: 'https://xstocks-metadata.backed.fi/logos/tokens/HALTx.png',
      isTradingHalted: true,
      deployments: [
        {
          address: 'HaltedMint11111111111111111111111111111111',
          network: 'Solana',
        },
      ],
    },
    {
      // No Solana deployment: excluded.
      name: 'EVM only',
      symbol: 'EVMx',
      deployments: [{ address: '0x9999', network: 'Arbitrum' }],
    },
    {
      // No symbol: excluded.
      name: 'Nameless',
      deployments: [
        {
          address: 'NoSymbolMint1111111111111111111111111111',
          network: 'Solana',
        },
      ],
    },
  ],
}

function asset(over: Partial<QuoteAsset> = {}): QuoteAsset {
  return {
    mint: 'Mint111111111111111111111111111111111111111',
    symbol: 'TST',
    name: 'Test',
    decimals: null,
    logoUrl: null,
    source: 'xstocks',
    network: 'mainnet-beta',
    tokenProgram: 'Token-2022',
    usdPrice: null,
    liquidityUsd: null,
    tags: [],
    ...over,
  }
}

describe('mapXstocksAssets', () => {
  it('keeps only Solana deployments with a symbol and mint', () => {
    const assets = mapXstocksAssets(XSTOCKS_SAMPLE)
    expect(assets.map((a) => a.symbol).sort()).toEqual(['HALTx', 'TSLAx'])
  })

  it('maps issuer metadata and marks Token-2022', () => {
    const [tsla] = mapXstocksAssets(XSTOCKS_SAMPLE).filter(
      (a) => a.symbol === 'TSLAx'
    )
    expect(tsla.mint).toBe('XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB')
    expect(tsla.name).toBe('Tesla xStock')
    expect(tsla.logoUrl).toContain('xstocks-metadata.backed.fi')
    expect(tsla.tokenProgram).toBe('Token-2022')
    expect(tsla.network).toBe('mainnet-beta')
    expect(tsla.source).toBe('xstocks')
    // The registry does not publish decimals.
    expect(tsla.decimals).toBeNull()
  })

  it('tags halted assets', () => {
    const [halted] = mapXstocksAssets(XSTOCKS_SAMPLE).filter(
      (a) => a.symbol === 'HALTx'
    )
    expect(halted.tags).toContain('trading-halted')
  })

  it('returns empty for malformed payloads', () => {
    expect(mapXstocksAssets(null)).toEqual([])
    expect(mapXstocksAssets({})).toEqual([])
    expect(mapXstocksAssets({ nodes: 'nope' })).toEqual([])
  })
})

describe('enrichWithPrices', () => {
  it('fills price, liquidity and decimals from Jupiter price v3', async () => {
    const assets = [asset({ mint: 'M1' }), asset({ mint: 'M2' })]
    const fetchImpl = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({
        M1: { usdPrice: 357.25, decimals: 8, liquidity: 1236739.45 },
        // M2 absent: keeps nulls.
      }),
    }))
    await enrichWithPrices(assets, fetchImpl as unknown as typeof fetch)
    expect(assets[0].usdPrice).toBe(357.25)
    expect(assets[0].decimals).toBe(8)
    expect(assets[0].liquidityUsd).toBe(1236739.45)
    expect(assets[1].usdPrice).toBeNull()
    expect(assets[1].decimals).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toContain('ids=M1,M2')
  })

  it('batches at the Jupiter limit', async () => {
    const assets = Array.from({ length: JUP_PRICE_BATCH_SIZE + 1 }, (_, i) =>
      asset({ mint: `M${i}`, symbol: `S${i}` })
    )
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    }))
    await enrichWithPrices(assets, fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('never throws on network failure', async () => {
    const assets = [asset()]
    const fetchImpl = vi.fn(async () => {
      throw new Error('down')
    })
    await expect(
      enrichWithPrices(assets, fetchImpl as unknown as typeof fetch)
    ).resolves.toEqual(assets)
  })

  it('ignores non-finite values', async () => {
    const assets = [asset({ mint: 'M1' })]
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        M1: { usdPrice: NaN, decimals: 99, liquidity: -5 },
      }),
    }))
    await enrichWithPrices(assets, fetchImpl as unknown as typeof fetch)
    expect(assets[0].usdPrice).toBeNull()
    expect(assets[0].decimals).toBeNull()
    expect(assets[0].liquidityUsd).toBeNull()
  })
})

describe('searchQuoteAssets', () => {
  const assets = [
    asset({
      mint: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
      name: 'Solana',
    }),
    asset({
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: 'USDC',
      name: 'USD Coin',
    }),
    asset({
      mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
      symbol: 'TSLAx',
      name: 'Tesla xStock',
    }),
    asset({
      mint: 'AbSoLut111111111111111111111111111111111111',
      symbol: 'ABSO',
      name: 'Absolute',
    }),
  ]

  it('ranks symbol prefix matches first', () => {
    const res = searchQuoteAssets(assets, 'sol')
    expect(res[0].symbol).toBe('SOL')
  })

  it('matches name and mint substrings', () => {
    expect(searchQuoteAssets(assets, 'tesla')[0].symbol).toBe('TSLAx')
    expect(searchQuoteAssets(assets, 'EPjFWdd')[0].symbol).toBe('USDC')
  })

  it('returns the top of the directory on empty query', () => {
    expect(searchQuoteAssets(assets, '   ')).toHaveLength(4)
  })

  it('is case-insensitive', () => {
    expect(searchQuoteAssets(assets, 'TSLAX')[0].symbol).toBe('TSLAx')
  })
})

describe('fallback directory', () => {
  it('contains only well-formed entries', () => {
    expect(FALLBACK_ASSETS.length).toBeGreaterThan(0)
    for (const a of FALLBACK_ASSETS) {
      expect(a.mint.length).toBeGreaterThan(30)
      expect(a.symbol.length).toBeGreaterThan(0)
      expect(a.network).toBe('mainnet-beta')
    }
  })

  it('mergeWithFallback dedupes by mint', () => {
    const live = [asset({ mint: FALLBACK_ASSETS[0].mint, symbol: 'SOL' })]
    const merged = mergeWithFallback(live)
    const sols = merged.filter((a) => a.mint === FALLBACK_ASSETS[0].mint)
    expect(sols).toHaveLength(1)
    expect(sols[0].symbol).toBe('SOL')
    expect(merged.length).toBe(FALLBACK_ASSETS.length)
  })
})
