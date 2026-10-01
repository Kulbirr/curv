import { useState } from 'react';
import type { CSSProperties } from 'react';
import {
  formatMoneyValue,
  formatPriceValue,
} from '@/components/Discover/format';
import type { PoolStateResponse } from './types';
import { UsdRef } from '@/components/UsdRef';
import { changeFromHistory } from './usePoolData';
import { useViewerCount } from './useViewerCount';
import type { HistoryPoint } from './types';

/** Deterministic hue (0-359) derived from a string, for avatar gradients. */
function hueFromString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}

function TokenAvatar({ symbol, imageUrl }: { symbol: string; imageUrl: string | null }) {
  const [imgFailed, setImgFailed] = useState(false);
  const letter = (symbol.charAt(0) || '?').toUpperCase();
  const hue = hueFromString(symbol);
  return (
    <span
      className="sc-token-avatar large"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 65% 42%), hsl(${(hue + 50) % 360} 65% 58%))`,
      }}
      aria-hidden="true"
    >
      {imageUrl && !imgFailed ? (
        <img
          src={imageUrl}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span>{letter}</span>
      )}
    </span>
  );
}

function QuoteBadge({ quoteSymbol }: { quoteSymbol: string }) {
  const isStockQuote = quoteSymbol.endsWith('x');
  return (
    <span className={isStockQuote ? 'sc-quote-badge stock' : 'sc-quote-badge'}>
      {isStockQuote && <i>{quoteSymbol.charAt(0).toUpperCase()}</i>}
      {quoteSymbol}
    </span>
  );
}

const STALE_BADGE_STYLE: CSSProperties = {
  padding: '4px 7px',
  border: '1px solid #4a3a20',
  borderRadius: 999,
  background: '#221a10',
  color: '#e8b64c',
  fontSize: 10,
};

interface Props {
  state: PoolStateResponse;
  points: HistoryPoint[];
  volume24h: number | null;
  /** Base token mint, shown as the coin address with copy and social icons. */
  baseMint: string | null;
}

export default function PoolHeader({ state, points, volume24h, baseMint }: Props) {
  const change = changeFromHistory(points);
  const viewerCount = useViewerCount(state.poolAddress);
  const changeKnown = typeof change === 'number' && Number.isFinite(change);
  const changeValue = changeKnown ? (change as number) : 0;
  const changeColor = !changeKnown
    ? '#737d76'
    : changeValue > 0
      ? '#3deb80'
      : changeValue < 0
        ? '#f05f67'
        : '#737d76';
  const changeArrow = !changeKnown ? '' : changeValue > 0 ? '▲ ' : changeValue < 0 ? '▼ ' : '';
  const changeText = changeKnown ? `${changeArrow}${Math.abs(changeValue).toFixed(1)}%` : '--';

  const [copyMessage, setCopyMessage] = useState('');
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage('Copied');
      window.setTimeout(() => setCopyMessage(''), 1800);
    } catch {
      setCopyMessage('Clipboard unavailable');
      window.setTimeout(() => setCopyMessage(''), 1800);
    }
  };
  const copyMint = () => {
    if (baseMint) copyText(baseMint);
  };
  const shortMint =
    baseMint && baseMint.length > 10
      ? `${baseMint.slice(0, 4)}…${baseMint.slice(-4)}`
      : baseMint;

  return (
    <>
      <section className="sc-pool-token-head" aria-label="Token">
        <TokenAvatar symbol={state.baseSymbol} imageUrl={state.imageUrl} />
        <div className="sc-pool-token-identity">
          <div className="sc-pool-title-row">
            <h1
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {state.baseName || state.baseSymbol}
            </h1>
            <QuoteBadge quoteSymbol={state.quoteSymbol} />
            {state.stale && (
              <span
                style={STALE_BADGE_STYLE}
                title="On-chain data is unreachable right now; showing last recorded values"
              >
                stale
              </span>
            )}
            {state.graduated && (
              <span className="sc-pool-graduation-badge">Graduated</span>
            )}
            {viewerCount != null && viewerCount >= 2 && (
              <span
                className="sc-viewers-badge"
                title={`${viewerCount} people are viewing this token right now`}
              >
                <span className="sc-viewers-dot" aria-hidden="true" />
                {viewerCount} watching
              </span>
            )}
          </div>
          <span className="sc-pool-ticker">${state.baseSymbol}</span>
          {shortMint && (
            <div className="sc-pool-address-row">
              <code title={baseMint ?? undefined}>{shortMint}</code>
              <button
                type="button"
                onClick={copyMint}
                aria-label="Copy coin address"
                title="Copy coin address"
                className="sc-icon-btn"
              >
                <svg
                  viewBox="0 0 16 16"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                  <path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5h-4a1.5 1.5 0 0 0-1.5 1.5v4a1.5 1.5 0 0 0 1.5 1.5h1" />
                </svg>
              </button>
              {state.twitter && (
                <a
                  href={state.twitter}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open coin's X profile"
                  title="Open coin's X profile"
                  className="sc-icon-btn"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="13"
                    height="13"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                </a>
              )}
            </div>
          )}
        </div>
        {copyMessage && (
          <span className="sc-copy-feedback" role="status">
            {copyMessage}
          </span>
        )}
      </section>

      <section className="sc-pool-stats" aria-label="Token statistics">
        <div>
          <span>Market cap</span>
          <strong>
            {formatMoneyValue(state.marketCapUsd, state.marketCap, state.quoteSymbol)}
            <UsdRef reference={state.usdReference} hasUsd={state.marketCapUsd != null} />
          </strong>
        </div>
        <div>
          <span>Price</span>
          <strong>
            {formatPriceValue(state.priceUsd, state.price, state.quoteSymbol)}
            <UsdRef reference={state.usdReference} hasUsd={state.priceUsd != null} />
          </strong>
        </div>
        <div>
          <span>Volume 24h</span>
          <strong>{formatMoneyValue(null, volume24h, state.quoteSymbol)}</strong>
        </div>
        <div>
          <span>24h change</span>
          <strong style={{ color: changeColor }}>{changeText}</strong>
        </div>
        <div>
          <span>Holders</span>
          <strong>--</strong>
        </div>
      </section>
    </>
  );
}
