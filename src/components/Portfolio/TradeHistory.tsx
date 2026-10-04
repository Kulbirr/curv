import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface PoolSummary {
  poolAddress: string;
  baseSymbol: string | null;
  baseMint: string | null;
  quoteSymbol: string | null;
  baseDecimals: number | null;
  quoteDecimals: number | null;
  totalBoughtBaseRaw: string;
  totalBoughtQuoteRaw: string;
  totalSoldBaseRaw: string;
  totalSoldQuoteRaw: string;
  tradeCount: number;
}

interface DetailTrade {
  id: number;
  side: 'buy' | 'sell';
  baseAmountRaw: string;
  quoteAmountRaw: string;
  price: string | null;
  txSignature: string;
  tradedAt: number;
}

function formatRaw(raw: string, decimals: number | null): string {
  try {
    const d = decimals ?? 9;
    const v = Number(BigInt(raw)) / 10 ** d;
    if (!Number.isFinite(v)) return '0';
    return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  } catch {
    return '0';
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/** Human price with meaningful precision: tiny prices keep their decimals instead of rounding to zero. */
function formatPrice(p: string | null): string {
  if (!p) return 'n/a';
  const v = Number(p);
  if (!Number.isFinite(v) || v <= 0) return 'n/a';
  let s: string;
  if (v >= 100) s = v.toFixed(2);
  else if (v >= 1) s = v.toFixed(4);
  else if (v >= 0.01) s = v.toFixed(6);
  else s = v.toFixed(10);
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function DetailTrades({ wallet, poolAddress, baseDecimals }: { wallet: string; poolAddress: string; baseDecimals: number | null }) {
  const [cursor, setCursor] = useState<number | null>(null);
  const [all, setAll] = useState<DetailTrade[]>([]);
  const q = useQuery({
    queryKey: ['trade-detail', wallet, poolAddress, cursor],
    queryFn: async () => {
      const p = new URLSearchParams({ view: 'detail', poolAddress, limit: '25' });
      if (cursor) p.set('beforeId', String(cursor));
      const res = await fetch(`/api/wallet/${wallet}/trades?${p.toString()}`);
      if (!res.ok) throw new Error('Failed to load trades');
      return (await res.json()) as { trades: DetailTrade[]; nextCursor: number | null };
    },
  });
  // Accumulate pages.
  const trades = q.data ? [...all, ...q.data.trades.filter((t) => !all.some((a) => a.id === t.id))] : all;

  return (
    <div className="sc-trade-detail">
      {q.isLoading && all.length === 0 ? (
        <p className="sc-trade-detail-loading">Loading trades…</p>
      ) : trades.length === 0 ? (
        <p className="sc-trade-detail-empty">No individual trades found.</p>
      ) : (
        <>
          <div className="sc-trade-detail-table-wrap">
          <table className="sc-trade-detail-table">
            <thead>
              <tr>
                <th>Side</th>
                <th>Amount</th>
                <th>Price</th>
                <th>Time</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span className={`sc-trade-side sc-trade-side-${t.side}`}>{t.side}</span>
                  </td>
                  <td className={t.side === 'buy' ? 'sc-trade-amount-buy' : 'sc-trade-amount-sell'}>
                    {t.side === 'buy' ? '+' : '-'}{formatRaw(t.baseAmountRaw, baseDecimals)}
                  </td>
                  <td>{formatPrice(t.price)}</td>
                  <td>{formatTime(t.tradedAt)}</td>
                  <td>
                    <a
                      href={`https://solscan.io/tx/${t.txSignature}`}
                      target="_blank"
                      rel="noreferrer"
                      className="sc-trade-tx"
                    >
                      {t.txSignature.slice(0, 6)}…
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {q.data?.nextCursor && (
            <button
              type="button"
              className="sc-button sc-button-secondary sc-trade-more"
              disabled={q.isFetching}
              onClick={() => {
                setAll(trades);
                setCursor(q.data.nextCursor);
              }}
            >
              {q.isFetching ? 'Loading…' : 'Show more'}
            </button>
          )}
        </>
      )}
      {q.isError && <p className="sc-trade-detail-error">Could not load trades.</p>}
    </div>
  );
}

export default function TradeHistory({ wallet }: { wallet: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['trade-summary', wallet],
    queryFn: async () => {
      const res = await fetch(`/api/wallet/${wallet}/trades?view=summary`);
      if (!res.ok) throw new Error('Failed to load history');
      return (await res.json()) as { summaries: PoolSummary[] };
    },
    enabled: !!wallet,
  });

  const summaries = q.data?.summaries ?? [];

  return (
    <section className="sc-trade-history" aria-label="Trade history">
      <h2 className="sc-trade-history-title">Trade history</h2>
      {q.isLoading ? (
        <p className="sc-trade-history-loading">Loading your trades…</p>
      ) : q.isError ? (
        <p className="sc-trade-history-error">Could not load trade history.</p>
      ) : summaries.length === 0 ? (
        <div className="sc-empty-portfolio">
          <p className="sc-empty-title">No trades yet.</p>
          <p className="sc-empty-sub">Your buys and sells on Curv will appear here.</p>
        </div>
      ) : (
        <div className="sc-trade-history-list">
          {summaries.map((s) => {
            const isOpen = expanded === s.poolAddress;
            const netBase = (() => {
              try {
                return BigInt(s.totalBoughtBaseRaw) - BigInt(s.totalSoldBaseRaw);
              } catch {
                return BigInt(0);
              }
            })();
            return (
              <div key={s.poolAddress} className="sc-trade-coin">
                <button
                  type="button"
                  className="sc-trade-coin-head"
                  onClick={() => setExpanded(isOpen ? null : s.poolAddress)}
                  aria-expanded={isOpen}
                >
                  <span className="sc-holding-mark">
                    {(s.baseSymbol?.charAt(0) || '?').toUpperCase()}
                  </span>
                  <span className="sc-trade-coin-name">
                    <strong>{s.baseSymbol ?? 'Unknown'}</strong>
                    <small>{s.tradeCount} trade{s.tradeCount === 1 ? '' : 's'}</small>
                  </span>
                  <span className="sc-trade-coin-stats">
                    <span className="sc-trade-stat">
                      <small>Bought</small>
                      <strong className="buy">{formatRaw(s.totalBoughtBaseRaw, s.baseDecimals)}</strong>
                    </span>
                    <span className="sc-trade-stat">
                      <small>Sold</small>
                      <strong className="sell">{formatRaw(s.totalSoldBaseRaw, s.baseDecimals)}</strong>
                    </span>
                    <span className="sc-trade-stat">
                      <small>Holding</small>
                      <strong>
                        {netBase > BigInt(0)
                          ? formatRaw(netBase.toString(), s.baseDecimals)
                          : '0'}
                      </strong>
                    </span>
                  </span>
                  <span className={`sc-trade-chevron ${isOpen ? 'open' : ''}`} aria-hidden="true">▾</span>
                </button>
                {isOpen && <DetailTrades wallet={wallet} poolAddress={s.poolAddress} baseDecimals={s.baseDecimals} />}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
