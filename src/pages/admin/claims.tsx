import { useCallback, useEffect, useMemo, useState } from 'react';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { useWallet, useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import Page from '@/components/ui/Page/Page';
import CurvyLoader from '@/components/CurvyLoader';
import { getConnection } from '@/lib/solana';

const FEE_WALLET = process.env.NEXT_PUBLIC_CURV_FEE_WALLET ?? '';

type ClaimKind = 'trading' | 'migration' | 'creation';

interface PoolRow {
  poolAddress: string;
  baseSymbol?: string;
  quoteSymbol?: string;
  graduated?: boolean;
}

interface Claimable {
  baseRaw: string | null;
  quoteRaw: string | null;
}

function shortAddr(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function hasClaimable(c: Claimable | null) {
  if (!c) return false;
  return (c.baseRaw && c.baseRaw !== '0') || (c.quoteRaw && c.quoteRaw !== '0');
}

export default function AdminClaimsPage() {
  const { publicKey, signTransaction, connected } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [claimables, setClaimables] = useState<Record<string, Claimable | null>>({});
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isFeeWallet = useMemo(
    () => !!publicKey && !!FEE_WALLET && publicKey.toBase58() === FEE_WALLET,
    [publicKey]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/pools');
        const json = await res.json();
        const list: PoolRow[] = Array.isArray(json?.pools) ? json.pools : [];
        if (cancelled) return;
        setPools(list);
        // Fetch claimables for each pool
        const entries = await Promise.all(
          list.map(async (p) => {
            try {
              const r = await fetch(`/api/claims/partner/claimable?poolAddress=${p.poolAddress}`);
              if (!r.ok) return [p.poolAddress, null] as const;
              const j = await r.json();
              return [p.poolAddress, { baseRaw: j.baseRaw ?? null, quoteRaw: j.quoteRaw ?? null }] as const;
            } catch {
              return [p.poolAddress, null] as const;
            }
          })
        );
        if (cancelled) return;
        setClaimables(Object.fromEntries(entries));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const claim = useCallback(
    async (poolAddress: string, kind: ClaimKind) => {
      if (!publicKey || !signTransaction) return;
      const key = `${poolAddress}:${kind}`;
      setClaiming(key);
      setError(null);
      setStatus(null);
      try {
        setStatus('Building the claim transaction…');
        const buildRes = await fetch('/api/claims/partner/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            poolAddress,
            kind,
            feeWallet: publicKey.toBase58(),
          }),
        });
        if (!buildRes.ok) {
          const j = await buildRes.json().catch(() => ({}));
          throw new Error(j.error ?? 'Failed to build the claim transaction');
        }
        const { transaction, lastValidBlockHeight } = await buildRes.json();
        const tx = Transaction.from(Buffer.from(transaction, 'base64'));

        setStatus('Waiting for your signature in the wallet…');
        const signed = await signTransaction(tx);

        setStatus('Sending to the network…');
        const connection: Connection = getConnection();
        const sig = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
        });

        setStatus('Confirming…');
        await connection.confirmTransaction(
          {
            signature: sig,
            blockhash: tx.recentBlockhash!,
            lastValidBlockHeight,
          },
          'confirmed'
        );

        setStatus(`Claimed. Signature: ${sig}`);
        // Refresh the claimable for this pool
        const r = await fetch(`/api/claims/partner/claimable?poolAddress=${poolAddress}`);
        if (r.ok) {
          const j = await r.json();
          setClaimables((prev) => ({
            ...prev,
            [poolAddress]: { baseRaw: j.baseRaw ?? null, quoteRaw: j.quoteRaw ?? null },
          }));
        }
      } catch (e) {
        setError((e as Error).message);
        setStatus(null);
      } finally {
        setClaiming(null);
      }
    },
    [publicKey, signTransaction]
  );

  return (
    <Page>
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-bold">Fee claims</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Claim Curv&apos;s fee share by connecting the fee wallet and signing yourself. The server
          never sees the key.
        </p>

        {!connected || !publicKey ? (
          <div className="mt-6 rounded-xl border border-border p-6 text-center">
            <p className="text-sm text-muted-foreground">Connect the fee wallet to continue.</p>
            <button
              onClick={() => setShowModal(true)}
              className="mt-4 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Connect wallet
            </button>
          </div>
        ) : !isFeeWallet ? (
          <div className="mt-6 rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center">
            <p className="text-sm font-medium">
              Connected wallet is not the Curv fee wallet.
            </p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {shortAddr(publicKey.toBase58())} · expected {FEE_WALLET ? shortAddr(FEE_WALLET) : 'unset'}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Switch to the fee wallet to claim.
            </p>
          </div>
        ) : loading ? (
          <div className="mt-10 flex justify-center">
            <CurvyLoader />
          </div>
        ) : error && pools.length === 0 ? (
          <p className="mt-6 text-sm text-destructive">{error}</p>
        ) : (
          <div className="mt-6 space-y-3">
            {pools.length === 0 && (
              <p className="text-sm text-muted-foreground">No pools tracked yet.</p>
            )}
            {pools.map((p) => {
              const c = claimables[p.poolAddress] ?? null;
              const label = p.baseSymbol
                ? `${p.baseSymbol} / ${p.quoteSymbol ?? ''}`
                : shortAddr(p.poolAddress);
              return (
                <div
                  key={p.poolAddress}
                  className="rounded-xl border border-border p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{label}</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {shortAddr(p.poolAddress)}
                        {p.graduated ? ' · graduated' : ''}
                      </p>
                    </div>
                    <div className="text-right font-mono text-xs text-muted-foreground">
                      {c === undefined ? (
                        '…'
                      ) : hasClaimable(c) ? (
                        <>
                          {c!.baseRaw && c!.baseRaw !== '0' && <div>base: {c!.baseRaw}</div>}
                          {c!.quoteRaw && c!.quoteRaw !== '0' && <div>quote: {c!.quoteRaw}</div>}
                        </>
                      ) : (
                        'nothing to claim'
                      )}
                    </div>
                  </div>
                  {hasClaimable(c) && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(['trading', 'migration', 'creation'] as ClaimKind[]).map((kind) => {
                        // Migration claims only make sense on graduated pools.
                        if (kind === 'migration' && !p.graduated) return null;
                        const k = `${p.poolAddress}:${kind}`;
                        return (
                          <button
                            key={kind}
                            disabled={claiming !== null}
                            onClick={() => claim(p.poolAddress, kind)}
                            className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                          >
                            {claiming === k ? 'Claiming…' : `Claim ${kind}`}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {status && (
          <p className="mt-4 rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs break-all">
            {status}
          </p>
        )}
        {error && pools.length > 0 && (
          <p className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </Page>
  );
}
