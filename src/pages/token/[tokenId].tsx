import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import Page from '@/components/ui/Page/Page';
import { getConnection } from '@/lib/solana';
import { displayProgress } from '@/lib/graduation';
import { rawToUi } from '@/lib/swap-math';
import {
  formatMoneyValue,
  formatPriceValue,
} from '@/components/Discover/format';
import {
  CreatorEarnings,
  LiquidityLock,
  PoolDetails,
  PoolHeader,
  PriceChart,
  TradePanel,
  TradeStats,
  useOnChainPool,
  usePoolHistory,
  usePoolStatePush,
} from '@/components/Pool';
import { getMintDecimalsCached } from '@/components/Pool/useOnChainPool';
import type { OnChainPool } from '@/components/Pool/useOnChainPool';
import type { PoolStateResponse } from '@/components/Pool';

/** Bonding curve progress toward the migration threshold. */
function GraduationCard({ state }: { state: PoolStateResponse }) {
  // Single source of truth: the indexer's progress field, the same value
  // the pool header badge renders. Never recomputed from reserves here.
  const pct = state.graduated ? 100 : displayProgress(state.progress);
  return (
    <section className="sc-pool-graduation-card" aria-label="Bonding curve progress">
      <div className="sc-pool-section-head">
        <h2>Bonding curve progress</h2>
        <strong className="sc-number sc-green-text">
          {pct === null ? ',' : `${pct.toFixed(1)}%`}
        </strong>
      </div>
      <div className="sc-progress sc-pool-progress">
        <span style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className="sc-graduation-foot">
        <span>
          <b>
            {typeof state.quoteReserve === 'number'
              ? formatMoneyValue(null, state.quoteReserve, state.quoteSymbol)
              : ','}
          </b>{' '}
          /{' '}
          <b>
            {typeof state.migrationQuoteThreshold === 'number'
              ? formatMoneyValue(null, state.migrationQuoteThreshold, state.quoteSymbol)
              : ','}
          </b>{' '}
          to graduation
        </span>
        <span>Graduates to Meteora DAMM v2</span>
      </div>
    </section>
  );
}

/** Curve facts we can verify on-chain or from the indexer; nothing invented. */
function CurveInfoCard({ state }: { state: PoolStateResponse }) {
  return (
    <section className="sc-pool-info-card" aria-label="Curve info">
      <div className="sc-trade-card-label">Curve info</div>
      <div>
        <span>Current price</span>
        <strong>{formatPriceValue(state.priceUsd, state.price, state.quoteSymbol)}</strong>
      </div>
      <div>
        <span>Creator fee</span>
        <strong>0.3%</strong>
      </div>
      <div>
        <span>Graduation target</span>
        <strong>
          {typeof state.migrationQuoteThreshold === 'number'
            ? formatMoneyValue(null, state.migrationQuoteThreshold, state.quoteSymbol)
            : ','}
        </strong>
      </div>
      <div>
        <span>Status</span>
        <strong>{state.graduated ? 'Graduated' : 'Active'}</strong>
      </div>
    </section>
  );
}

async function fetchBaseBalance(
  owner: PublicKey,
  mint: string
): Promise<{ raw: BN; decimals: number }> {
  const connection = getConnection();
  const decimals = await getMintDecimalsCached(mint);
  const resp = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: new PublicKey(mint),
  });
  let total = new BN(0);
  for (const acc of resp.value) {
    const parsed = (acc.account.data as {
      parsed?: { info?: { tokenAmount?: { amount?: string } } };
    }).parsed;
    const amount = parsed?.info?.tokenAmount?.amount;
    if (amount) total = total.add(new BN(amount));
  }
  return { raw: total, decimals };
}

/**
 * The connected wallet's real base-token balance for this pool, read from
 * the chain. PnL is not tracked anywhere, so it renders a dash.
 */
