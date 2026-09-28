import { useMemo } from 'react';
import Link from 'next/link';
import { useWallet } from '@jup-ag/wallet-adapter';
import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import { useQueries, useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import Page from '@/components/ui/Page/Page';
import { getConnection, isDevnet } from '@/lib/solana';
import { DASH } from '@/lib/format/number';
import {
  clampProgress,
  formatCompact,
  formatCompactUsd,
  formatMoneyValue,
  formatPriceValue,
} from '@/components/Discover/format';
import type { PoolsResponse } from '@/components/Discover/types';
import type { PoolStateResponse } from '@/components/Pool/types';
import {
  aggregateCreatorEarnings,
  formatFeeRaw,
  type AggregatedEarning,
  type EarningsEntry,
} from '@/lib/claim-creator-fees';

interface Holding {
  mint: string;
  amount: number;
  decimals: number;
}

async function fetchHoldings(owner: string): Promise<Holding[]> {
  const connection = getConnection();
  const { value } = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  });
  return value
    .map((a) => {
      const info = a.account.data.parsed?.info;
      const amt = info?.tokenAmount;
      if (!amt) return null;
      return {
        mint: info.mint as string,
        amount: Number(amt.uiAmount ?? 0),
        decimals: Number(amt.decimals ?? 0),
      } satisfies Holding;
    })
    .filter((h): h is Holding => h !== null && h.amount > 0);
}

