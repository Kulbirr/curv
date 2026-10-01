import { useMemo, useRef, useState } from 'react';
import { usePoolHistory } from './usePoolData';
import type { HistoryPoint } from './types';
import {
  formatFullValue,
  formatMcapAxis,
  formatPriceAxis,
} from './chartFormat';

const W = 800;
const H = 300;
const PAD_L = 10;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 26;

type RangeId = '1H' | '24H' | '7D' | '30D' | 'ALL';
type Mode = 'price' | 'mcap';

/**
 * Real chart ranges. The history API caps windows at 30 days, so ALL covers
 * the full 30-day window the API can serve.
 */
const EMPTY_POINTS: never[] = [];
const RANGES: { id: RangeId; ms: number; points: number }[] = [
  { id: '1H', ms: 60 * 60 * 1000, points: 120 },
  { id: '24H', ms: 24 * 60 * 60 * 1000, points: 300 },
  { id: '7D', ms: 7 * 24 * 60 * 60 * 1000, points: 420 },
  { id: '30D', ms: 30 * 24 * 60 * 60 * 1000, points: 600 },
  { id: 'ALL', ms: 30 * 24 * 60 * 60 * 1000, points: 1000 },
];

/** Split points into segments, breaking the line across data gaps. */
function toSegments<T>(items: { t: number; v: number }[]): { t: number; v: number }[][] {
  if (items.length === 0) return [];
  if (items.length < 3) return [items];
  const gaps: number[] = [];
  for (let i = 1; i < items.length; i++) gaps.push(items[i].t - items[i - 1].t);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const threshold = median * 3;

  const segments: { t: number; v: number }[][] = [];
  let current: { t: number; v: number }[] = [items[0]];
  for (let i = 1; i < items.length; i++) {
    if (items[i].t - items[i - 1].t > threshold) {
      segments.push(current);
      current = [];
    }
    current.push(items[i]);
  }
  if (current.length > 0) segments.push(current);
  return segments.filter((s) => s.length > 0);
}

/** Y-axis tick label: adaptive decimals for price, adaptive compact for market cap. */
function formatAxisValue(v: number, mode: Mode, span: number, maxV: number): string {
  if (mode === 'mcap') return formatMcapAxis(v, span, maxV);
  return formatPriceAxis(v, span);
}

function formatAxisTime(t: number, range: RangeId): string {
  const d = new Date(t);
  if (range === '1H' || range === '24H') {
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTooltipTime(t: number): string {
  const d = new Date(t);
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  );
}

function ChartHead({
  range,
  onRange,
  mode,
}: {
  range: RangeId;
  onRange: (r: RangeId) => void;
  mode: Mode;
}) {
  return (
    <div className="sc-pool-section-head">
      <h2>{mode === 'price' ? 'Price chart' : 'Market cap chart'}</h2>
      <div className="sc-chart-range" aria-label="Chart timeframe">
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={range === r.id}
            className={range === r.id ? 'selected' : ''}
            onClick={() => onRange(r.id)}
          >
            {r.id}
          </button>
        ))}
      </div>
    </div>
  );
}

interface Props {
  poolAddress: string;
  quoteSymbol: string;
  /** Base-token total supply; null hides the market-cap mode. */
  supply: number | null;
}

