import { useRef, useState } from 'react';
import { useWallet } from '@jup-ag/wallet-adapter';
import { useQueryClient } from '@tanstack/react-query';
import { getConnection, isDevnet } from '@/lib/solana';
import {
  claimCreatorFeesFlow,
  formatFeeRaw,
  hasNoAccruedFees,
  shouldShowCreatorEarnings,
} from '@/lib/claim-creator-fees';
import type { PoolStateResponse } from './types';

type Status = 'idle' | 'signing' | 'sending' | 'confirming' | 'confirmed' | 'failed';

function agoText(sampledAt: number | null, now: number): string {
  if (sampledAt === null) return 'updated at an unknown time';
  const s = Math.max(0, Math.round((now - sampledAt) / 1000));
  if (s < 60) return `updated ${s}s ago`;
  const m = Math.round(s / 60);
  return `updated ${m}m ago`;
}

/**
 * Creator earnings panel — rendered ONLY when the connected wallet is the
 * pool's creator. Everyone else sees nothing (not an error).
 *
 * Shows the 0.3% trading fees accrued on-chain in base + quote tokens and
 * a Claim button that puts the SDK's claimCreatorTradingFee transaction
 * through the same wallet-signing flow as swaps.
 */
export default function CreatorEarnings({
  poolAddress,
  state,
}: {
  poolAddress: string;
  state: PoolStateResponse;
}) {
  const { publicKey, signTransaction, connected } = useWallet();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const runningRef = useRef(false);

  const walletAddress = publicKey?.toBase58() ?? null;
  if (!shouldShowCreatorEarnings({ connected, walletAddress, creator: state.creator })) {
    return null;
  }

  const baseFee = formatFeeRaw(state.creatorBaseFeeRaw, state.baseDecimals ?? 9);
  const quoteFee = formatFeeRaw(state.creatorQuoteFeeRaw, state.quoteDecimals ?? 9);
  const empty = hasNoAccruedFees(state.creatorBaseFeeRaw, state.creatorQuoteFeeRaw);
  const unknown = baseFee === null || quoteFee === null;

  const claim = async () => {
    if (!publicKey || !signTransaction || runningRef.current) return;
    runningRef.current = true;
    setError(null);
    setTxSig(null);
    try {
      const sig = await claimCreatorFeesFlow({
        connection: getConnection(),
        signTransaction,
        poolAddress,
        creator: publicKey.toBase58(),
        onStatus: (s) => setStatus(s),
      });
      setTxSig(sig);
      setStatus('confirmed');
      // The next indexer sample zeroes the accrued fees; refresh promptly.
      queryClient.invalidateQueries({ queryKey: ['pool-state', poolAddress] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claim failed');
      setStatus('failed');
    } finally {
      runningRef.current = false;
    }
  };

  const busy = status === 'signing' || status === 'sending' || status === 'confirming';
  const statusText =
    status === 'signing'
      ? 'Waiting for wallet signature…'
      : status === 'sending'
        ? 'Sending transaction…'
        : status === 'confirming'
          ? 'Confirming on-chain…'
          : null;

  return (
    <section className="rounded-2xl border border-neutral-800/60 bg-neutral-950 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">Creator earnings</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Your 0.3% of every trade on this pool · {agoText(state.sampledAt, Date.now())}
        {state.stale ? ' · showing last known values' : ''}
      </p>

      {unknown ? (
        <p className="mt-4 text-sm text-neutral-500">
          Earnings data hasn&apos;t been indexed for this pool yet. It appears after the next
          indexer sample.
        </p>
      ) : empty ? (
        <p className="mt-4 text-sm text-neutral-500">
          No fees accrued yet. You earn 0.3% of every trade once trading starts.
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between rounded-xl bg-neutral-900/60 px-4 py-3">
            <span className="text-xs text-neutral-500">{state.baseSymbol}</span>
            <span className="text-sm font-semibold tabular-nums text-neutral-100">{baseFee}</span>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-neutral-900/60 px-4 py-3">
            <span className="text-xs text-neutral-500">{state.quoteSymbol}</span>
            <span className="text-sm font-semibold tabular-nums text-neutral-100">{quoteFee}</span>
          </div>
        </div>
      )}

      {!unknown && !empty && (
        <button
          type="button"
          onClick={claim}
          disabled={busy}
          className="mt-4 w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? statusText : 'Claim earnings'}
        </button>
      )}

      {status === 'confirmed' && txSig && (
        <p className="mt-3 text-xs text-emerald-300">
          Claimed.{' '}
          <a
            href={`https://solscan.io/tx/${txSig}${isDevnet() ? '?cluster=devnet' : ''}`}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-emerald-200"
          >
            View transaction
          </a>
        </p>
      )}
      {status === 'failed' && error && (
        <p className="mt-3 text-xs text-red-400">{error}</p>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-neutral-600">
        Claiming sends a transaction you sign in your wallet. Fees land in your wallet in the
        tokens they accrued in.
      </p>
    </section>
  );
}
