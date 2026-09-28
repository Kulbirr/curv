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
    <div>
      <span>{label}</span>
      <strong>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title={value}
            style={{ color: 'inherit', textDecoration: 'none' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#a9e778')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'inherit')}
          >
            {shortAddr(value)}
          </a>
        ) : (
          <span title={value}>{shortAddr(value)}</span>
        )}
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          style={{
            marginLeft: 8,
            padding: 0,
            border: 0,
            background: 'transparent',
            color: '#98a68e',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </strong>
    </div>
  );
}

interface Props {
  state: PoolStateResponse;
  onChain: OnChainPool | undefined;
}

export default function PoolDetails({ state, onChain }: Props) {
  return (
    <div>
      {state.description && (
        <p
          style={{
            margin: '0 0 4px',
            fontSize: 10,
            lineHeight: 1.6,
            color: '#899289',
          }}
        >
          {state.description}
        </p>
      )}
      <div className="sc-pool-info-list">
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
      <p
        style={{
          margin: '10px 0 0',
          fontSize: 9,
          lineHeight: 1.6,
          color: '#5f6a60',
        }}
      >
        Funds and ownership live on-chain. This page only reads public account data and builds
        transactions for your wallet to sign. It never takes custody of anything.
      </p>
    </div>
  );
}
