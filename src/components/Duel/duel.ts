import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/components/Pool/usePoolData';

/** Mirror of the server Duel row (src/lib/db/duels.ts). Client copy. */
export type DuelStatus =
  | 'challenged'
  | 'active'
  | 'settled'
  | 'expired'
  | 'cancelled'
  | 'drawn';

export interface Duel {
  id: number;
  poolA: string;
  poolB: string;
  challengerWallet: string;
  challengedWallet: string;
  status: DuelStatus;
  forfeitScope: string;
  forfeitDays: number;
  createdAt: number;
  activatedAt: number | null;
  expiresAt: number | null;
  settledAt: number | null;
  forfeitEndsAt: number | null;
  winnerPool: string | null;
  loserPool: string | null;
}

/** One side of a duel, from GET /api/duels/[id]. */
export interface DuelPoolCard {
  poolAddress: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  creator: string;
  quoteSymbol: string;
  progress: number | null;
  graduated: boolean;
  graduatedAt: number | null;
  /** Already in UI units (SOL etc.), null when unknown. */
  quoteToGraduate: number | null;
  creatorBuysShare: number | null;
}

export interface DuelForfeitPayout {
  id: number;
  duelId: number;
  poolAddress: string;
  winnerWallet: string;
  baseAmountRaw: string;
  quoteAmountRaw: string;
  quoteMint: string;
  txSignature: string;
  paidAt: number;
}

export interface DuelTerms {
  prize: string;
  forfeitDays: number;
  winnerRule: string;
  drawRule: string;
  expiryDays: number;
  recipientProtection: string;
  honestNote: string;
}

export interface DuelDetail {
  duel: Duel;
  poolA: DuelPoolCard | null;
  poolB: DuelPoolCard | null;
  forfeitPayouts: DuelForfeitPayout[];
  forfeitTotals: { baseRaw: string; quoteRaw: string };
  terms: DuelTerms;
}

/** Status pill styling and label. Fight night copy, no dashes. */
export function duelStatusMeta(status: DuelStatus): { label: string; className: string; live: boolean } {
  switch (status) {
    case 'active':
      return {
        label: 'LIVE',
        className: 'border-[#32f27b]/50 bg-[#32f27b]/15 text-[#32f27b]',
        live: true,
      };
    case 'challenged':
      return {
        label: 'AWAITING ACCEPT',
        className: 'border-amber-400/50 bg-amber-400/10 text-amber-300',
        live: false,
      };
    case 'settled':
      return {
        label: 'SETTLED',
        className: 'border-[#e8b64c]/50 bg-[#e8b64c]/10 text-[#e8b64c]',
        live: false,
      };
    case 'drawn':
      return { label: 'DRAW', className: 'border-white/20 bg-white/5 text-neutral-300', live: false };
    case 'expired':
      return { label: 'EXPIRED', className: 'border-white/20 bg-white/5 text-neutral-400', live: false };
    case 'cancelled':
      return { label: 'CANCELLED', className: 'border-white/20 bg-white/5 text-neutral-500', live: false };
  }
}

export function shortWallet(w: string): string {
  return w.length > 8 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

export function formatDuelDate(ts: number | null): string {
  if (ts == null) return 'unknown';
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return 'unknown';
  }
}

/** "12d 4h left", "3h 20m left", "45m left", or "ended". */
export function formatCountdown(endsAt: number | null, now: number): string {
  if (endsAt == null) return 'no deadline';
  const ms = endsAt - now;
  if (ms <= 0) return 'ended';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${mm}m left`;
  return `${mm}m left`;
}

export function formatForfeitCountdown(endsAt: number | null, now: number): string {
  if (endsAt == null) return 'no end date';
  const ms = endsAt - now;
  if (ms <= 0) return 'window closed';
  const d = Math.floor(ms / 86400000);
  if (d > 0) return `${d} days left in the forfeit window`;
  const h = Math.floor(ms / 3600000);
  return `${h} hours left in the forfeit window`;
}

/** Winner wallet from a settled duel row. */
export function duelWinnerWallet(duel: Duel): string | null {
  if (!duel.winnerPool) return null;
  return duel.winnerPool === duel.poolA ? duel.challengerWallet : duel.challengedWallet;
}

/** Loser wallet from a settled duel row. */
export function duelLoserWallet(duel: Duel): string | null {
  if (!duel.loserPool) return null;
  return duel.loserPool === duel.poolA ? duel.challengerWallet : duel.challengedWallet;
}

export function useDuelList(limit = 50) {
  return useQuery({
    queryKey: ['duels', 'list', limit],
    queryFn: () => fetchJson<{ duels: Duel[] }>(`/api/duels?limit=${limit}`),
    staleTime: 30_000,
    retry: 1,
  });
}

export function useDuelDetail(id: number | null) {
  return useQuery({
    queryKey: ['duel', id],
    queryFn: () => fetchJson<DuelDetail>(`/api/duels/${id}`),
    enabled: id != null && id > 0,
    staleTime: 20_000,
    retry: 1,
  });
}

/** Prefer the live duel for a pool; fall back to the most recent finished one. */
export function pickDuelForPool(duels: Duel[], poolAddress: string): Duel | null {
  const mine = duels.filter((d) => d.poolA === poolAddress || d.poolB === poolAddress);
  if (mine.length === 0) return null;
  const live = mine.find((d) => d.status === 'active' || d.status === 'challenged');
  if (live) return live;
  const rank = (d: Duel) => d.settledAt ?? d.activatedAt ?? d.createdAt;
  return [...mine].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

/** Quote symbol/decimals for a pool (from the trust endpoint), for formatting raw amounts. */
export function useQuoteMeta(poolAddress: string | null) {
  return useQuery({
    queryKey: ['pool-trust-quote', poolAddress],
    queryFn: () =>
      fetchJson<{ quoteSymbol?: string; quoteDecimals?: number }>(
        `/api/pools/${poolAddress}/trust`,
      ),
    enabled: !!poolAddress,
    staleTime: 10 * 60_000,
    retry: 1,
  });
}

/** Group the fight card: active, challenged, settled, then the rest. */
export function groupDuels(duels: Duel[]): {
  active: Duel[];
  challenged: Duel[];
  settled: Duel[];
  rest: Duel[];
} {
  const active = duels.filter((d) => d.status === 'active');
  const challenged = duels.filter((d) => d.status === 'challenged');
  const settled = duels.filter((d) => d.status === 'settled' || d.status === 'drawn');
  const rest = duels.filter(
    (d) => d.status === 'expired' || d.status === 'cancelled',
  );
  return { active, challenged, settled, rest };
}
