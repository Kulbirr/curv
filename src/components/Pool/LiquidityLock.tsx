import { useEffect, useState } from 'react';
import { isDevnet } from '@/lib/solana';
import { shortenAddress } from '@/lib/utils';
import {
  getLockViewModel,
  type LiquidityLockResult,
} from '@/lib/liquidity-lock';

function accountUrl(addr: string): string {
  return `https://solscan.io/account/${addr}${isDevnet() ? '?cluster=devnet' : ''}`;
}

/**
 * Liquidity lock panel, rendered ONLY on graduated pools.
 *
 * Shows whether the DAMM v2 liquidity positions are permanently locked,
 * with explorer links to the pool and each position so anyone can verify
 * on chain. Naive rug checkers look for "LP burned"; this panel shows
 * the stronger truth: locked forever, fees still claimable.
 *
 * Never blocks the page: loading and error states render inline and the
 * fetch is fully isolated from the rest of the pool data.
 */
export default function LiquidityLock({ poolAddress }: { poolAddress: string }) {
  const [result, setResult] = useState<LiquidityLockResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setResult(null);
    fetch(`/api/pools/${poolAddress}/liquidity-lock`)
      .then(async (r) => {
        if (r.status === 404) {
          const body = (await r.json().catch(() => ({}))) as {
            graduated?: boolean;
          };
          // Pool not graduated (or unknown): nothing to verify.
          if (body.graduated === false) return null;
          throw new Error('not found');
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = (await r.json()) as LiquidityLockResult;
        return json.graduatedPool ? json : null;
      })
      .then((json) => {
        if (!cancelled) {
          setResult(json);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [poolAddress]);

  if (loading) {
    return (
      <section className="sc-liquidity-lock-card" aria-label="Liquidity lock">
        <p style={{ margin: 0, fontSize: 10, color: '#8c968d' }}>
          Checking the lock…
        </p>
      </section>
    );
  }

  const vm = getLockViewModel(result, failed);
  const statusClass =
    vm.status === 'locked'
      ? 'sc-lock-ok-text'
      : vm.status === 'unlocked'
        ? 'sc-lock-warn-text'
        : undefined;

  return (
    <section className="sc-liquidity-lock-card" aria-label="Liquidity lock">
      <div className="sc-pool-section-head">
        <h2 className={statusClass}>{vm.heading}</h2>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 10, lineHeight: 1.6, color: '#8c968d' }}>
        {vm.body}
      </p>

      {vm.poolAddress && (
        <p style={{ margin: '10px 0 0', fontSize: 10 }}>
          <a
            href={accountUrl(vm.poolAddress)}
            target="_blank"
            rel="noreferrer"
            style={{ color: '#c4f0c8', textDecoration: 'underline' }}
          >
            View pool
          </a>
        </p>
      )}

      {vm.positions.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
          {vm.positions.map((p) => (
            <li
              key={p.address}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 0',
                borderTop: '1px solid #1d2321',
                fontSize: 10,
              }}
            >
              <span style={{ color: '#c4f0c8' }}>{p.roleLabel}</span>
              <span style={{ color: '#5f6a60' }}>{shortenAddress(p.address)}</span>
              <span
                className={p.locked ? 'sc-lock-ok-text' : 'sc-lock-warn-text'}
                style={{ marginLeft: 'auto' }}
              >
                {p.locked ? 'Locked' : 'Not locked'}
              </span>
              <a
                href={accountUrl(p.address)}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#c4f0c8', textDecoration: 'underline' }}
              >
                Verify
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
