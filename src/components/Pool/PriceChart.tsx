import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { HistoryPoint } from './types';

const W = 800;
const H = 300;
const PAD_L = 64;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 32;

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

interface Props {
  points: HistoryPoint[];
  complete: boolean;
  isLoading: boolean;
  quoteSymbol: string;
}

export default function PriceChart({ points, complete, isLoading, quoteSymbol }: Props) {
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

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
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
      <div className="flex h-[300px] items-center justify-center rounded-2xl border border-neutral-800/60 bg-neutral-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-primary" />
      </div>
    );
  }

  if (!model) {
    return (
      <div className="flex h-[300px] flex-col items-center justify-center gap-2 rounded-2xl border border-neutral-800/60 bg-neutral-950 text-center">
        <p className="text-sm font-medium text-neutral-200">No price history yet</p>
        <p className="max-w-xs text-sm text-neutral-500">
          Price history is being recorded — check back soon.
        </p>
      </div>
    );
  }

  const up = model.last.price >= points[0].price;
  const lineColor = up ? '#34d399' : '#fb7185';

  return (
    <div className="rounded-2xl border border-neutral-800/60 bg-neutral-950 p-2">
      <div className="mb-1 flex items-center justify-between px-2 pt-1">
        <span className="text-xs text-neutral-500">
          Price <span className="text-neutral-400">({quoteSymbol})</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs text-neutral-500">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          live
          {!complete && <span className="text-amber-400/90">· partial history</span>}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[280px] w-full" role="img" aria-label="Price chart">
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
          </linearGradient>
        </defs>

        {model.yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={tick.y}
              y2={tick.y}
              stroke="#1f2937"
              strokeWidth="1"
              strokeDasharray="3 4"
            />
            <text x={PAD_L - 8} y={tick.y + 4} textAnchor="end" fontSize="11" fill="#6b7280" className="tabular-nums">
              {formatAxisPrice(tick.v)}
            </text>
          </g>
        ))}
        {model.xTicks.map((tick, i) => (
          <text
            key={i}
            x={tick.x}
            y={H - 10}
            textAnchor="middle"
            fontSize="11"
            fill="#6b7280"
            className="tabular-nums"
          >
            {formatAxisTime(tick.t)}
          </text>
        ))}

        {model.areaPath && <path d={model.areaPath} fill="url(#chartFill)" />}

        {model.segStrings.map((seg, i) => (
          <polyline
            key={i}
            points={seg}
            fill="none"
            stroke={lineColor}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        <circle cx={model.x} cy={model.y} r="4" fill={lineColor} stroke="#05070a" strokeWidth="2" />
      </svg>
      {!complete && (
        <p className={cn('px-3 pb-2 text-xs text-neutral-500')}>
          Gaps in the line are periods where the indexer wasn&apos;t running — no data was invented to fill them.
        </p>
      )}
    </div>
  );
}
