import { formatMoneyValue } from '@/components/Discover/format';
import type { TradeStats24h } from './types';

interface Props {
  stats: TradeStats24h | null;
  quoteSymbol: string;
}

function StackedBar({ buyShare }: { buyShare: number | null }) {
  // No sampled movement: render a neutral full-width bar instead of a
  // misleading 50/50 split.
  if (buyShare === null) {
    return (
      <div
        style={{
          display: 'flex',
          height: 7,
          width: '100%',
          overflow: 'hidden',
          borderRadius: 999,
          background: '#222929',
        }}
        title="No trades sampled"
      />
    );
  }
  const sellShare = 1 - buyShare;
  return (
    <div
      style={{
        display: 'flex',
        height: 7,
        width: '100%',
        overflow: 'hidden',
        borderRadius: 999,
        background: '#222929',
      }}
    >
      <div
        style={{ height: '100%', background: '#32f27b', width: `${buyShare * 100}%` }}
        title={`${(buyShare * 100).toFixed(1)}% buys`}
      />
      <div
        style={{ height: '100%', background: '#fa6d74', width: `${sellShare * 100}%` }}
        title={`${(sellShare * 100).toFixed(1)}% sells`}
      />
    </div>
  );
}

/**
 * Compact 24h buy/sell stats with green/red stacked comparison bars.
 * Direction is inferred from indexed quote-reserve movement, not
 * per-trade data, always labeled an estimate, and hidden entirely when
 * the history is too thin to be honest about (stats === null).
 */
export default function TradeStats({ stats, quoteSymbol }: Props) {
  if (!stats) return null;

  const totalMoves = stats.buys + stats.sells;
  const totalVolume = stats.buyVolume + stats.sellVolume;
  const buyMoveShare = totalMoves > 0 ? stats.buys / totalMoves : null;
  const buyVolShare = totalVolume > 0 ? stats.buyVolume / totalVolume : null;

  return (
    <section className="sc-position-card" aria-label="Buys versus sells">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span className="sc-trade-card-label" style={{ marginBottom: 0 }}>
          Buys vs sells
        </span>
        <span
          style={{ fontSize: 10, color: '#737d76' }}
          title="Inferred from quote-reserve movement between indexer samples, not individual trades"
        >
          24h · estimated
        </span>
      </div>

      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 13,
              marginBottom: 6,
              fontFamily: 'var(--sc-number)',
            }}
          >
            <span style={{ color: '#3deb80' }}>
              {stats.buys.toLocaleString('en-US')} buys
            </span>
            <span style={{ color: '#f05f67' }}>
              {stats.sells.toLocaleString('en-US')} sells
            </span>
          </div>
          <StackedBar buyShare={buyMoveShare} />
          <p style={{ margin: '4px 0 0', fontSize: 10, color: '#5f6a60' }}>Buy/sell moves</p>
        </div>

        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 13,
              marginBottom: 6,
              fontFamily: 'var(--sc-number)',
            }}
          >
            <span style={{ color: '#3deb80' }}>
              {formatMoneyValue(null, stats.buyVolume, quoteSymbol)}
            </span>
            <span style={{ color: '#f05f67' }}>
              {formatMoneyValue(null, stats.sellVolume, quoteSymbol)}
            </span>
          </div>
          <StackedBar buyShare={buyVolShare} />
          <p style={{ margin: '4px 0 0', fontSize: 10, color: '#5f6a60' }}>Buy/sell volume</p>
        </div>
      </div>

      {totalMoves === 0 && (
        <p style={{ margin: '12px 0 0', fontSize: 12, color: '#77817b' }}>
          No reserve movement sampled in the last 24h.
        </p>
      )}
    </section>
  );
}
