import { useState } from 'react';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import { formatRawAmount } from '@/components/Bounty/amounts';
import {
  duelLoserWallet,
  duelWinnerWallet,
  formatCountdown,
  pickDuelForPool,
  shortWallet,
  useDuelDetail,
  useDuelList,
  useQuoteMeta,
  type Duel,
  type DuelStatus,
} from './duel';
import {
  DuelCoinAvatar,
  DuelRaceBar,
  DuelStatusPill,
  VsMedallion,
} from './DuelBits';
import DuelActionButtons from './DuelActions';
import ChallengeWizard from './ChallengeWizard';

function CardShell({
  children,
  settled = false,
}: {
  children: React.ReactNode;
  settled?: boolean;
}) {
  return (
    <section
      aria-label="Coin duel"
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0d1110] px-5 py-5"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-28"
        style={{
          background: settled
            ? 'radial-gradient(ellipse at top, #e8b64c14, transparent 70%)'
            : 'radial-gradient(ellipse at top, #32f27b12, transparent 70%)',
        }}
      />
      <div className="relative">{children}</div>
    </section>
  );
}

function DuelHead({ status, duelId }: { status: DuelStatus; duelId: number }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <p className="text-[11px] font-bold tracking-[0.25em] text-neutral-400">
        COIN DUEL <span className="text-neutral-600">#{duelId}</span>
      </p>
      <DuelStatusPill status={status} />
    </div>
  );
}

function VersusRows({ duelId, aAddr, bAddr }: { duelId: number; aAddr: string; bAddr: string }) {
  const detail = useDuelDetail(duelId);
  const d = detail.data;
  if (detail.isLoading) {
    return <div className="h-24 animate-pulse rounded-xl bg-white/[0.04]" />;
  }
  if (!d || !d.poolA || !d.poolB) return null;
  const { poolA, poolB } = d;
  const aWon = d.duel.winnerPool === poolA.poolAddress;
  const bWon = d.duel.winnerPool === poolB.poolAddress;
  const settled = d.duel.status === 'settled';
  return (
    <div>
      {/* Desktop: side by side. Mobile: stacked with a horizontal VS divider. */}
      <div className="hidden items-center gap-4 sm:flex">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <DuelCoinAvatar imageUrl={poolA.imageUrl} symbol={poolA.symbol} />
          <div className="min-w-0">
            <p className="truncate text-base font-bold text-neutral-50">${poolA.symbol}</p>
            <Link href={`/token/${aAddr}`} className="text-[11px] text-neutral-500 hover:text-neutral-300 hover:underline">
              View coin
            </Link>
          </div>
        </div>
        <VsMedallion size="sm" />
        <div className="flex min-w-0 flex-1 items-center justify-end gap-3 text-right">
          <div className="min-w-0">
            <p className="truncate text-base font-bold text-neutral-50">${poolB.symbol}</p>
            <Link href={`/token/${bAddr}`} className="text-[11px] text-neutral-500 hover:text-neutral-300 hover:underline">
              View coin
            </Link>
          </div>
          <DuelCoinAvatar imageUrl={poolB.imageUrl} symbol={poolB.symbol} />
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:hidden">
        <div className="flex items-center gap-3">
          <DuelCoinAvatar imageUrl={poolA.imageUrl} symbol={poolA.symbol} size={44} />
          <p className="truncate text-base font-bold text-neutral-50">${poolA.symbol}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-white/10" />
          <VsMedallion size="sm" />
          <div className="h-px flex-1 bg-white/10" />
        </div>
        <div className="flex items-center gap-3">
          <DuelCoinAvatar imageUrl={poolB.imageUrl} symbol={poolB.symbol} size={44} />
          <p className="truncate text-base font-bold text-neutral-50">${poolB.symbol}</p>
        </div>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <DuelRaceBar pool={poolA} compact accent={settled ? (aWon ? 'gold' : 'dim') : 'green'} />
        <DuelRaceBar pool={poolB} compact accent={settled ? (bWon ? 'gold' : 'dim') : 'green'} />
      </div>
    </div>
  );
}

function LiveDuelBody({ duel }: { duel: Duel }) {
  const now = Date.now();
  const detail = useDuelDetail(duel.id);
  const terms = detail.data?.terms;

  return (
    <div>
      <VersusRows duelId={duel.id} aAddr={duel.poolA} bAddr={duel.poolB} />
      <p className="mt-4 text-center text-sm leading-relaxed text-neutral-300">
        Winner takes the loser creator fees
        {terms ? ` for ${terms.forfeitDays} days after graduation` : ''}.
      </p>
      <div className="mt-4">
        <DuelActionButtons duel={duel} />
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-neutral-400">
          {duel.status === 'active' && duel.expiresAt
            ? formatCountdown(duel.expiresAt, now)
            : duel.status === 'challenged'
              ? `Challenged by ${shortWallet(duel.challengerWallet)}`
              : ''}
        </span>
        <Link
          href={`/duels/${duel.id}`}
          className="inline-flex h-11 items-center rounded-xl border border-[#32f27b]/30 bg-[#32f27b]/[0.06] px-5 text-sm font-bold text-[#32f27b] transition hover:bg-[#32f27b]/[0.12]"
        >
          View duel
        </Link>
      </div>
    </div>
  );
}

