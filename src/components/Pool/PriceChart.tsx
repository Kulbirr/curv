import { useMemo, useState } from 'react';
import { usePoolHistory } from './usePoolData';
import type { HistoryPoint } from './types';

const W = 800;
const H = 300;
const PAD_L = 10;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 26;

type RangeId = '1H' | '24H' | '7D' | '30D' | 'ALL';

/**
 * Real chart ranges. The history API caps windows at 30 days, so ALL covers
 * the full 30-day window the API can serve.
 */
const RANGES: { id: RangeId; ms: number; points: number }[] = [
  { id: '1H', ms: 60 * 60 * 1000, points: 120 },
  { id: '24H', ms: 24 * 60 * 60 * 1000, points: 300 },
  { id: '7D', ms: 7 * 24 * 60 * 60 * 1000, points: 420 },
  { id: '30D', ms: 30 * 24 * 60 * 60 * 1000, points: 600 },
  { id: 'ALL', ms: 30 * 24 * 60 * 60 * 1000, points: 1000 },
];

/** Split points into segments, breaking the line across data gaps. */
function toSegments(points: HistoryPoint[]): HistoryPoint[][] {
  if (points.length === 0) return [];
  if (points.length < 3) return [points];
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i].t - points[i - 1].t);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const threshold = median * 3;

  const segments: HistoryPoint[][] = [];
  let current: HistoryPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].t - points[i - 1].t > threshold) {
      segments.push(current);
      current = [];
    }
    current.push(points[i]);
  }
  if (current.length > 0) segments.push(current);
  return segments.filter((s) => s.length > 0);
}

function formatAxisPrice(v: number): string {
  return Number(v.toPrecision(4)).toString();
}

function formatAxisTime(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function ChartHead({
  range,
  onRange,
}: {
  range: RangeId;
  onRange: (r: RangeId) => void;
}) {
  return (
    <div className="sc-pool-section-head">
      <h2>Price chart</h2>
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
}

export default function PriceChart({ poolAddress, quoteSymbol }: Props) {
  const [range, setRange] = useState<RangeId>('24H');
  const rangeDef = RANGES.find((r) => r.id === range) ?? RANGES[1];
  // Fixed once per range selection; the query key stays stable while polling.
  const from = useMemo(() => Date.now() - rangeDef.ms, [rangeDef]);
  const historyQuery = usePoolHistory(poolAddress, rangeDef.points, from);

  const points = historyQuery.data?.points ?? [];
  const complete = historyQuery.data?.complete ?? false;
  const isLoading = historyQuery.isLoading;

  const model = useMemo(() => {
    if (points.length === 0) return null;
    const prices = points.map((p) => p.price);
    let min = Math.min(...prices);
    let max = Math.max(...prices);
    if (min === max) {
      min = min * 0.999;
      max = max * 1.001;
    }
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const tSpan = Math.max(1, t1 - t0);

    const x = (t: number) => PAD_L + ((t - t0) / tSpan) * (W - PAD_L - PAD_R);
    const y = (p: number) => PAD_T + (1 - (p - min) / (max - min)) * (H - PAD_T - PAD_B);

    const segments = toSegments(points).map((seg) =>
      seg.map((p) => ({ x: x(p.t), y: y(p.price) }))
    );
    const segStrings = segments.map((seg) =>
      seg.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ')
    );

    const yTicks = [0, 1 / 3, 2 / 3, 1].map((f) => {
      const v = min + (max - min) * f;
      return { v, y: y(v) };
    });
    const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const t = t0 + tSpan * f;
      return { t, x: x(t) };
    });

    const last = points[points.length - 1];
    const baseY = (H - PAD_B).toFixed(1);
    // Area fill under the longest segment.
    const longest = segments.reduce((a, b) => (b.length > a.length ? b : a), segments[0]);
    const areaPath =
      `M ${longest[0].x.toFixed(1)},${baseY} ` +
      longest.map((pt) => `L ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ') +
      ` L ${longest[longest.length - 1].x.toFixed(1)},${baseY} Z`;

    return { segStrings, yTicks, xTicks, last, x: x(last.t), y: y(last.price), areaPath };
  }, [points]);

  if (isLoading && points.length === 0) {
    return (
      <section className="sc-pool-chart-card" aria-label="Price chart">
        <ChartHead range={range} onRange={setRange} />
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
        <ChartHead range={range} onRange={setRange} />
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
          <p style={{ margin: 0, fontSize: 9, color: '#77817b', maxWidth: 260 }}>
            Price history is being recorded. Check back soon.
          </p>
        </div>
      </section>
    );
  }

  const up = model.last.price >= points[0].price;
  const lineColor = up ? '#32f27b' : '#fa6d74';

  return (
    <section className="sc-pool-chart-card" aria-label="Price chart">
      <ChartHead range={range} onRange={setRange} />
      <div className="sc-pool-chart-wrap">
        <div className="sc-chart-y-axis" aria-hidden="true">
          {[...model.yTicks].reverse().map((tick, i) => (
            <span key={i}>{formatAxisPrice(tick.v)}</span>
          ))}
        </div>
        <svg
          className="sc-pool-price-chart"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Price chart in ${quoteSymbol}`}
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

          <circle
            cx={model.x}
            cy={model.y}
            r="4"
            className="sc-pool-price-point"
            style={{ fill: lineColor }}
          />
        </svg>
      </div>
      <div className="sc-chart-time-labels" aria-hidden="true">
        {model.xTicks.map((tick, i) => (
          <span key={i}>{formatAxisTime(tick.t)}</span>
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
