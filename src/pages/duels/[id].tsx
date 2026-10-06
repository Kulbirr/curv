import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Page from '@/components/ui/Page/Page';
import { isDevnet } from '@/lib/solana';
import { formatRawAmount } from '@/components/Bounty/amounts';
import {
  formatCountdown,
  formatDuelDate,
  formatForfeitCountdown,
  shortWallet,
  useDuelDetail,
  useQuoteMeta,
  type DuelDetail,
  type DuelPoolCard,
} from '@/components/Duel/duel';
import {
  DuelCoinAvatar,
  DuelRaceBar,
  DuelStatusPill,
  DuelTimelineRow,
  VsMedallion,
} from '@/components/Duel/DuelBits';
import DuelActionButtons from '@/components/Duel/DuelActions';
import { cn } from '@/lib/utils';

function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}${isDevnet() ? '?cluster=devnet' : ''}`;
}

function HeroFighter({
  pool,
  champion,
  dimmed,
}: {
  pool: DuelPoolCard;
  champion: boolean;
  dimmed: boolean;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-col items-center gap-3 text-center',
        dimmed && 'opacity-45 saturate-50',
      )}
    >
      <div className="relative">
        {champion && (
          <span
            className="absolute -top-3 left-1/2 z-10 -translate-x-1/2 rounded-full px-3 py-1 text-[10px] font-black tracking-[0.25em] whitespace-nowrap"
            style={{
              background: 'linear-gradient(90deg, #8a6a2a, #e8b64c, #8a6a2a)',
              color: '#1a1408',
              boxShadow: '0 0 20px #e8b64c77',
            }}
          >
            CHAMPION
          </span>
        )}
        <span
          className={cn('block rounded-full p-1', champion && 'animate-pulse')}
          style={
            champion
              ? { background: 'linear-gradient(135deg, #8a6a2a, #e8b64c)', boxShadow: '0 0 32px #e8b64c55' }
              : undefined
          }
        >
          <DuelCoinAvatar imageUrl={pool.imageUrl} symbol={pool.symbol} size={88} />
        </span>
      </div>
      <div className="min-w-0">
        <p className={cn('truncate text-2xl font-black', champion ? 'text-[#e8b64c]' : 'text-neutral-50')}>
          ${pool.symbol}
        </p>
        <p className="mt-0.5 truncate text-sm text-neutral-500">{pool.name}</p>
        <p className="mt-1 truncate text-[11px] text-neutral-600">
          Creator <span className="font-mono">{shortWallet(pool.creator)}</span>
        </p>
        <Link
          href={`/token/${pool.poolAddress}`}
          className="mt-2 inline-flex h-11 items-center rounded-xl border border-white/15 px-5 text-xs font-bold text-neutral-300 transition hover:border-white/30"
        >
          View coin
        </Link>
      </div>
    </div>
  );
}

function Hero({ detail }: { detail: DuelDetail }) {
  const { duel, poolA, poolB } = detail;
  const settled = duel.status === 'settled';
  const aWon = settled && duel.winnerPool === duel.poolA;
  const bWon = settled && duel.winnerPool === duel.poolB;
  return (
    <section
      aria-label="Duel matchup"
      className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#0b0e0c] px-6 py-8 sm:px-10 sm:py-10"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background: settled
            ? 'radial-gradient(ellipse 60% 50% at 50% 0%, #e8b64c1a, transparent 70%)'
            : 'radial-gradient(ellipse 60% 50% at 50% 0%, #32f27b14, transparent 70%)',
        }}
      />
      <div className="relative">
        <div className="flex items-center justify-center gap-3">
          <p className="text-[11px] font-bold tracking-[0.3em] text-neutral-400">
            COIN DUEL <span className="text-neutral-600">#{duel.id}</span>
          </p>
          <DuelStatusPill status={duel.status} />
        </div>
        {poolA && poolB ? (
          <div className="mt-8">
            {/* Mobile: stacked with a horizontal VS divider. Desktop: side by side. */}
            <div className="flex flex-col items-stretch gap-3 sm:hidden">
              <HeroFighter pool={poolA} champion={aWon} dimmed={settled && !aWon} />
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-white/10" />
                <VsMedallion />
                <div className="h-px flex-1 bg-white/10" />
              </div>
              <HeroFighter pool={poolB} champion={bWon} dimmed={settled && !bWon} />
              {duel.status === 'active' && duel.expiresAt && (
                <p className="text-center text-[11px] font-bold tracking-wider text-neutral-400">
                  {formatCountdown(duel.expiresAt, Date.now())}
                </p>
              )}
            </div>
            <div className="hidden items-start justify-center gap-8 sm:flex">
              <HeroFighter pool={poolA} champion={aWon} dimmed={settled && !aWon} />
              <div className="flex flex-col items-center gap-2 pt-6">
                <VsMedallion size="lg" />
                {duel.status === 'active' && duel.expiresAt && (
                  <span className="text-[11px] font-bold tracking-wider text-neutral-400">
                    {formatCountdown(duel.expiresAt, Date.now())}
                  </span>
                )}
              </div>
              <HeroFighter pool={poolB} champion={bWon} dimmed={settled && !bWon} />
            </div>
          </div>
        ) : (
          <p className="mt-8 text-center text-sm text-neutral-500">
            Pool details are unavailable right now.
          </p>
        )}
        {settled && (
          <p className="mt-6 text-center text-sm leading-relaxed text-neutral-300">
            {(() => {
              const winnerSym = aWon ? poolA?.symbol : poolB?.symbol;
              return winnerSym
                ? `$${winnerSym} graduated first and takes the pot.`
                : 'The winner takes the pot.';
            })()}
          </p>
        )}
      </div>
    </section>
  );
}

function Race({ detail }: { detail: DuelDetail }) {
  const { duel, poolA, poolB } = detail;
  if (!poolA || !poolB) return null;
  const settled = duel.status === 'settled';
  const aWon = duel.winnerPool === duel.poolA;
  const bWon = duel.winnerPool === duel.poolB;
  return (
    <section aria-label="The race" className="rounded-3xl border border-white/10 bg-[#0d1110] px-6 py-6 sm:px-8">
      <p className="text-[11px] font-bold tracking-[0.25em] text-[#32f27b]">THE RACE</p>
      <div className="mt-5 space-y-6">
        <DuelRaceBar pool={poolA} accent={settled ? (aWon ? 'gold' : 'dim') : 'green'} />
        <DuelRaceBar pool={poolB} accent={settled ? (bWon ? 'gold' : 'dim') : 'green'} />
      </div>
      <p className="mt-4 text-xs leading-relaxed text-neutral-500">
        First coin to 100% graduates and wins the duel. Progress is read from pool state,
        the same figure the token page shows.
      </p>
    </section>
  );
}

function Terms({ detail }: { detail: DuelDetail }) {
  const { duel, terms } = detail;
  const now = Date.now();
  return (
    <section aria-label="Duel terms" className="rounded-3xl border border-white/10 bg-[#0d1110] px-6 py-6 sm:px-8">
      <p className="text-[11px] font-bold tracking-[0.25em] text-[#e8b64c]">THE TERMS</p>
      <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-neutral-200">
        <li className="flex gap-2.5">
          <span className="text-[#e8b64c]">◆</span>First coin to graduate wins. No judges, no votes.
        </li>
        <li className="flex gap-2.5">
          <span className="text-[#e8b64c]">◆</span>
          The winner takes the loser creator fees for {terms.forfeitDays} days after graduation.
        </li>
        <li className="flex gap-2.5">
          <span className="text-[#e8b64c]">◆</span>
          {terms.recipientProtection}.
        </li>
        <li className="flex gap-2.5">
          <span className="text-[#e8b64c]">◆</span>
          Buyback and bounty commitments made at launch are paid before any forfeit.
        </li>
        <li className="flex gap-2.5">
          <span className="text-[#e8b64c]">◆</span>
          {terms.drawRule}.
        </li>
      </ul>
      <div className="mt-5 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div className="rounded-xl bg-white/[0.03] px-3 py-2.5">
          <p className="font-bold tracking-wider text-neutral-500">CHALLENGED</p>
          <p className="mt-1 text-neutral-200">{formatDuelDate(duel.createdAt)}</p>
        </div>
        <div className="rounded-xl bg-white/[0.03] px-3 py-2.5">
          <p className="font-bold tracking-wider text-neutral-500">ACCEPTED</p>
          <p className="mt-1 text-neutral-200">{formatDuelDate(duel.activatedAt)}</p>
        </div>
        <div className="rounded-xl bg-white/[0.03] px-3 py-2.5">
          <p className="font-bold tracking-wider text-neutral-500">EXPIRES</p>
          <p className="mt-1 text-neutral-200">{formatDuelDate(duel.expiresAt)}</p>
        </div>
        <div className="rounded-xl bg-white/[0.03] px-3 py-2.5">
          <p className="font-bold tracking-wider text-neutral-500">CLOCK</p>
          <p className="mt-1 font-semibold text-neutral-200">
            {duel.status === 'settled' && duel.forfeitEndsAt
              ? formatForfeitCountdown(duel.forfeitEndsAt, now)
              : duel.status === 'active'
                ? formatCountdown(duel.expiresAt, now)
                : duelStatusWord(duel.status)}
          </p>
        </div>
      </div>
      <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs leading-relaxed text-neutral-400">
        {terms.honestNote}
      </p>
    </section>
  );
}

function duelStatusWord(status: DuelDetail['duel']['status']): string {
  switch (status) {
    case 'settled': return 'settled';
    case 'drawn': return 'declared a draw';
    case 'expired': return 'expired';
    case 'cancelled': return 'called off';
    default: return 'waiting';
  }
}

function Transparency({ detail }: { detail: DuelDetail }) {
  const { poolA, poolB } = detail;
  if (!poolA || !poolB) return null;
  const rows = [poolA, poolB];
  return (
    <section aria-label="Creator buys transparency" className="rounded-3xl border border-white/10 bg-[#0d1110] px-6 py-6 sm:px-8">
      <p className="text-[11px] font-bold tracking-[0.25em] text-neutral-400">CREATOR BUYS</p>
      <div className="mt-4 space-y-3">
        {rows.map((p) => (
          <div key={p.poolAddress} className="flex items-center justify-between gap-3">
            <span className="text-sm font-bold text-neutral-200">${p.symbol}</span>
            <span className="text-sm text-neutral-400">
              {p.creatorBuysShare == null ? (
                'unknown'
              ) : (
                <>
                  <span className="font-bold text-neutral-100">{p.creatorBuysShare.toFixed(1)}%</span>
                  {' '}of buys came from the creator wallet
                </>
              )}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-neutral-500">
        Sunlight, not rules. A creator can buy their own coin to graduate faster, and both
        sides know it. The cost is the trading fee on every buy.
      </p>
    </section>
  );
}

function Timeline({ detail }: { detail: DuelDetail }) {
  const { duel, poolA, poolB } = detail;
  const aSym = poolA ? `$${poolA.symbol}` : 'Coin A';
  const bSym = poolB ? `$${poolB.symbol}` : 'Coin B';
  const accepted = duel.activatedAt != null;
  const finished =
    duel.status === 'settled' || duel.status === 'expired' || duel.status === 'drawn';
  const endLabel =
    duel.status === 'settled'
      ? 'Duel settled'
      : duel.status === 'drawn'
        ? 'Draw declared'
        : duel.status === 'expired'
          ? 'Duel expired'
          : 'Duel called off';
  const endDetail =
    duel.status === 'settled'
      ? (() => {
          const winnerSym = duel.winnerPool === duel.poolA ? aSym : bSym;
          const at = duel.settledAt != null ? formatDuelDate(duel.settledAt) : null;
          return `${winnerSym} graduated first${at ? `, detected from pool state at ${at}` : ''}. The forfeit window is now open.`;
        })()
      : duel.status === 'drawn'
        ? 'Both coins graduated within a minute of each other. No fees moved.'
        : duel.status === 'expired'
          ? 'Neither coin graduated within 30 days. No fees moved.'
          : 'The challenge was withdrawn or declined. No fees moved.';
  return (
    <section aria-label="Duel timeline" className="rounded-3xl border border-white/10 bg-[#0d1110] px-6 py-6 sm:px-8">
      <p className="text-[11px] font-bold tracking-[0.25em] text-neutral-400">TIMELINE</p>
      <div className="mt-4">
        <DuelTimelineRow
          label="Challenge issued"
          detail={`${aSym} creator challenged ${bSym}. Nothing was locked yet.`}
          ts={duel.createdAt}
          done
        />
        <DuelTimelineRow
          label="Duel accepted"
          detail={
            accepted
              ? 'Both creators signed. Terms locked, the race went live.'
              : 'Waiting on the challenged creator. The race starts on accept.'
          }
          ts={duel.activatedAt}
          done={accepted}
          last={!finished && duel.status !== 'cancelled'}
        />
        {(finished || duel.status === 'cancelled') && (
          <DuelTimelineRow label={endLabel} detail={endDetail} ts={duel.settledAt} done last />
        )}
      </div>
    </section>
  );
}

function ForfeitLedger({ detail }: { detail: DuelDetail }) {
  const { duel, forfeitPayouts, forfeitTotals, poolA, poolB } = detail;
  const quote = useQuoteMeta(duel.loserPool);
  const quoteDecimals = quote.data?.quoteDecimals ?? 9;
  const quoteSymbol = quote.data?.quoteSymbol ?? 'SOL';
  const total =
    forfeitTotals.quoteRaw !== '0' || forfeitTotals.baseRaw !== '0'
      ? formatRawAmount(forfeitTotals.quoteRaw, quoteDecimals, quoteSymbol)
      : null;
  const winnerSym =
    duel.winnerPool === duel.poolA ? poolA?.symbol : poolB?.symbol;
  return (
    <section aria-label="Forfeit ledger" className="rounded-3xl border border-[#e8b64c]/25 bg-[#e8b64c]/[0.03] px-6 py-6 sm:px-8">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-bold tracking-[0.25em] text-[#e8b64c]">FORFEIT LEDGER</p>
        {total && <p className="text-sm font-bold text-[#e8b64c]">{total} so far</p>}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-neutral-300">
        {total
          ? `${total} redirected to ${winnerSym ? `$${winnerSym}` : 'the winner'} so far.`
          : 'No forfeit payouts yet. They land when the loser claims.'}
      </p>
      {forfeitPayouts.length > 0 && (
        <ul className="mt-4 space-y-2">
          {forfeitPayouts.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.03] px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-neutral-100">
                  {formatRawAmount(p.quoteAmountRaw, quoteDecimals, quoteSymbol)}
                </p>
                <p className="mt-0.5 text-[11px] text-neutral-500">
                  {formatDuelDate(p.paidAt)} · to {shortWallet(p.winnerWallet)}
                </p>
              </div>
              <a
                href={solscanTx(p.txSignature)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 shrink-0 items-center rounded-xl border border-white/15 px-4 text-xs font-bold text-neutral-300 transition hover:border-white/30"
              >
                View tx
              </a>
            </li>
          ))}
        </ul>
      )}
      {duel.forfeitEndsAt && (
        <p className="mt-4 text-xs text-neutral-500">
          Forfeit window {formatForfeitCountdown(duel.forfeitEndsAt, Date.now())}.
        </p>
      )}
    </section>
  );
}

function ShareDuel({ detail }: { detail: DuelDetail }) {
  const { duel, poolA, poolB } = detail;
  const [copied, setCopied] = useState(false);
  if (!poolA || !poolB) return null;
  const text = `$${poolA.symbol} vs $${poolB.symbol} on @Curvpad. First to graduate takes the loser creator fees.`;
  const url = typeof window !== 'undefined' ? window.location.href : '';
  const intent = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  return (
    <section aria-label="Share this duel" className="flex flex-col items-center gap-3 py-2 text-center">
      <p className="text-sm text-neutral-400">Pick a side. Tell the timeline.</p>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <a
          href={intent}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-12 items-center justify-center rounded-2xl bg-[#32f27b] px-8 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f]"
        >
          Share this duel
        </a>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(`${text} ${url}`).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
          className="inline-flex h-12 items-center justify-center rounded-2xl border border-white/15 px-8 text-sm font-bold text-neutral-200 transition hover:border-white/30"
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="max-w-md text-xs leading-relaxed text-neutral-600">{text}</p>
    </section>
  );
}

export default function DuelPage() {
  const router = useRouter();
  const rawId = router.query.id;
  const id = typeof rawId === 'string' ? Number(rawId) : null;
  const detail = useDuelDetail(id);
  const d = detail.data;

  return (
    <Page>
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <Link
          href="/duels"
          className="mb-6 inline-flex h-11 items-center rounded-xl border border-white/10 px-4 text-sm font-bold text-neutral-400 transition hover:border-white/25 hover:text-neutral-100"
        >
          ← All duels
        </Link>

        {detail.isLoading ? (
          <div className="space-y-4">
            <div className="h-72 animate-pulse rounded-3xl bg-white/[0.04]" />
            <div className="h-40 animate-pulse rounded-3xl bg-white/[0.04]" />
          </div>
        ) : detail.isError || !d ? (
          <div className="rounded-3xl border border-white/10 bg-[#0d1110] px-8 py-16 text-center">
            <p className="text-lg font-bold text-neutral-100">Duel not found</p>
            <p className="mt-2 text-sm text-neutral-400">
              This duel does not exist or is no longer available.
            </p>
            <Link
              href="/duels"
              className="mt-6 inline-flex h-12 items-center rounded-2xl bg-[#32f27b] px-8 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f]"
            >
              Browse duels
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <Hero detail={d} />
            {d.duel.status === 'challenged' && (
              <div className="rounded-3xl border border-white/10 bg-[#0d1110] px-6 py-6 sm:px-8">
                <DuelActionButtons duel={d.duel} />
              </div>
            )}
            {(d.duel.status === 'active' || d.duel.status === 'settled') && <Race detail={d} />}
            {d.duel.status === 'challenged' && d.poolA && d.poolB && (
              <section aria-label="The race" className="rounded-3xl border border-white/10 bg-[#0d1110] px-6 py-6 sm:px-8">
                <p className="text-[11px] font-bold tracking-[0.25em] text-[#32f27b]">THE RACE</p>
                <p className="mt-3 text-sm leading-relaxed text-neutral-400">
                  The race goes live when the challenged creator accepts. Until then, nothing
                  is locked and no fees can move.
                </p>
                <div className="mt-5 space-y-6 opacity-60">
                  <DuelRaceBar pool={d.poolA} />
                  <DuelRaceBar pool={d.poolB} />
                </div>
              </section>
            )}
            <Terms detail={d} />
            <Transparency detail={d} />
            <Timeline detail={d} />
            {d.duel.status === 'settled' && <ForfeitLedger detail={d} />}
            <ShareDuel detail={d} />
          </div>
        )}
      </div>
    </Page>
  );
}
