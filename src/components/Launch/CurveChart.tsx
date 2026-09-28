import { useMemo } from 'react';

const W = 640;
const H = 280;
const PAD_L = 8;
const PAD_R = 16;
const PAD_T = 20;
const PAD_B = 28;

/** SVG visualization of the bonding curve. Dark card, lime stroke, subtle glow. */
export function CurveChart({ prices, quoteSymbol }: { prices: number[]; quoteSymbol: string }) {
  const { points, min, max } = useMemo(() => {
    const valid = prices.filter((p) => Number.isFinite(p) && p > 0);
    if (valid.length < 2) return { points: [] as string[], min: 0, max: 0 };
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const span = max - min || 1;
    const pts = valid.map((p, i) => {
      const x = PAD_L + (i / (valid.length - 1)) * (W - PAD_L - PAD_R);
      // Log-ish normalization would flatten; linear keeps the designed shape visible.
      const y = PAD_T + (1 - (p - min) / span) * (H - PAD_T - PAD_B);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return { points: pts, min, max };
  }, [prices]);

  if (points.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-neutral-500">
        Enter at least two price points to preview the curve
      </div>
    );
  }

  const pathD = `M ${points.join(' L ')}`;
  const areaD = `${pathD} L ${points[points.length - 1].split(',')[0]},${H - PAD_B} L ${points[0].split(',')[0]},${H - PAD_B} Z`;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-56 w-full" role="img" aria-label="Bonding curve preview">
        <defs>
          <filter id="curveGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a3e635" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#a3e635" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* gridlines */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD_L}
            x2={W - PAD_R}
            y1={PAD_T + f * (H - PAD_T - PAD_B)}
            y2={PAD_T + f * (H - PAD_T - PAD_B)}
            stroke="#262626"
            strokeDasharray="4 4"
          />
        ))}

        <path d={areaD} fill="url(#curveFill)" />
        <path
          d={pathD}
          fill="none"
          stroke="#a3e635"
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
          filter="url(#curveGlow)"
        />

        {points.map((pt, i) => {
          const [x, y] = pt.split(',').map(Number);
          return (
            <g key={i}>
              <circle cx={x} cy={y} r="5" fill="#0a0a0a" stroke="#a3e635" strokeWidth="2" />
              <text x={x} y={H - 8} textAnchor="middle" fill="#737373" fontSize="10">
                P{i + 1}
              </text>
            </g>
          );
        })}

        <text x={W - PAD_R} y={PAD_T - 6} textAnchor="end" fill="#a3e635" fontSize="11" fontWeight="600">
          {formatTick(max)} {quoteSymbol}
        </text>
        <text x={PAD_L} y={H - PAD_B + 22} fill="#737373" fontSize="11">
          {formatTick(min)} {quoteSymbol} · launch
        </text>
      </svg>
    </div>
  );
}

function formatTick(v: number): string {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return Number(v.toPrecision(4)).toString();
}
