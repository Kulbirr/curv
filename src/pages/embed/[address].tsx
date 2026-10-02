import { useMemo } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { usePoolHistory, usePoolStatePush } from '@/components/Pool';
import { formatMoneyValue, formatPriceValue } from '@/components/Discover/format';
import { displayProgress } from '@/lib/graduation';

/**
 * /embed/[address]: the live chart widget other sites frame into their
 * pages (the token page's Embed button copies the snippet). Bare by
 * design: no site header, no footer, no wallet. Data comes from the
 * same state and history feeds the token page uses, refreshed on the
 * same cadence. Framing is allowed for this path only (see the header
 * rules in next.config.ts); the rest of the site stays frame locked.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://curvpad.fun';

function Spark({ prices }: { prices: number[] }) {
  const { line, area, down } = useMemo(() => {
    if (prices.length < 2) return { line: null, area: null, down: false };
    const w = 340;
    const h = 84;
    const pad = 4;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    const stepX = (w - pad * 2) / (prices.length - 1);
    const pts = prices.map((v, i) => [
      Number((pad + i * stepX).toFixed(1)),
      Number((pad + (1 - (v - min) / span) * (h - pad * 2)).toFixed(1)),
    ]);
    return {
      line: pts.map((p) => p.join(',')).join(' '),
      area: `${pad},${h - pad} ${pts.map((p) => p.join(',')).join(' ')} ${w - pad},${h - pad}`,
      down: prices[prices.length - 1] < prices[0],
    };
  }, [prices]);

  if (!line) {
    return <div className="sc-embed-spark sc-embed-spark-empty">Not enough history yet</div>;
  }
  const stroke = down ? '#fb7185' : '#32f27b';
  return (
    <svg className="sc-embed-spark" viewBox="0 0 340 84" preserveAspectRatio="none">
      <polygon points={area ?? ''} fill={stroke} opacity={0.12} />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={2.4}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EmbedContent({ poolAddress }: { poolAddress: string }) {
  const stateQuery = usePoolStatePush(poolAddress);
  const historyQuery = usePoolHistory(poolAddress, 120);
  const state = stateQuery.data;

  const prices = useMemo(() => {
    const pts = historyQuery.data?.points ?? [];
    return pts.map((p) => p.price).filter((v) => Number.isFinite(v) && v > 0);
  }, [historyQuery.data]);

  if (stateQuery.isLoading) {
    return (
      <div className="sc-embed" aria-busy="true">
        <div className="animate-pulse sc-embed-pulse" style={{ height: 26 }} />
        <div className="animate-pulse sc-embed-pulse" style={{ height: 84 }} />
        <div className="animate-pulse sc-embed-pulse" style={{ height: 18 }} />
      </div>
    );
  }

  if (stateQuery.isError || !state) {
    return <div className="sc-embed sc-embed-error">Pool not found on Curv</div>;
  }

  const pct = state.graduated ? 100 : displayProgress(state.progress);
  const tokenUrl = `${APP_URL}/token/${poolAddress}`;

  return (
    <div className="sc-embed">
      <div className="sc-embed-head">
        {state.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={state.imageUrl} alt="" width={30} height={30} />
        ) : (
          <span className="sc-embed-initial">{state.baseSymbol.slice(0, 1)}</span>
        )}
        <span className="sc-embed-name">{state.baseName}</span>
        <span className="sc-embed-symbol">${state.baseSymbol}</span>
        <span className="sc-embed-price">
          {formatPriceValue(state.priceUsd, state.price, state.quoteSymbol)}
        </span>
      </div>

      <Spark prices={prices} />

      <div className="sc-embed-meta">
        <span>
          Market cap{' '}
          <b>{formatMoneyValue(state.marketCapUsd, state.marketCap, state.quoteSymbol)}</b>
        </span>
        <span>{state.graduated ? 'Graduated to DAMM v2' : `${pct?.toFixed(1) ?? '···'}% to graduation`}</span>
      </div>
      <div className="sc-progress sc-embed-progress">
        <span style={{ width: `${pct ?? 0}%` }} />
      </div>

      <div className="sc-embed-foot">
        <span className="sc-embed-brand">⌒ curv</span>
        <a href={tokenUrl} target="_blank" rel="noreferrer" className="sc-embed-trade">
          Trade on Curv →
        </a>
      </div>
    </div>
  );
}

export default function EmbedPage() {
  const router = useRouter();
  const raw = router.query.address;
  const poolAddress = typeof raw === 'string' && raw.length >= 32 ? raw : null;

  return (
    <>
      <Head>
        <title>Curv chart widget</title>
        <meta name="robots" content="noindex" />
      </Head>
      {router.isReady && poolAddress ? (
        <EmbedContent poolAddress={poolAddress} />
      ) : (
        <div className="sc-embed sc-embed-error">Pool not found on Curv</div>
      )}
    </>
  );
}