function PositionCard({
  state,
  baseMint,
}: {
  state: PoolStateResponse;
  baseMint: string | undefined;
}) {
  const { publicKey, connected } = useWallet();
  const [balance, setBalance] = useState<{ raw: BN; decimals: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!publicKey || !baseMint) {
      setBalance(null);
      setLoading(!!publicKey && !baseMint);
      return;
    }
    let cancelled = false;
    const load = () => {
      fetchBaseBalance(publicKey, baseMint)
        .then((b) => {
          if (!cancelled) {
            setBalance(b);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setBalance(null);
            setLoading(false);
          }
        });
    };
    load();
    const id = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [publicKey, baseMint]);

  const amountText = balance ? rawToUi(balance.raw, balance.decimals) : null;
  const amountNum = amountText !== null ? Number(amountText) : null;
  const valueText =
    amountNum !== null && Number.isFinite(amountNum)
      ? formatMoneyValue(
          typeof state.priceUsd === 'number' ? amountNum * state.priceUsd : null,
          typeof state.price === 'number' ? amountNum * state.price : null,
          state.quoteSymbol
        )
      : ',';

  return (
    <section className="sc-position-card" aria-label="Your position">
      <div className="sc-trade-card-label">Your position</div>
      {!connected ? (
        <p style={{ margin: 0, fontSize: 9, color: '#77817b', lineHeight: 1.6 }}>
          Connect your wallet to see your position.
        </p>
      ) : loading ? (
        <p style={{ margin: 0, fontSize: 9, color: '#77817b' }}>Loading position…</p>
      ) : amountText === null ? (
        <p style={{ margin: 0, fontSize: 9, color: '#77817b', lineHeight: 1.6 }}>
          Your balance could not be read right now.
        </p>
      ) : (
        <>
          <div className="sc-position-primary">
            <strong>
              {amountText} ${state.baseSymbol}
            </strong>
            <b style={{ color: '#737d76' }}>,</b>
          </div>
          <div className="sc-position-value">{valueText} value</div>
        </>
      )}
    </section>
  );
}

type ActivityTab = 'Trades' | 'Holders' | 'Info';

const EMPTY_TAB_STYLE: CSSProperties = {
  margin: 0,
  padding: '20px 16px',
  fontSize: 10,
  lineHeight: 1.7,
  color: '#77817b',
};

/**
 * Activity card. The indexer does not record individual trades or a holder
 * list, so those tabs stay honest empty states; Info shows real pool data.
 */
