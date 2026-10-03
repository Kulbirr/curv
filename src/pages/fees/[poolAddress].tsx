import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Page from '@/components/ui/Page/Page';
import { fetchPoolLiveState } from '@/lib/pool-state';
import { formatFeeRaw } from '@/lib/claim-creator-fees';
import { splitShareRaw } from '@/lib/fee-split-terms';
import type {
  EffectiveFeeSplitRecipient,
  FeeSplitBinding,
} from '@/lib/fee-split-terms';
import type { TrackedPool } from '@/lib/pool-registry';

interface FeeSplitsResponse {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  configAddress: string;
  creator: string;
  recipients: EffectiveFeeSplitRecipient[];
  bindings: FeeSplitBinding[];
  creatorRemainderBps: number;
}

interface TrustResponse {
  baseSymbol?: string;
  baseName?: string;
  quoteSymbol?: string;
}

interface LiveFees {
  baseRaw: string | null;
  quoteRaw: string | null;
  baseDecimals: number;
  quoteDecimals: number;
  ok: boolean;
}

function shortWallet(w: string): string {
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

function displayName(r: EffectiveFeeSplitRecipient, i: number): string {
  if (r.handle) return `@${r.handle}`;
  if (r.effectiveWallet) return shortWallet(r.effectiveWallet);
  if (r.wallet) return shortWallet(r.wallet);
  return `Recipient ${i + 1}`;
}

export default function FeesWaitingPage() {
  const router = useRouter();
  const poolAddress =
    typeof router.query.poolAddress === 'string'
      ? router.query.poolAddress
      : null;
  const [splits, setSplits] = useState<FeeSplitsResponse | null>(null);
  const [trust, setTrust] = useState<TrustResponse | null>(null);
  const [live, setLive] = useState<LiveFees | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!router.isReady || !poolAddress) return;
    let cancelled = false;
    (async () => {
      try {
        const [sRes, tRes] = await Promise.all([
          fetch(`/api/pools/${poolAddress}/fee-splits`),
          fetch(`/api/pools/${poolAddress}/trust`),
        ]);
        if (!sRes.ok) throw new Error('Pool not found or has no fee splits');
        const sJson = (await sRes.json()) as FeeSplitsResponse;
        if (cancelled) return;
        setSplits(sJson);
        if (tRes.ok) {
          const tJson = (await tRes.json()) as TrustResponse;
          if (!cancelled) setTrust(tJson);
        }
        // Live unclaimed creator fees, read straight from the chain
        // through the same origin RPC proxy the app uses everywhere.
        try {
          const tracked = {
            poolAddress: sJson.poolAddress,
            configAddress: sJson.configAddress,
            baseMint: sJson.baseMint,
            quoteMint: sJson.quoteMint,
          } as TrackedPool;
          const st = await fetchPoolLiveState(tracked);
          if (!cancelled) {
            setLive({
              baseRaw: st.creatorBaseFeeRaw,
              quoteRaw: st.creatorQuoteFeeRaw,
              baseDecimals: st.baseDecimals,
              quoteDecimals: st.quoteDecimals,
              ok:
                st.creatorBaseFeeRaw !== null || st.creatorQuoteFeeRaw !== null,
            });
          }
        } catch {
          if (!cancelled)
            setLive({
              baseRaw: null,
              quoteRaw: null,
              baseDecimals: 9,
              quoteDecimals: 9,
              ok: false,
            });
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Could not load this page');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router.isReady, poolAddress]);

  const pageUrl = useMemo(() => {
    if (typeof window === 'undefined' || !poolAddress) return '';
    return `${window.location.origin}/fees/${poolAddress}`;
  }, [poolAddress]);

  const shareText = 'Fees waiting on this Curv launch';
  const shareHref = useMemo(() => {
    const params = new URLSearchParams({ text: shareText, url: pageUrl });
    return `https://x.com/intent/tweet?${params.toString()}`;
  }, [pageUrl]);

  const copyLink = async () => {
    if (!pageUrl) return;
    await navigator.clipboard.writeText(pageUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const [copiedInvite, setCopiedInvite] = useState<number | null>(null);
  const copyInvite = async (invite: string, i: number) => {
    try {
      await navigator.clipboard.writeText(invite);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = invite;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedInvite(i);
    window.setTimeout(
      () => setCopiedInvite((cur) => (cur === i ? null : cur)),
      2000
    );
  };

  const tokenName = trust?.baseName || trust?.baseSymbol || 'this token';
  const baseSymbol = trust?.baseSymbol ?? 'tokens';
  const quoteSymbol = trust?.quoteSymbol ?? 'tokens';

  const totalBase = live?.baseRaw
    ? formatFeeRaw(live.baseRaw, live.baseDecimals)
    : null;
  const totalQuote = live?.quoteRaw
    ? formatFeeRaw(live.quoteRaw, live.quoteDecimals)
    : null;

  return (
    <Page>
      <div
        style={{
          maxWidth: 640,
          margin: '0 auto',
          width: '100%',
          padding: '32px 16px',
        }}
      >
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
          Fees waiting
        </h1>
        <p style={{ fontSize: 15, color: '#9db4a3', marginBottom: 20 }}>
          {splits
            ? `Creator fees set aside for collaborators on ${tokenName}. Paid out automatically when the pool creator claims.`
            : 'Loading…'}
        </p>

        {error && <p style={{ color: '#f87171' }}>{error}</p>}

        {splits && live && (
          <div
            style={{
              border: '1px solid #1f2937',
              borderRadius: 12,
              padding: 16,
              marginBottom: 20,
              background: '#11161f',
            }}
          >
            <div
              style={{
                fontSize: 12,
                textTransform: 'uppercase',
                letterSpacing: 1,
                color: '#9db4a3',
              }}
            >
              Unclaimed creator fees right now
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>
              {totalBase !== null || totalQuote !== null ? (
                <>
                  {totalBase !== null && (
                    <span>
                      {totalBase} {baseSymbol}
                    </span>
                  )}
                  {totalBase !== null && totalQuote !== null && (
                    <span> · </span>
                  )}
                  {totalQuote !== null && (
                    <span>
                      {totalQuote} {quoteSymbol}
                    </span>
                  )}
                </>
              ) : (
                <span
                  style={{ fontSize: 15, fontWeight: 400, color: '#9db4a3' }}
                >
                  {live.ok
                    ? 'Nothing accrued yet'
                    : 'Could not read the chain just now'}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: '#9db4a3', marginTop: 6 }}>
              Read live from the chain, not estimated.
            </div>
          </div>
        )}

        {splits && (
          <div>
            {splits.recipients.map((r, i) => {
              const bound = !!r.effectiveWallet;
              const shareBase = live?.baseRaw
                ? splitShareRaw(live.baseRaw, r.bps)
                : null;
              const shareQuote = live?.quoteRaw
                ? splitShareRaw(live.quoteRaw, r.bps)
                : null;
              const b =
                shareBase && live
                  ? formatFeeRaw(shareBase, live.baseDecimals)
                  : null;
              const q =
                shareQuote && live
                  ? formatFeeRaw(shareQuote, live.quoteDecimals)
                  : null;
              const invite =
                typeof window !== 'undefined' && poolAddress
                  ? `${window.location.origin}/claim/onboard/${poolAddress}/${i}`
                  : '';
              return (
                <div
                  key={i}
                  style={{
                    border: '1px solid #1f2937',
                    borderRadius: 12,
                    padding: 14,
                    marginBottom: 10,
                    background: '#11161f',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <strong style={{ fontSize: 16 }}>
                      {displayName(r, i)}
                    </strong>
                    <span style={{ fontSize: 14, color: '#9db4a3' }}>
                      {(r.bps / 100).toFixed(2)}%
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: bound ? '#34d399' : '#fbbf24',
                      marginTop: 6,
                    }}
                  >
                    {bound
                      ? 'Wallet bound, payouts automatic'
                      : 'No wallet bound yet'}
                    {r.handle &&
                      r.effectiveWallet &&
                      ` · ${shortWallet(r.effectiveWallet)}`}
                  </div>
                  {(b !== null || q !== null) && (
                    <div
                      style={{ fontSize: 13, color: '#9db4a3', marginTop: 4 }}
                    >
                      Share of unclaimed:{' '}
                      {[
                        b ? `${b} ${baseSymbol}` : null,
                        q ? `${q} ${quoteSymbol}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                  {!bound && invite && (
                    <div style={{ marginTop: 6 }}>
                      <a
                        href={invite}
                        style={{
                          fontSize: 13,
                          color: '#c4f0c8',
                          textDecoration: 'underline',
                          display: 'inline-block',
                        }}
                      >
                        Bind a wallet to claim this share
                      </a>
                      <button
                        type="button"
                        onClick={() => copyInvite(invite, i)}
                        style={{
                          fontSize: 12,
                          color: '#9db4a3',
                          background: 'transparent',
                          border: '1px solid #1f2937',
                          borderRadius: 8,
                          padding: '4px 10px',
                          marginLeft: 10,
                          cursor: 'pointer',
                        }}
                      >
                        {copiedInvite === i ? 'Copied' : 'Copy invite link'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {pageUrl && (
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button
              type="button"
              className="sc-button sc-button-secondary"
              onClick={copyLink}
            >
              {copied ? 'Link copied' : 'Copy link'}
            </button>
            <a
              href={shareHref}
              target="_blank"
              rel="noreferrer"
              className="sc-button sc-button-primary"
              style={{ textDecoration: 'none', display: 'inline-block' }}
            >
              Share on X
            </a>
          </div>
        )}
      </div>
    </Page>
  );
}
