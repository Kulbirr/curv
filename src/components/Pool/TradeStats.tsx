import { cn } from '@/lib/utils';
import { formatMoneyValue } from '@/components/Discover/format';
import type { TradeStats24h } from './types';

interface Props {
  stats: TradeStats24h | null;
  quoteSymbol: string;
}

function StackedBar({ buyShare }: { buyShare: number }) {
  const sellShare = 1 - buyShare;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-neutral-800">
      <div
        className="h-full bg-emerald-500 transition-[width]"
        style={{ width: `${buyShare * 100}%` }}
        title={`${(buyShare * 100).toFixed(1)}% buys`}
      />
      <div
        className="h-full bg-rose-500 transition-[width]"
        style={{ width: `${sellShare * 100}%` }}
        title={`${(sellShare * 100).toFixed(1)}% sells`}
      />
    </div>
  );
}

/**
 * Compact 24h buy/sell stats with green/red stacked comparison bars.
 * Direction is inferred from indexed quote-reserve movement, not
 * per-trade data — always labeled an estimate, and hidden entirely when
 * the history is too thin to be honest about (stats === null).
 */
export default function TradeStats({ stats, quoteSymbol }: Props) {
  if (!stats) return null;

  const totalMoves = stats.buys + stats.sells;
  const totalVolume = stats.buyVolume + stats.sellVolume;
  const buyMoveShare = totalMoves > 0 ? stats.buys / totalMoves : 0.5;
  const buyVolShare = totalVolume > 0 ? stats.buyVolume / totalVolume : 0.5;

  return (
    <div className="rounded-2xl border border-neutral-800/60 bg-neutral-950 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">Buys vs sells</h2>
        <span
          className="text-[11px] text-neutral-500"
          title="Inferred from quote-reserve movement between indexer samples, not individual trades"
        >
          24h · estimated
        </span>
      </div>

      <div className="space-y-4">
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium text-emerald-400 tabular-nums">
              {stats.buys.toLocaleString('en-US')} buys
            </span>
            <span className="font-medium text-rose-400 tabular-nums">
              {stats.sells.toLocaleString('en-US')} sells
            </span>
          </div>
          <StackedBar buyShare={buyMoveShare} />
          <p className="mt-1 text-[11px] text-neutral-600">Buy/sell moves</p>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium text-emerald-400 tabular-nums">
              {formatMoneyValue(null, stats.buyVolume, quoteSymbol)}
            </span>
            <span className="font-medium text-rose-400 tabular-nums">
              {formatMoneyValue(null, stats.sellVolume, quoteSymbol)}
            </span>
          </div>
          <StackedBar buyShare={buyVolShare} />
          <p className="mt-1 text-[11px] text-neutral-600">Buy/sell volume</p>
        </div>
      </div>

      {totalMoves === 0 && (
        <p className={cn('mt-3 text-xs text-neutral-500')}>
          No reserve movement sampled in the last 24h.
        </p>
      )}
    </div>
  );
}