function ActivityCard({
  state,
  onChain,
}: {
  state: PoolStateResponse;
  onChain: OnChainPool | undefined;
}) {
  const [tab, setTab] = useState<ActivityTab>('Trades');
  return (
    <section className="sc-pool-activity-card" aria-label="Pool activity">
      <div className="sc-pool-tabs" role="tablist" aria-label="Pool activity">
        {(['Trades', 'Holders', 'Info'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? 'selected' : ''}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      {tab === 'Trades' && (
        <p style={EMPTY_TAB_STYLE}>
          Individual trades are not indexed for this pool yet. The Buys vs sells
          card shows estimated 24h activity from reserve movement.
        </p>
      )}
      {tab === 'Holders' && (
        <p style={EMPTY_TAB_STYLE}>Holder data is not available for this pool yet.</p>
      )}
      {tab === 'Info' && <PoolDetails state={state} onChain={onChain} />}
    </section>
  );
}

function PoolPageContent({ poolAddress }: { poolAddress: string }) {
  const stateQuery = usePoolStatePush(poolAddress);
  const historyQuery = usePoolHistory(poolAddress);
  const onChainQuery = useOnChainPool(poolAddress);

  const state = stateQuery.data;
  const history = historyQuery.data;

  if (stateQuery.isLoading) {
    return (
      <div className="sc-pool-page" aria-busy="true">
        <div className="sc-pool-breadcrumb">
          <span>Loading pool…</span>
        </div>
        <div className="sc-pool-layout">
          <div className="sc-pool-main-column">
            <section className="sc-pool-token-head">
              <div
                className="animate-pulse"
                style={{ width: '100%', height: 56, borderRadius: 6, background: '#161c1a' }}
              />
            </section>
            <section className="sc-pool-chart-card">
              <div
                className="animate-pulse"
                style={{ width: '100%', height: 220, borderRadius: 6, background: '#161c1a' }}
              />
            </section>
          </div>
          <aside className="sc-pool-trade-column">
            <section className="sc-trade-panel">
              <div
                className="animate-pulse"
                style={{ width: '100%', height: 300, borderRadius: 6, background: '#161c1a' }}
              />
            </section>
          </aside>
        </div>
      </div>
    );
  }

  if (stateQuery.isError || !state) {
    const notFound =
      stateQuery.error instanceof Error && stateQuery.error.message === 'Pool not registered';
    return (
      <div className="sc-pool-page">
        <div className="sc-pool-breadcrumb">
          <Link href="/">Discover</Link>
          <span>›</span>
          <strong>{notFound ? 'Pool not found' : 'Could not load pool'}</strong>
        </div>
        <div className="sc-pool-layout">
          <div className="sc-pool-main-column">
            <section
              className="sc-pool-chart-card"
              style={{
                display: 'grid',
                gap: 12,
                justifyItems: 'center',
                padding: '40px 24px',
                textAlign: 'center',
              }}
            >
              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#dfe5dc' }}>
                {notFound ? 'Pool not found' : "Couldn't load pool"}
              </p>
              <p style={{ margin: 0, fontSize: 11, color: '#77817b', maxWidth: 380 }}>
                {notFound
                  ? 'This pool address is not tracked by Curv.'
                  : 'The pool data could not be reached. Check your connection and try again.'}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => stateQuery.refetch()}
                  className="sc-button sc-button-primary"
                >
                  Retry
                </button>
                <Link href="/" className="sc-button sc-button-secondary">
                  Back to Discover
                </Link>
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sc-pool-page">
      <div className="sc-pool-breadcrumb">
        <Link href="/">Discover</Link>
        <span>›</span>
        <strong>{state.baseName || state.baseSymbol}</strong>
      </div>

      <div className="sc-pool-layout">
        <div className="sc-pool-main-column">
          <PoolHeader
            state={state}
            points={history?.points ?? []}
            volume24h={history?.volume24h ?? null}
          />
          <PriceChart
            poolAddress={poolAddress}
            quoteSymbol={state.quoteSymbol}
            supply={
              state.marketCap != null && state.price
                ? state.marketCap / state.price
                : null
            }
          />
          <GraduationCard state={state} />
          {state.graduated && <LiquidityLock poolAddress={poolAddress} />}
          <CreatorEarnings poolAddress={poolAddress} state={state} />
          <ActivityCard state={state} onChain={onChainQuery.data} />
        </div>

        <aside className="sc-pool-trade-column">
          <TradePanel poolAddress={poolAddress} state={state} />
          <TradeStats stats={state.tradeStats24h} quoteSymbol={state.quoteSymbol} />
          <PositionCard state={state} baseMint={onChainQuery.data?.baseMint} />
          <CurveInfoCard state={state} />
        </aside>
      </div>
    </div>
  );
}

export default function TokenPage() {
  const router = useRouter();
  const raw = router.query.tokenId;
  const poolAddress = typeof raw === 'string' && raw.length >= 32 ? raw : null;

  return (
    <Page>
      {!router.isReady || !poolAddress ? (
        <div className="sc-pool-page" aria-busy="true">
          <div className="sc-pool-breadcrumb">
            <span>Loading pool…</span>
          </div>
          <div className="sc-pool-layout">
            <div className="sc-pool-main-column">
              <section className="sc-pool-token-head">
                <div
                  className="animate-pulse"
                  style={{ width: '100%', height: 56, borderRadius: 6, background: '#161c1a' }}
                />
              </section>
            </div>
          </div>
        </div>
      ) : (
        <PoolPageContent poolAddress={poolAddress} />
      )}
    </Page>
  );
}
