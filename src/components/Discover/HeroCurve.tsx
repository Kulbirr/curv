import { quickTierById, quickTierDisplayPrices } from '@/lib/launch-tiers'

/**
 * Hero chart card: the Curv Quick curve at the default balanced tier,
 * drawn from the real tier multipliers ([1, 1.8, 4, 7] across the supply)
 * with log-space interpolation between the segment anchors. It is a model
 * illustration, labeled MODEL, not live market data.
 */

/** Balanced-tier display ladder: the shape every Quick launch starts with. */
const HERO_MULTIPLIERS = quickTierDisplayPrices(1, quickTierById('balanced'))

const W = 560
const H = 330
const LEFT = 36
const RIGHT = 548
const TOP = 26
const BOTTOM = 288

function pointAt(fraction: number): { x: number; y: number } {
  const anchors = HERO_MULTIPLIERS.map((m, i) => ({
    f: i / (HERO_MULTIPLIERS.length - 1),
    log: Math.log(m),
  }))
  const maxLog = anchors[anchors.length - 1].log
  let a = anchors[0]
  let b = anchors[anchors.length - 1]
  for (let s = 0; s < anchors.length - 1; s++) {
    if (fraction >= anchors[s].f && fraction <= anchors[s + 1].f) {
      a = anchors[s]
      b = anchors[s + 1]
      break
    }
  }
  const t = b.f === a.f ? 0 : (fraction - a.f) / (b.f - a.f)
  const log = a.log + (b.log - a.log) * t
  const n = maxLog === 0 ? 0 : log / maxLog
  return {
    x: LEFT + fraction * (RIGHT - LEFT),
    y: BOTTOM - n * (BOTTOM - TOP),
  }
}

const SAMPLES = 48
const POINTS = Array.from({ length: SAMPLES + 1 }, (_, i) => pointAt(i / SAMPLES))
const LINE = POINTS.map(
  (p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`
).join(' ')
const AREA = `${LINE} L${RIGHT},${BOTTOM} L${LEFT},${BOTTOM} Z`
const MARKER = pointAt(0.8)

export default function HeroCurve() {
  return (
    <div className="sc-hero-chart" aria-hidden="true">
      <div className="sc-hero-chart-head">
        <span>THE CURVE, YOURS</span>
        <span className="sc-hero-model">
          <i />
          MODEL
        </span>
      </div>
      <div className="sc-hero-chart-body">
        <span className="sc-hero-axis-y">TOKEN PRICE</span>
        <svg viewBox={`0 0 ${W} ${H}`} role="presentation">
          <defs>
            <linearGradient id="scHeroStroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#2ea35f" />
              <stop offset="55%" stopColor="#32f27b" />
              <stop offset="100%" stopColor="#b4ff4f" />
            </linearGradient>
            <linearGradient id="scHeroFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#32f27b" stopOpacity="0.20" />
              <stop offset="100%" stopColor="#32f27b" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="scHeroAxis" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#32f27b" stopOpacity="0.05" />
              <stop offset="100%" stopColor="#32f27b" stopOpacity="0.65" />
            </linearGradient>
          </defs>
          {/* grid */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={`v${f}`}
              x1={LEFT + f * (RIGHT - LEFT)}
              y1={TOP - 8}
              x2={LEFT + f * (RIGHT - LEFT)}
              y2={BOTTOM}
              stroke="rgb(255 255 255 / 0.05)"
              strokeWidth="1"
            />
          ))}
          {[0.33, 0.66].map((f) => (
            <line
              key={`h${f}`}
              x1={LEFT}
              y1={TOP + f * (BOTTOM - TOP)}
              x2={RIGHT}
              y2={TOP + f * (BOTTOM - TOP)}
              stroke="rgb(255 255 255 / 0.05)"
              strokeWidth="1"
            />
          ))}
          <path d={AREA} fill="url(#scHeroFill)" />
          <path
            d={LINE}
            fill="none"
            stroke="url(#scHeroStroke)"
            strokeWidth="2.4"
            strokeLinecap="round"
            className="sc-hero-curve-line"
          />
          <circle cx={MARKER.x} cy={MARKER.y} r="11" className="sc-hero-marker-halo" />
          <circle cx={MARKER.x} cy={MARKER.y} r="5" className="sc-hero-marker-dot" />
          {/* supply axis */}
          <line
            x1={LEFT}
            y1={BOTTOM + 16}
            x2={RIGHT}
            y2={BOTTOM + 16}
            stroke="url(#scHeroAxis)"
            strokeWidth="2"
          />
        </svg>
        <div
          className="sc-hero-chip"
          style={{
            left: `${(MARKER.x / W) * 100}%`,
            top: `${(MARKER.y / H) * 100}%`,
          }}
        >
          <span>PRICE</span>
          <strong>Set by the curve</strong>
        </div>
      </div>
      <div className="sc-hero-chart-foot">
        <span>EARLY</span>
        <span className="sc-hero-growth">
          SUPPLY
          <br />
          GROWTH
        </span>
      </div>
    </div>
  )
}
