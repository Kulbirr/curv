import Link from 'next/link';
import { useRouter } from 'next/router';
import Page from '@/components/ui/Page/Page';
import LiveIndicator from '@/components/LiveIndicator';
import { deriveLiveStatus, useNow } from '@/hooks/useLiveStatus';
import {
  CreatorEarnings,
  PoolDetails,
  PoolHeader,
  PriceChart,
  TradePanel,
  TradeStats,
  useOnChainPool,
  usePoolHistory,
  usePoolState,
} from '@/components/Pool';

function PoolPageContent({ poolAddress }: { poolAddress: string }) {
  const stateQuery = usePoolState(poolAddress);
  const historyQuery = usePoolHistory(poolAddress);
  const onChainQuery = useOnChainPool(poolAddress);
  const now = useNow(5000);
  const liveStatus = deriveLiveStatus({
    dataUpdatedAt: stateQuery.dataUpdatedAt,
    isFetching: stateQuery.isFetching,
    isError: stateQuery.isError,
    now,
  });

  const state = stateQuery.data;
  const history = historyQuery.data;

  if (stateQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl">
        <div className="h-8 w-40 animate-pulse rounded bg-neutral-800" />
        <div className="mt-4 h-48 animate-pulse rounded-2xl bg-neutral-900" />
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="h-[320px] animate-pulse rounded-2xl bg-neutral-900 lg:col-span-2" />
          <div className="h-[320px] animate-pulse rounded-2xl bg-neutral-900" />
        </div>
      </div>
    );
  }

  if (stateQuery.isError || !state) {
    const notFound = stateQuery.error instanceof Error && stateQuery.error.message === 'Pool not registered';
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 rounded-2xl border border-neutral-800/60 bg-neutral-950 px-6 py-16 text-center">
        <p className="text-sm font-medium text-neutral-200">
          {notFound ? 'Pool not found' : "Couldn't load pool"}
        </p>
        <p className="max-w-sm text-sm text-neutral-500">
          {notFound
            ? 'This pool address is not tracked by StockCurve.'
            : 'The pool data could not be reached. Check your connection and try again.'}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => stateQuery.refetch()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90"
          >
            Retry
          </button>
          <Link
            href="/"
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 hover:border-neutral-500"
          >
            Back to Discover
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-4 flex items-center justify-between">
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-300">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5" />
            <path d="m12 19-7-7 7-7" />
          </svg>
          Discover
        </Link>
        <LiveIndicator status={liveStatus} />
      </div>

      <PoolHeader
        state={state}
        points={history?.points ?? []}
        volume24h={history?.volume24h ?? null}
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <PriceChart
            points={history?.points ?? []}
            complete={history?.complete ?? false}
            isLoading={historyQuery.isLoading}
            quoteSymbol={state.quoteSymbol}
          />
        </div>
        <div>
          <TradePanel poolAddress={poolAddress} state={state} />
          <div className="mt-4">
            <TradeStats stats={state.tradeStats24h} quoteSymbol={state.quoteSymbol} />
          </div>
        </div>
      </div>

      <div className="mt-4">
        <PoolDetails state={state} onChain={onChainQuery.data} />
      </div>

      <div className="mt-4 max-w-md">
        <CreatorEarnings poolAddress={poolAddress} state={state} />
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
        <div className="mx-auto w-full max-w-6xl">
          <div className="h-8 w-40 animate-pulse rounded bg-neutral-800" />
          <div className="mt-4 h-48 animate-pulse rounded-2xl bg-neutral-900" />
        </div>
      ) : (
        <PoolPageContent poolAddress={poolAddress} />
      )}
    </Page>
  );
}