export default function PriceChart({ poolAddress, quoteSymbol, supply }: Props) {
  const [range, setRange] = useState<RangeId>('24H');
  const [mode, setMode] = useState<Mode>('price');
  const [hover, setHover] = useState<number | null>(null);
  const svgWrapRef = useRef<HTMLDivElement>(null);

  const rangeDef = RANGES.find((r) => r.id === range) ?? RANGES[1];
  // Fixed once per range selection; the query key stays stable while polling.
  const from = useMemo(() => Date.now() - rangeDef.ms, [rangeDef]);
  const historyQuery = usePoolHistory(poolAddress, rangeDef.points, from);

  // Module-level empty array: `?? []` would create a new reference every
  // render and churn the useMemo below that depends on `points`.
  const points = historyQuery.data?.points ?? EMPTY_POINTS;
  const complete = historyQuery.data?.complete ?? false;
  const isLoading = historyQuery.isLoading;

  const effectiveMode: Mode = mode === 'mcap' && supply ? 'mcap' : 'price';

  const model = useMemo(() => {
    if (points.length === 0) return null;
    const items = points.map((p) => ({
      t: p.t,
      v: effectiveMode === 'mcap' && supply ? p.price * supply : p.price,
    }));
    const values = items.map((i) => i.v);
    let min = Math.min(...values);
    let max = Math.max(...values);
    const dataMax = max;
    if (min === max) {
      min = min * 0.999;
      max = max * 1.001;
    }
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
    const span = max - min;
    const t0 = items[0].t;
    const t1 = items[items.length - 1].t;
    const tSpan = Math.max(1, t1 - t0);

    const x = (t: number) => PAD_L + ((t - t0) / tSpan) * (W - PAD_L - PAD_R);
    const y = (v: number) => PAD_T + (1 - (v - min) / span) * (H - PAD_T - PAD_B);

    const segments = toSegments(items).map((seg) =>
      seg.map((p) => ({ x: x(p.t), y: y(p.v), t: p.t, v: p.v }))
    );
    const segStrings = segments.map((seg) =>
      seg.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ')
    );

    const yTicks = [0, 1 / 3, 2 / 3, 1].map((f) => {
      const v = min + span * f;
      return { v, y: y(v), label: formatAxisValue(v, effectiveMode, span, dataMax) };
    });
    const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const t = t0 + tSpan * f;
      return { t, x: x(t) };
    });

    const last = items[items.length - 1];
    const first = items[0];
    const baseY = (H - PAD_B).toFixed(1);
    // Area fill under the longest segment.
    const longest = segments.reduce((a, b) => (b.length > a.length ? b : a), segments[0]);
    const areaPath =
      `M ${longest[0].x.toFixed(1)},${baseY} ` +
      longest.map((pt) => `L ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ') +
      ` L ${longest[longest.length - 1].x.toFixed(1)},${baseY} Z`;

    const changePct =
      first.v !== 0 ? ((last.v - first.v) / Math.abs(first.v)) * 100 : 0;

    return {
      segStrings,
      yTicks,
      xTicks,
      last,
      first,
      changePct,
      up: last.v >= first.v,
      x: x(last.t),
      y: y(last.v),
      areaPath,
      items,
      yOf: y,
      xOf: x,
      t0,
      tSpan,
    };
  }, [points, effectiveMode, supply]);

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!model || model.items.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(frac * (model.items.length - 1));
    setHover(Math.max(0, Math.min(model.items.length - 1, idx)));
  };

  if (isLoading && points.length === 0) {
    return (
      <section className="sc-pool-chart-card" aria-label="Price chart">
        <ChartHead range={range} onRange={setRange} mode={effectiveMode} />
        <div
          className="sc-pool-chart-wrap"
          style={{ alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            className="animate-spin"
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              border: '2px solid #2a3134',
              borderTopColor: '#32f27b',
            }}
          />
        </div>
      </section>
    );
  }

  if (!model) {
    return (
      <section className="sc-pool-chart-card" aria-label="Price chart">
        <ChartHead range={range} onRange={setRange} mode={effectiveMode} />
        <div
          className="sc-pool-chart-wrap"
          style={{
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            textAlign: 'center',
          }}
        >
          <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: '#dfe5dc' }}>
            No price history yet
          </p>
          <p style={{ margin: 0, fontSize: 12, color: '#77817b', maxWidth: 260 }}>
            Price history is being recorded. Check back soon.
          </p>
        </div>
      </section>
    );
  }

  const lineColor = model.up ? '#32f27b' : '#fa6d74';
  const hoverItem = hover !== null ? model.items[hover] : null;
  const hoverX = hoverItem ? model.xOf(hoverItem.t) : 0;
  const hoverY = hoverItem ? model.yOf(hoverItem.v) : 0;
  const hoverFrac = hoverX / W;

  return (
    <section className="sc-pool-chart-card" aria-label="Price chart">
      <ChartHead range={range} onRange={setRange} mode={effectiveMode} />
      <div className="sc-chart-stats">
        <strong className={model.up ? 'sc-green-text' : 'sc-red-text'}>
          {formatFullValue(model.last.v, effectiveMode)}{' '}
          <span className="sc-chart-stats-unit">{quoteSymbol}</span>
        </strong>
        <span
          className={
            model.changePct > 0
              ? 'sc-chart-change sc-green-text'
              : model.changePct < 0
                ? 'sc-chart-change sc-red-text'
                : 'sc-chart-change'
          }
        >
          {model.changePct > 0 ? '+' : ''}
          {model.changePct.toFixed(2)}%
        </span>
        {supply && (
          <div
            className="sc-chart-range sc-chart-mode"
            role="group"
            aria-label="Chart value"
          >
            {(['price', 'mcap'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={effectiveMode === m}
                className={effectiveMode === m ? 'selected' : ''}
                onClick={() => setMode(m)}
              >
                {m === 'price' ? 'Price' : 'MC'}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="sc-pool-chart-wrap">
        <div className="sc-chart-y-axis" aria-hidden="true">
          {[...model.yTicks].reverse().map((tick, i) => (
            <span key={i}>{tick.label}</span>
          ))}
        </div>
        <div className="sc-chart-svg-wrap" ref={svgWrapRef}>
          <svg
            className="sc-pool-price-chart"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${effectiveMode === 'price' ? 'Price' : 'Market cap'} chart in ${quoteSymbol}`}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
            style={{ touchAction: 'pan-y' }}
          >
            <defs>
              <linearGradient id="sc-pool-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lineColor} stopOpacity="0.22" />
                <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
              </linearGradient>
            </defs>

            {model.yTicks.map((tick, i) => (
              <line
                key={i}
                x1={PAD_L}
                x2={W - PAD_R}
                y1={tick.y}
                y2={tick.y}
                className="sc-pool-grid-line"
              />
            ))}

            <path d={model.areaPath} fill="url(#sc-pool-fill)" />

            {model.segStrings.map((seg, i) => (
              <polyline
                key={i}
                points={seg}
                className="sc-pool-price-line"
                style={{ stroke: lineColor }}
              />
            ))}

            {hoverItem && (
              <g className="sc-chart-crosshair" aria-hidden="true">
                <line
                  x1={hoverX}
                  x2={hoverX}
                  y1={PAD_T}
                  y2={H - PAD_B}
                  stroke="#4a5450"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={hoverX}
                  cy={hoverY}
                  r="5"
                  fill={lineColor}
                  stroke="#0c1010"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )}

            {!hoverItem && (
              <circle
                cx={model.x}
                cy={model.y}
                r="4"
                className="sc-pool-price-point"
                style={{ fill: lineColor }}
              />
            )}
          </svg>
          {hoverItem && (
            <div
              className="sc-chart-tooltip"
              style={{
                left: `${Math.min(92, Math.max(0, hoverFrac * 100))}%`,
                transform: hoverFrac > 0.62 ? 'translateX(-100%)' : 'translateX(8%)',
              }}
            >
              <strong>
                {formatFullValue(hoverItem.v, effectiveMode)} {quoteSymbol}
              </strong>
              <span>{formatTooltipTime(hoverItem.t)}</span>
            </div>
          )}
        </div>
      </div>
      <div className="sc-chart-time-labels" aria-hidden="true">
        {model.xTicks.map((tick, i) => (
          <span key={i}>{formatAxisTime(tick.t, range)}</span>
        ))}
      </div>
      {!complete && (
        <p className="sc-chart-hint" style={{ marginTop: 6 }}>
          Gaps in the line are periods where the indexer was not running. No
          data was invented to fill them.
        </p>
      )}
    </section>
  );
}