async function fetchPools(): Promise<PoolsResponse> {
  const res = await fetch('/api/pools', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PoolsResponse;
}

async function fetchPoolState(poolAddress: string): Promise<PoolStateResponse> {
  const res = await fetch(`/api/pools/${poolAddress}/state`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PoolStateResponse;
}

/** First-letter token mark for the spec's holding-mark tile. */
function tokenMark(symbol: string): string {
  return (symbol.charAt(0) || '?').toUpperCase();
}

/** Display string for one aggregated earning: exact raw amount, compact. */
function formatEarningTotal(e: AggregatedEarning): string {
  const ui = formatFeeRaw(e.rawTotal, e.decimals);
  return `${formatCompact(Number(ui ?? '0'))} ${e.symbol}`;
}

export default function Portfolio() {
  const { publicKey, connected } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const owner = publicKey?.toBase58() ?? '';

  const holdingsQuery = useQuery({
    queryKey: ['holdings', owner],
    queryFn: () => fetchHoldings(owner),
    enabled: connected && !!owner,
    refetchInterval: 15000,
  });
  const poolsQuery = useQuery({
    queryKey: ['discover-pools'],
    queryFn: fetchPools,
    refetchInterval: 10000,
  });

  const pools = useMemo(() => poolsQuery.data?.pools ?? [], [poolsQuery.data]);

  /**
   * Exact-mint index: holding.mint → pool. Matching is byte-for-byte on
   * the mint string. Never fuzzy, never derived. A holding with no exact
   * match simply shows no valuation.
   */
  const poolsByMint = useMemo(() => {
    const m = new Map<string, (typeof pools)[number]>();
    for (const p of pools) m.set(p.baseMint, p);
    return m;
  }, [pools]);

  const created = useMemo(
    () => pools.filter((p) => p.creator === owner),
    [pools, owner],
  );

  const createdAddresses = useMemo(() => created.map((p) => p.poolAddress), [created]);

  /** Per-pool indexed state for the pools this wallet created (creator fees). */
  const createdStateQueries = useQueries({
    queries: createdAddresses.map((addr) => ({
      queryKey: ['pool-state', addr],
      queryFn: () => fetchPoolState(addr),
      enabled: connected && createdAddresses.length > 0,
      refetchInterval: 15000,
      retry: 1,
    })),
  });

  const earningsEntries: EarningsEntry[] = useMemo(
    () =>
      created.map((p, i) => {
        const s = createdStateQueries[i]?.data;
        return {
          poolAddress: p.poolAddress,
          baseSymbol: p.baseSymbol,
          quoteSymbol: p.quoteSymbol,
          baseMint: p.baseMint,
          quoteMint: p.quoteMint,
          baseDecimals: s?.baseDecimals ?? 9,
          quoteDecimals: s?.quoteDecimals ?? 9,
          creatorBaseFeeRaw: s?.creatorBaseFeeRaw ?? null,
          creatorQuoteFeeRaw: s?.creatorQuoteFeeRaw ?? null,
          priceUsd: s?.priceUsd ?? null,
        };
      }),
    [created, createdStateQueries],
  );

  const earningsByToken = useMemo(() => aggregateCreatorEarnings(earningsEntries), [earningsEntries]);
  const earningsLoading = createdStateQueries.some((q) => q.isLoading);
  const earningsError = createdStateQueries.some((q) => q.isError);

  const holdings = holdingsQuery.data ?? [];

  /**
   * Total portfolio value, USD. Sums only holdings whose exact-matched pool
   * carries a real indexed USD price. Any holding without one makes the
   * total partial. Nothing is ever silently complete.
   */
  const portfolioValue = useMemo(() => {
    let total = 0;
    let priced = 0;
    for (const h of holdings) {
      const pool = poolsByMint.get(h.mint);
      if (pool && pool.priceUsd !== null) {
        total += h.amount * pool.priceUsd;
        priced += 1;
      }
    }
    return { total, priced, count: holdings.length };
  }, [holdings, poolsByMint]);
  const valuePartial = portfolioValue.count > 0 && portfolioValue.priced < portfolioValue.count;
  const valueUnknown = portfolioValue.count > 0 && portfolioValue.priced === 0;

  /**
   * Split the aggregated earnings into base-token and quote-token totals for
   * the spec's summary card. Same exact raw sums, grouped by mint role.
   */
  const baseMints = useMemo(
    () => new Set(earningsEntries.map((e) => e.baseMint)),
    [earningsEntries],
  );
  const baseTotals = useMemo(
    () =>
      earningsByToken
        .filter((e) => baseMints.has(e.mint))
        .map(formatEarningTotal)
        .join(' · ') || DASH,
    [earningsByToken, baseMints],
  );
  const quoteTotals = useMemo(
    () =>
      earningsByToken
        .filter((e) => !baseMints.has(e.mint))
        .map(formatEarningTotal)
        .join(' · ') || DASH,
    [earningsByToken, baseMints],
  );

  return (
    <Page>
      <main className="sc-portfolio-page">
        <div className="sc-portfolio-title-row">
          <h1>
            Your <em>Portfolio</em>
          </h1>
          {connected && owner && (
            <span
              className="sc-wallet-address"
              title={`${isDevnet() ? 'Devnet' : 'Mainnet'} · read live from your wallet`}
            >
              <i /> {owner.slice(0, 4)}…{owner.slice(-4)}{' '}
              <small>{isDevnet() ? 'DEVNET' : 'MAINNET'}</small>
            </span>
          )}
        </div>

        {!connected ? (
          <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 px-4 py-16 text-center">
            <p className="text-sm font-semibold text-neutral-100">Connect your wallet</p>
            <p className="text-sm text-neutral-500">
              Connect to see your token holdings and the pools you launched.
            </p>
            <button
              type="button"
              onClick={() => setShowModal(true)}
              className="sc-button sc-button-primary"
            >
              Connect wallet
            </button>
          </div>
        ) : (
          <>
            <section className="sc-portfolio-overview" aria-label="Portfolio summary">
              <div>
                <span>Total portfolio value</span>
                <strong>
                  {holdingsQuery.isLoading ? (
                    '…'
                  ) : valueUnknown ? (
                    DASH
                  ) : (
                    <>
                      {formatCompactUsd(portfolioValue.total)}
                      {valuePartial && <small> (partial)</small>}
                    </>
                  )}
                </strong>
              </div>
              <div>
                <span>Tokens launched</span>
                <strong>{poolsQuery.isLoading ? '…' : created.length}</strong>
              </div>
              <div>
                <span>Tokens held</span>
                <strong>{holdingsQuery.isLoading ? '…' : holdings.length}</strong>
              </div>
            </section>

            <section className="sc-holdings-section">
              <h2>Your holdings</h2>
              <div className="sc-holdings-table-wrap">
                {holdingsQuery.isLoading ? (
                  <p>Loading…</p>
                ) : holdingsQuery.isError ? (
                  <p>Couldn&apos;t load holdings.</p>
                ) : holdings.length === 0 ? (
                  <p>No token balances in this wallet.</p>
                ) : (
                  <table className="sc-holdings-table">
                    <thead>
                      <tr>
                        <th>Token</th>
                        <th>Amount held</th>
                        <th>Avg buy price</th>
                        <th>Current price</th>
                        <th>Value</th>
                        <th>P&amp;L</th>
                        <th>Curve status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holdings.map((h) => {
                        const pool = poolsByMint.get(h.mint);
                        // Valuation only from a real indexed price on the exact
                        // matched pool. No match or no price → no number, ever.
                        const estValue =
                          pool && pool.price !== null ? h.amount * pool.price : null;
                        const progress = pool ? clampProgress(pool.progress) : null;
                        return (
                          <tr key={h.mint}>
                            <td>
                              <span className="sc-holding-mark">
                                {pool ? tokenMark(pool.baseSymbol) : '?'}
                              </span>
                              <span className="sc-holding-name">
                                {pool ? (
                                  <>
                                    <strong>{pool.baseName || pool.baseSymbol}</strong>
                                    <small>${pool.baseSymbol}</small>
                                  </>
                                ) : (
                                  <>
                                    <strong>
                                      <a
                                        href={`https://solscan.io/token/${h.mint}${isDevnet() ? '?cluster=devnet' : ''}`}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        {h.mint.slice(0, 6)}…{h.mint.slice(-6)}
                                      </a>
                                    </strong>
                                    <small>unmatched token</small>
                                  </>
                                )}
                              </span>
                            </td>
                            <td>
                              {formatCompact(h.amount)}
                              {pool ? ` ${pool.baseSymbol}` : ''}
                            </td>
                            <td>{DASH}</td>
                            <td>
                              {pool
                                ? formatPriceValue(pool.priceUsd, pool.price, pool.quoteSymbol)
                                : DASH}
                            </td>
                            <td>
                              {pool ? (
                                estValue !== null ? (
                                  <>
                                    ≈ {formatCompact(estValue)} {pool.quoteSymbol} est.
                                    {pool.stale ? ' (stale)' : ''}
                                  </>
                                ) : (
                                  'price unavailable'
                                )
                              ) : (
                                DASH
                              )}
                            </td>
                            <td>{DASH}</td>
                            <td>
                              {pool ? (
                                pool.graduated ? (
                                  'Graduated'
                                ) : progress === null ? (
                                  DASH
                                ) : (
                                  <span className="sc-holding-progress">
                                    <i style={{ width: `${progress}%` }} />
                                  </span>
                                )
                              ) : (
                                DASH
                              )}
                            </td>
                            <td>
                              {pool ? (
                                <Link
                                  className="sc-button sc-button-secondary sc-trade-link"
                                  href={`/token/${pool.poolAddress}`}
                                >
                                  Trade
                                </Link>
                              ) : (
                                DASH
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            <section className="sc-launched-section">
              <h2>Tokens you launched</h2>
              {poolsQuery.isLoading ? (
                <p>Loading…</p>
              ) : created.length === 0 ? (
                <div>
                  <p className="mb-3 text-sm text-neutral-500">
                    You haven&apos;t launched a pool from this wallet yet.
                  </p>
                  <Link href="/create-pool" className="sc-button sc-button-primary">
                    Launch a token
                  </Link>
                </div>
              ) : (
                <>
                  <div className="sc-creator-earnings-summary">
                    <div className="sc-creator-earnings-summary-head">
                      <h3>Creator earnings</h3>
                      <span>
                        Across {created.length} created coin{created.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-neutral-500">
                      Your 0.3% of every trade across the pools you launched · claimable on each
                      pool&apos;s page
                    </p>
                    {earningsLoading ? (
                      <p className="mt-3 text-sm text-neutral-500">Loading…</p>
                    ) : earningsError ? (
                      <p className="mt-3 text-sm text-neutral-500">
                        Couldn&apos;t load earnings right now.
                      </p>
                    ) : earningsByToken.length === 0 ? (
                      <p className="mt-3 text-sm text-neutral-500">
                        No fees accrued yet. You earn 0.3% of every trade once trading starts on
                        your pools.
                      </p>
                    ) : (
                      <>
                        <div className="sc-creator-earnings-summary-totals">
                          <div>
                            <span>Base-token totals</span>
                            <strong>{baseTotals}</strong>
                          </div>
                          <div>
                            <span>Quote-token totals</span>
                            <strong>{quoteTotals}</strong>
                          </div>
                        </div>
                        <div className="mt-3 grid gap-2">
                          {earningsByToken.map((e) => (
                            <div className="sc-launched-cap" key={e.mint}>
                              <span>
                                {formatEarningTotal(e)} unclaimed
                              </span>
                              <strong>
                                {e.usdTotal !== null ? (
                                  <>
                                    ≈ ${formatCompact(e.usdTotal)}
                                    {e.fiatComplete ? '' : ' (partial)'}
                                  </>
                                ) : (
                                  'fiat value unavailable'
                                )}
                              </strong>
                            </div>
                          ))}
                        </div>
                        <p className="mt-3 text-[11px] text-neutral-600">
                          Token amounts are exact on-chain accruals. Fiat estimates use real indexed
                          prices only, where available.
                        </p>
                      </>
                    )}
                  </div>

                  <div className="sc-launched-grid">
                    {created.map((p) => (
                      <article className="sc-launched-card" key={p.poolAddress}>
                        <div className="sc-launched-heading">
                          <span className="sc-holding-mark">{tokenMark(p.baseSymbol)}</span>
                          <span>
                            <strong>{p.baseName || p.baseSymbol}</strong>
                            <small>${p.baseSymbol}</small>
                          </span>
                          <i className={p.graduated ? 'graduated' : ''}>
                            {p.graduated
                              ? 'Graduated'
                              : p.progress === null
                                ? DASH
                                : `${Math.round(p.progress)}%`}
                          </i>
                        </div>
                        <div className="sc-launched-cap">
                          <span>Mcap</span>
                          <strong>
                            {formatMoneyValue(p.marketCapUsd, p.marketCap, p.quoteSymbol)}
                          </strong>
                        </div>
                        <div className="sc-launched-cap">
                          <span>Price</span>
                          <strong>
                            {formatPriceValue(p.priceUsd, p.price, p.quoteSymbol)} per token
                          </strong>
                        </div>
                        <Link
                          className="sc-button sc-button-secondary"
                          href={`/token/${p.poolAddress}`}
                        >
                          Manage
                        </Link>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>
          </>
        )}
      </main>
    </Page>
  );
}
