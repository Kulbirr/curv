import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import bs58 from 'bs58';
import { buildDuelActionMessage } from '@/lib/signature-messages';
import type { Duel } from './duel';
import { cn } from '@/lib/utils';

type DuelAction = 'accept' | 'decline' | 'cancel';

/**
 * Accept / Decline (challenged creator) and Cancel (challenger) buttons
 * for a challenged duel. Renders nothing for anyone else.
 */
export default function DuelActionButtons({
  duel,
  layout = 'row',
}: {
  duel: Duel;
  layout?: 'row' | 'stack';
}) {
  const { publicKey, signMessage, connected } = useWallet();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<DuelAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (duel.status !== 'challenged') return null;
  const wallet = publicKey?.toBase58() ?? null;
  const isChallenged = connected && wallet === duel.challengedWallet;
  const isChallenger = connected && wallet === duel.challengerWallet;
  if (!isChallenged && !isChallenger) return null;

  const act = async (action: DuelAction) => {
    setError(null);
    if (!connected || !publicKey || !signMessage) {
      setError('Connect the creator wallet to sign.');
      return;
    }
    setBusy(action);
    try {
      const timestamp = Date.now();
      const message = buildDuelActionMessage(duel.poolA, duel.poolB, action, duel.id, timestamp);
      const sigBytes = await signMessage(new TextEncoder().encode(message));
      const res = await fetch(`/api/duels/${duel.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          timestamp,
          signature: bs58.encode(sigBytes),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error || 'Action failed. Try again.');
      await queryClient.invalidateQueries({ queryKey: ['duels'] });
      await queryClient.invalidateQueries({ queryKey: ['duel'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const primary =
    'inline-flex h-11 items-center justify-center rounded-xl bg-[#32f27b] px-6 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60';
  const ghost =
    'inline-flex h-11 items-center justify-center rounded-xl border border-white/15 bg-white/[0.04] px-6 text-sm font-bold text-neutral-200 transition hover:border-white/30 disabled:opacity-60';

  return (
    <div>
      {isChallenged && (
        <div
          className={cn(
            'rounded-2xl border border-amber-400/25 bg-amber-400/[0.05] px-4 py-4',
          )}
        >
          <p className="text-sm leading-relaxed text-amber-200">
            You were challenged. Accept and the race is on, or decline and walk away.
          </p>
          <div className={cn('mt-3 gap-2', layout === 'stack' ? 'grid' : 'grid grid-cols-2')}>
            <button type="button" disabled={busy !== null} onClick={() => void act('accept')} className={primary}>
              {busy === 'accept' ? 'Signing…' : 'Accept duel'}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void act('decline')} className={ghost}>
              {busy === 'decline' ? 'Signing…' : 'Decline'}
            </button>
          </div>
        </div>
      )}
      {isChallenger && (
        <div className="flex justify-center">
          <button type="button" disabled={busy !== null} onClick={() => void act('cancel')} className={ghost}>
            {busy === 'cancel' ? 'Signing…' : 'Cancel challenge'}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-center text-sm text-[#fa6d74]">
          {error}
        </p>
      )}
    </div>
  );
}