function SettledDuelBody({ duel }: { duel: Duel }) {
  const detail = useDuelDetail(duel.id);
  const totals = detail.data?.forfeitTotals;
  const loser = duelLoserWallet(duel);
  const winner = duelWinnerWallet(duel);
  const quote = useQuoteMeta(duel.loserPool);
  const quoteDecimals = quote.data?.quoteDecimals ?? 9;
  const quoteSymbol = quote.data?.quoteSymbol ?? 'SOL';
  const redirected =
    totals && (totals.quoteRaw !== '0' || totals.baseRaw !== '0')
      ? formatRawAmount(totals.quoteRaw, quoteDecimals, quoteSymbol)
      : null;

  return (
    <div>
      <VersusRows duelId={duel.id} aAddr={duel.poolA} bAddr={duel.poolB} />
      <div
        className="mt-4 rounded-xl border px-4 py-3 text-center"
        style={{ borderColor: '#e8b64c44', background: '#e8b64c0d' }}
      >
        <p className="text-sm font-bold text-[#e8b64c]">
          {winner ? shortWallet(winner) : 'The winner'} takes the pot
        </p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          {redirected
            ? `${redirected} redirected to the winner so far`
            : 'No forfeit payouts yet. They land when the loser claims'}
          {loser ? ` · loser ${shortWallet(loser)}` : ''}
        </p>
      </div>
      <div className="mt-4 flex justify-end">
        <Link
          href={`/duels/${duel.id}`}
          className="inline-flex h-11 items-center rounded-xl border border-[#e8b64c]/30 bg-[#e8b64c]/[0.06] px-5 text-sm font-bold text-[#e8b64c] transition hover:bg-[#e8b64c]/[0.12]"
        >
          View result
        </Link>
      </div>
    </div>
  );
}

function FinishedDuelBody({ duel }: { duel: Duel }) {
  const label =
    duel.status === 'drawn'
      ? 'Both coins crossed the line together. No fees moved.'
      : duel.status === 'expired'
        ? 'Neither coin graduated in time. No fees moved.'
        : 'This duel was called off. No fees moved.';
  return (
    <div>
      <VersusRows duelId={duel.id} aAddr={duel.poolA} bAddr={duel.poolB} />
      <p className="mt-4 text-center text-sm text-neutral-400">{label}</p>
      <div className="mt-4 flex justify-end">
        <Link
          href={`/duels/${duel.id}`}
          className="inline-flex h-11 items-center rounded-xl border border-white/15 px-5 text-sm font-bold text-neutral-300 transition hover:border-white/30"
        >
          View duel
        </Link>
      </div>
    </div>
  );
}

function NoDuelEntry({ poolAddress }: { poolAddress: string }) {
  const { connected } = useWallet();
  const [wizardOpen, setWizardOpen] = useState(false);
  if (!connected) return null;
  return (
    <CardShell>
      <div className="flex flex-col items-center gap-3 py-2 text-center sm:flex-row sm:text-left">
        <VsMedallion size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold tracking-[0.25em] text-neutral-400">COIN DUEL</p>
          <p className="mt-1 text-sm leading-relaxed text-neutral-300">
            Think this coin graduates first? Challenge it and put your creator fees on the line.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          className="inline-flex h-11 w-full shrink-0 items-center justify-center rounded-xl bg-[#32f27b] px-6 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] sm:w-auto"
        >
          Challenge this coin
        </button>
      </div>
      {wizardOpen && (
        <ChallengeWizard
          poolB={poolAddress}
          onClose={() => setWizardOpen(false)}
          onCreated={() => setWizardOpen(false)}
        />
      )}
    </CardShell>
  );
}

/**
 * Versus strip for the token page. Shows the live race, accept/decline
 * for the challenged creator, the settled result, or a challenge entry.
 */
export default function DuelCard({ poolAddress }: { poolAddress: string }) {
  const list = useDuelList(50);
  const duel = list.data ? pickDuelForPool(list.data.duels, poolAddress) : null;

  if (list.isLoading) {
    return (
      <CardShell>
        <div className="h-28 animate-pulse rounded-xl bg-white/[0.04]" />
      </CardShell>
    );
  }
  if (list.isError || !duel) {
    return <NoDuelEntry poolAddress={poolAddress} />;
  }

  return (
    <CardShell settled={duel.status === 'settled'}>
      <DuelHead status={duel.status} duelId={duel.id} />
      {duel.status === 'challenged' || duel.status === 'active' ? (
        <LiveDuelBody duel={duel} />
      ) : duel.status === 'settled' ? (
        <SettledDuelBody duel={duel} />
      ) : (
        <FinishedDuelBody duel={duel} />
      )}
    </CardShell>
  );
}
