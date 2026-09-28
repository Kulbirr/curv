import { useState } from 'react';
import { isDevnet } from '@/lib/solana';
import type { PoolStateResponse } from './types';
import type { OnChainPool } from './useOnChainPool';

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

function explorerAccountUrl(addr: string): string {
  return `https://solscan.io/account/${addr}${isDevnet() ? '?cluster=devnet' : ''}`;
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="shrink-0 text-xs text-neutral-500">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="truncate font-mono text-xs text-neutral-300 hover:text-primary"
            title={value}
          >
            {shortAddr(value)}
          </a>
        ) : (
          <span className="truncate font-mono text-xs text-neutral-300" title={value}>
            {shortAddr(value)}
          </span>
        )}
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    </div>
  );
}

interface Props {
  state: PoolStateResponse;
  onChain: OnChainPool | undefined;
}

export default function PoolDetails({ state, onChain }: Props) {
  return (
    <div className="rounded-2xl border border-neutral-800/60 bg-neutral-950 p-5">
      <h2 className="mb-1 text-sm font-semibold text-neutral-200">Pool details</h2>
      {state.description && <p className="mb-2 text-sm text-neutral-400">{state.description}</p>}
      <div className="divide-y divide-neutral-800/60">
        <Row label="Pool address" value={state.poolAddress} href={explorerAccountUrl(state.poolAddress)} />
        {onChain && (
          <>
            <Row label="Config address" value={onChain.configAddress} href={explorerAccountUrl(onChain.configAddress)} />
            <Row label="Base mint" value={onChain.baseMint} href={explorerAccountUrl(onChain.baseMint)} />
            <Row label="Quote mint" value={onChain.quoteMint} href={explorerAccountUrl(onChain.quoteMint)} />
          </>
        )}
        <Row label="Creator" value={state.creator} href={explorerAccountUrl(state.creator)} />
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-neutral-600">
        Funds and ownership live on-chain. This page only reads public account data and builds
        transactions for your wallet to sign — it never takes custody of anything.
      </p>
    </div>
  );
}
