import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { useWallet } from '@solana/wallet-adapter-react';
import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import bs58 from 'bs58';
import Page from '@/components/ui/Page/Page';
import { buildRecipientBindingMessage } from '@/lib/signature-messages';
import type { EffectiveFeeSplitRecipient } from '@/lib/fee-split-terms';

interface FeeSplitsResponse {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  configAddress: string;
  creator: string;
  recipients: EffectiveFeeSplitRecipient[];
  creatorRemainderBps: number;
}

interface TrustResponse {
  baseSymbol?: string;
  baseName?: string;
  quoteSymbol?: string;
}

type View =
  | { kind: 'loading' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ready' }
  | { kind: 'binding' }
  | { kind: 'done'; wallet: string }
  | { kind: 'error'; message: string };

function shortWallet(w: string): string {
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

export default function RecipientOnboardingPage() {
  const router = useRouter();
  const { publicKey, connected, signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const [splits, setSplits] = useState<FeeSplitsResponse | null>(null);
  const [trust, setTrust] = useState<TrustResponse | null>(null);
  const [view, setView] = useState<View>({ kind: 'loading' });

  const pool = typeof router.query.pool === 'string' ? router.query.pool : null;
  const entryIndex = useMemo(() => {
    const raw = router.query.entry;
    const n = typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isInteger(n) && n >= 0 ? n : null;
  }, [router.query.entry]);

  useEffect(() => {
    if (!router.isReady || !pool || entryIndex === null) return;
    let cancelled = false;
    (async () => {
      try {
        const [sRes, tRes] = await Promise.all([
          fetch(`/api/pools/${pool}/fee-splits`),
          fetch(`/api/pools/${pool}/trust`),
        ]);
        if (!sRes.ok) throw new Error('Pool not found or has no fee splits');
        const sJson = (await sRes.json()) as FeeSplitsResponse;
        if (cancelled) return;
        setSplits(sJson);
        if (tRes.ok) {
          const tJson = (await tRes.json()) as TrustResponse;
          if (!cancelled) setTrust(tJson);
        }
        const entry = sJson.recipients[entryIndex];
        if (!entry) {
          setView({
            kind: 'invalid',
            message: 'This invite link does not match a split entry.',
          });
          return;
        }
        const bound = entry.bound || entry.effectiveWallet;
        if (bound) {
          setView({
            kind: 'done',
            wallet: String(entry.effectiveWallet ?? entry.wallet ?? ''),
          });
          return;
        }
        setView({ kind: 'ready' });
      } catch (e) {
        if (!cancelled) {
          setView({
            kind: 'invalid',
            message: 'Could not load this invite link.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router.isReady, pool, entryIndex]);

  const entry: EffectiveFeeSplitRecipient | null =
    splits && entryIndex !== null
      ? (splits.recipients[entryIndex] ?? null)
      : null;
  const entryName = entry
    ? entry.handle
      ? `@${entry.handle}`
      : entry.wallet
        ? shortWallet(entry.wallet)
        : `Recipient ${entryIndex! + 1}`
    : '';
  const sharePct = entry ? (entry.bps / 100).toFixed(2) : '';
  const tokenName = trust?.baseName || trust?.baseSymbol || 'this token';

  const bind = useCallback(async () => {
    if (!pool || entryIndex === null || !publicKey || !signMessage) return;
    setView({ kind: 'binding' });
    try {
      const wallet = publicKey.toBase58();
      const timestamp = Date.now();
      const message = buildRecipientBindingMessage(
        pool,
        entryIndex,
        wallet,
        timestamp
      );
      const sigBytes = await signMessage(new TextEncoder().encode(message));
      const res = await fetch(`/api/pools/${pool}/bindings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryIndex,
          wallet,
          timestamp,
          signature: bs58.encode(sigBytes),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || 'Binding failed');
      setView({ kind: 'done', wallet });
      setSplits((s) =>
        s
          ? {
              ...s,
              recipients: s.recipients.map((r, i) =>
                i === entryIndex
                  ? { ...r, bound: true, effectiveWallet: wallet }
                  : r
              ),
            }
          : s
      );
    } catch (e) {
      setView({
        kind: 'error',
        message:
          e instanceof Error ? e.message : 'Binding failed, please try again',
      });
    }
  }, [pool, entryIndex, publicKey, signMessage]);

  return (
    <Page>
      <div
        style={{
          maxWidth: 560,
          margin: '0 auto',
          width: '100%',
          padding: '32px 16px',
        }}
      >
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
          Claim your share
        </h1>

        {view.kind === 'loading' && <p>Loading your invite…</p>}

        {view.kind === 'invalid' && <p>{view.message}</p>}

        {(view.kind === 'ready' ||
          view.kind === 'binding' ||
          view.kind === 'error') &&
          entry && (
            <div>
              <p style={{ fontSize: 16, lineHeight: 1.6 }}>
                This pool set aside <strong>{sharePct}%</strong> of its creator
                fees for <strong>{entryName}</strong> on {tokenName}. Connect
                the wallet you want payouts sent to, then sign once to bind it.
                The first signature wins and the binding is permanent.
              </p>
              {!connected ? (
                <button
                  type="button"
                  className="sc-button sc-button-primary"
                  onClick={() => setShowModal(true)}
                  style={{ marginTop: 16 }}
                >
                  Connect wallet
                </button>
              ) : (
                <div style={{ marginTop: 16 }}>
                  <p style={{ fontSize: 13, color: '#9db4a3' }}>
                    Connected as {shortWallet(publicKey!.toBase58())}
                  </p>
                  <button
                    type="button"
                    className="sc-button sc-button-primary"
                    onClick={bind}
                    disabled={view.kind === 'binding'}
                    style={{ marginTop: 8 }}
                  >
                    {view.kind === 'binding'
                      ? 'Waiting for signature…'
                      : 'Sign and bind wallet'}
                  </button>
                </div>
              )}
              {view.kind === 'error' && (
                <p style={{ color: '#f87171', marginTop: 12 }}>
                  {view.message}
                </p>
              )}
              <p style={{ fontSize: 12, color: '#9db4a3', marginTop: 16 }}>
                Nothing moves until the pool creator claims fees. When they do,
                your share is paid to your bound wallet automatically in the
                same transaction.
              </p>
            </div>
          )}

        {view.kind === 'done' && (
          <div>
            <p style={{ fontSize: 16, lineHeight: 1.6 }}>
              Wallet bound{view.wallet ? ` to ${shortWallet(view.wallet)}` : ''}
              . Your {sharePct}% share will be paid there automatically whenever
              the creator claims fees from this pool.
            </p>
            {pool && (
              <a
                href={`/token/${pool}`}
                style={{ color: '#c4f0c8', textDecoration: 'underline' }}
              >
                View the pool
              </a>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
