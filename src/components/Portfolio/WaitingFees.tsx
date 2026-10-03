import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../Pool/usePoolData';
import { formatFeeRaw } from '@/lib/claim-creator-fees';

/**
 * The claim loop inbox on the Portfolio page: every pool where the
 * connected wallet is a fee split recipient, with the share of
 * accrued and unclaimed creator fees currently waiting for them.
 *
 * Payout itself is the creator's claim transaction, which pays every
 * recipient in the same atomic transaction. This panel's job is
 * visibility and pressure: each row carries a Share action that posts
 * the waiting fees publicly (the link unfurls with the pool's share
 * card), which is how recipients nudge creators into claiming. Curv
 * never holds the balances.
 */

interface WaitingEntry {
  poolAddress: string;
  baseSymbol: string;
  baseName: string;
  quoteSymbol: string;
  imageUrl: string | null;
  creator: string;
  bps: number;
  shareBaseRaw: string;
  shareQuoteRaw: string;
  baseDecimals: number;
  quoteDecimals: number;
  graduated: boolean;
  sampledAt: number | null;
}

interface WaitingResponse {
  wallet: string;
  waiting: WaitingEntry[];
}

function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

export default function WaitingFees({ owner }: { owner: string }) {
  const [sharedFor, setSharedFor] = useState<string | null>(null);
  const query = useQuery<WaitingResponse>({
    queryKey: ['claims-waiting', owner],
    queryFn: () => fetchJson<WaitingResponse>(`/api/claims/waiting?wallet=${owner}`),
    enabled: !!owner,
    refetchInterval: 30_000,
    retry: 1,
  });

  const entries = (query.data?.waiting ?? []).filter(
    (e) => e.shareBaseRaw !== '0' || e.shareQuoteRaw !== '0',
  );
  if (!query.data || entries.length === 0) return null;

  const appUrl =
    typeof window !== 'undefined'
      ? window.location.origin
      : process.env.NEXT_PUBLIC_APP_URL ?? 'https://curvpad.fun';

  const share = (entry: WaitingEntry) => {
    const pageUrl = `${appUrl}/token/${entry.poolAddress}`;
    const text = `I have creator fees waiting on Curv from $${entry.baseSymbol}. The splits are public and fixed at launch, the creator just has to claim.`;
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl)}`,
      '_blank',
      'noopener',
    );
    setSharedFor(entry.poolAddress);
    window.setTimeout(() => setSharedFor((s) => (s === entry.poolAddress ? null : s)), 2000);
  };

  return (
    <section className="sc-waiting-section" aria-label="Fees waiting for you">
      <h2>Fees waiting for you</h2>
      <p className="sc-waiting-lead">
        Your share of creator fees on pools where you are a split recipient. They pay out
        automatically when the pool&apos;s creator claims.
      </p>
      {entries.some((e) => e.sampledAt && Date.now() - e.sampledAt > 5 * 60 * 1000) && (
        <p className="sc-waiting-stale">
          Amounts may be stale. They refresh automatically after the next on-chain update.
        </p>
      )}
      <div className="sc-waiting-grid">
        {entries.map((entry) => {
          const base = formatFeeRaw(entry.shareBaseRaw, entry.baseDecimals);
          const quote = formatFeeRaw(entry.shareQuoteRaw, entry.quoteDecimals);
          return (
            <article key={entry.poolAddress} className="sc-waiting-card">
              <div className="sc-waiting-head">
                {entry.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={entry.imageUrl} alt="" width={34} height={34} />
                ) : (
                  <span className="sc-waiting-initial">{entry.baseSymbol.slice(0, 1)}</span>
                )}
                <div>
                  <div className="sc-waiting-name">{entry.baseName}</div>
                  <div className="sc-waiting-sub">
                    ${(entry.bps / 100).toFixed(2)}% of creator fees · from{' '}
                    {shortAddress(entry.creator)}
                    {entry.graduated && ' · graduated'}
                  </div>
                </div>
              </div>
              <div className="sc-waiting-amount">
                {[base ? `${base} ${entry.baseSymbol}` : null, quote ? `${quote} ${entry.quoteSymbol}` : null]
                  .filter(Boolean)
                  .join(' · ') || '···'}
              </div>
              <div className="sc-waiting-actions">
                <button
                  type="button"
                  className="sc-button sc-button-secondary"
                  onClick={() => share(entry)}
                >
                  {sharedFor === entry.poolAddress ? 'Shared' : 'Share'}
                </button>
                <Link href={`/token/${entry.poolAddress}`} className="sc-button sc-button-primary">
                  View pool
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
