import { ImageResponse } from 'next/og';

/**
 * GET /api/og/pool/[address]
 *
 * The share card for a token page: a 1200x630 PNG rendered from the same
 * indexed state the site itself shows, so a card never claims a number
 * the token page would not. Missing data renders as absence, never as
 * an invented figure: no sparkline under 2 samples, no change chip
 * without a 24h comparison.
 *
 * Pages API routes that return a Response must run on the edge
 * runtime, which cannot reach the database directly. The data comes
 * from this app's own JSON APIs instead (pool state plus the cached
 * pool list for the 24h change and sparkline), both of which are
 * already the public, indexed view of the pool.
 */

export const config = { runtime: 'edge' };

const WIDTH = 1200;
const HEIGHT = 630;

const BG = '#0a0e0c';
const PANEL = '#101613';
const LINE = '#223028';
const TEXT = '#eef2eb';
const MUTED = '#8b968d';
const GREEN = '#32f27b';
const ROSE = '#fb7185';

interface StateBody {
  baseName: string;
  baseSymbol: string;
  quoteSymbol: string;
  imageUrl: string | null;
  price: number | null;
  marketCap: number | null;
  marketCapUsd: number | null;
  progress: number | null;
  graduated: boolean;
  usdReference: boolean;
}

interface ListPool {
  poolAddress: string;
  change24h: number | null;
  sparkline: number[] | null;
}

function compact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (abs >= 1) return n.toFixed(2);
  if (abs === 0) return '0';
  return n.toPrecision(3);
}

function money(usd: number | null, raw: number | null, symbol: string): string | null {
  if (usd !== null) return `$${compact(usd)}`;
  if (raw !== null) return `${compact(raw)} ${symbol}`;
  return null;
}

/** Polyline points for an SVG sparkline; null under 2 samples. */
function sparkPoints(samples: number[] | null | undefined, w: number, h: number, pad: number) {
  if (!samples || samples.length < 2) return null;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (samples.length - 1);
  const pts = samples.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / span) * (h - pad * 2);
    return [Number(x.toFixed(1)), Number(y.toFixed(1))] as const;
  });
  return {
    line: pts.map((p) => p.join(',')).join(' '),
    area: `${pad},${h - pad} ${pts.map((p) => p.join(',')).join(' ')} ${w - pad},${h - pad}`,
  };
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const address = url.pathname.split('/').filter(Boolean).pop() ?? '';
  if (address.length < 32) {
    return Response.json({ error: 'address is not a valid Solana address' }, { status: 400 });
  }
  const origin = url.origin;

  const state = await fetchJson<StateBody>(`${origin}/api/pools/${address}/state`);
  if (!state) {
    return Response.json({ error: 'Pool not registered' }, { status: 404 });
  }
  const list = await fetchJson<{ pools: ListPool[] }>(`${origin}/api/pools?limit=100`);
  const summary = list?.pools.find((p) => p.poolAddress === address) ?? null;

  const change24h = summary?.change24h ?? null;
  const mcText = money(state.marketCapUsd, state.marketCap, state.quoteSymbol);
  const spark = sparkPoints(summary?.sparkline, 470, 150, 6);
  const down = change24h !== null && change24h < 0;
  const accent = down ? ROSE : GREEN;
  const progressPct =
    state.progress !== null && state.progress !== undefined
      ? Math.max(0, Math.min(100, state.progress * 100))
      : null;
  const imageUrl =
    state.imageUrl && state.imageUrl.startsWith('https://') ? state.imageUrl : null;
  // Preflight the token image: satori fails the whole render on an
  // undecodable image, so only hand it URLs that answer as images.
  let imageOk = false;
  if (imageUrl) {
    try {
      const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(3500) });
      imageOk = imgRes.ok && (imgRes.headers.get('content-type') ?? '').startsWith('image/');
    } catch {
      imageOk = false;
    }
  }

  const card = (withImage: boolean) => (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: BG,
        backgroundImage: `radial-gradient(900px 480px at 85% -10%, rgba(50,242,123,0.16), rgba(10,14,12,0))`,
        padding: '54px 60px 46px',
        fontFamily: 'sans-serif',
        color: TEXT,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
        {withImage && imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            width={92}
            height={92}
            style={{ borderRadius: 22, marginRight: 24 }}
            alt=""
          />
        ) : (
          <div
            style={{
              width: 92,
              height: 92,
              borderRadius: 22,
              marginRight: 24,
              backgroundColor: PANEL,
              border: `1px solid ${LINE}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 40,
              fontWeight: 700,
              color: GREEN,
            }}
          >
            {state.baseSymbol.slice(0, 1)}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 46, fontWeight: 700, lineHeight: 1.05 }}>{state.baseName}</div>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              fontSize: 26,
              color: GREEN,
              fontWeight: 600,
              marginTop: 6,
            }}
          >
            <span>${state.baseSymbol}</span>
            <span style={{ color: MUTED, fontWeight: 400, marginLeft: 12 }}>
              · paired with {state.quoteSymbol}
            </span>
          </div>
        </div>
        <div
          style={{
            marginLeft: 'auto',
            fontSize: 30,
            fontWeight: 800,
            letterSpacing: 1,
            color: TEXT,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <span style={{ color: GREEN, marginRight: 8 }}>⌒</span> curv
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 58, width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 21, color: MUTED, letterSpacing: 3 }}>MARKET CAP</div>
          <div style={{ fontSize: 88, fontWeight: 800, lineHeight: 1.08 }}>{mcText ?? '···'}</div>
          {change24h !== null ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                fontSize: 30,
                fontWeight: 700,
                color: accent,
                marginTop: 8,
              }}
            >
              <span>
                {change24h >= 0 ? '+' : ''}
                {change24h.toFixed(2)}%
              </span>
              <span style={{ color: MUTED, fontWeight: 400, marginLeft: 12 }}>in 24h</span>
            </div>
          ) : (
            <div style={{ fontSize: 30, color: MUTED, marginTop: 8 }}>Just launched</div>
          )}
        </div>
        {spark ? (
          <svg width={470} height={150} viewBox="0 0 470 150" style={{ marginLeft: 'auto' }}>
            <polygon points={spark.area} fill={accent} opacity={0.13} />
            <polyline
              points={spark.line}
              fill="none"
              stroke={accent}
              strokeWidth={3.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
        ) : null}
      </div>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', width: '100%' }}>
        <div
          style={{
            width: '100%',
            height: 14,
            borderRadius: 7,
            backgroundColor: PANEL,
            border: `1px solid ${LINE}`,
            display: 'flex',
          }}
        >
          <div
            style={{
              width: `${state.graduated ? 100 : progressPct ?? 0}%`,
              height: '100%',
              borderRadius: 7,
              backgroundColor: GREEN,
            }}
          />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            marginTop: 18,
            fontSize: 24,
          }}
        >
          <div style={{ color: TEXT, fontWeight: 600 }}>
            {state.graduated
              ? 'Graduated to DAMM v2 · liquidity locked'
              : progressPct !== null
                ? `${progressPct.toFixed(1)}% of the way to graduation`
                : 'Live on the bonding curve'}
          </div>
          <div style={{ marginLeft: 'auto', color: MUTED }}>
            Fair launch on Meteora DBC · curvpad.fun
          </div>
        </div>
        {state.usdReference ? (
          <div style={{ fontSize: 18, color: MUTED, marginTop: 10 }}>
            Devnet preview · dollar figures are a mainnet reference
          </div>
        ) : null}
      </div>
    </div>
  );

  const options = {
    width: WIDTH,
    height: HEIGHT,
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
  };

  return new ImageResponse(card(imageOk), options);
}
