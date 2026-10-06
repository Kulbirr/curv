import Link from 'next/link';
import Page from '@/components/ui/Page/Page';
import {
  formatCountdown,
  groupDuels,
  shortWallet,
  useDuelDetail,
  useDuelList,
  type Duel,
} from '@/components/Duel/duel';
import {
  DuelCoinAvatar,
  DuelRaceBar,
  DuelStatusPill,
  VsMedallion,
} from '@/components/Duel/DuelBits';

function LineupCard({ duel }: { duel: Duel }) {
  const detail = useDuelDetail(duel.id);
  const d = detail.data;
  const live = duel.status === 'active';
  return (
    <Link
      href={`/duels/${duel.id}`}
      className="group block rounded-3xl border border-white/10 bg-[#0d1110] px-5 py-5 transition hover:border-white/25 hover:bg-[#101412]"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-bold tracking-[0.25em] text-neutral-500">
          COIN DUEL <span className="text-neutral-600">#{duel.id}</span>
        </p>
        <DuelStatusPill status={duel.status} />
      </div>
      {detail.isLoading ? (
        <div className="mt-4 h-24 animate-pulse rounded-2xl bg-white/[0.04]" />
      ) : !d || !d.poolA || !d.poolB ? (
        <p className="mt-4 text-sm text-neutral-500">
          {shortWallet(duel.poolA)} vs {shortWallet(duel.poolB)}
        </p>
      ) : (
        <div className="mt-4">
          <div className="flex items-center gap-3">
            <DuelCoinAvatar imageUrl={d.poolA.imageUrl} symbol={d.poolA.symbol} size={44} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-neutral-100">${d.poolA.symbol}</p>
            </div>
            <VsMedallion size="sm" />
            <div className="min-w-0 flex-1 text-right">
              <p className="truncate text-sm font-bold text-neutral-100">${d.poolB.symbol}</p>
            </div>
            <DuelCoinAvatar imageUrl={d.poolB.imageUrl} symbol={d.poolB.symbol} size={44} />
          </div>
          {(live || duel.status === 'settled') && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <DuelRaceBar
                pool={d.poolA}
                compact
                accent={duel.status === 'settled' ? (duel.winnerPool === d.poolA.poolAddress ? 'gold' : 'dim') : 'green'}
              />
              <DuelRaceBar
                pool={d.poolB}
                compact
                accent={duel.status === 'settled' ? (duel.winnerPool === d.poolB.poolAddress ? 'gold' : 'dim') : 'green'}
              />
            </div>
          )}
          {duel.status === 'challenged' && (
            <p className="mt-3 text-xs text-neutral-400">
              ${d.poolA.symbol} challenged ${d.poolB.symbol}. Waiting on the accept.
            </p>
          )}
          {duel.status === 'drawn' && (
            <p className="mt-3 text-xs text-neutral-400">
              Both coins crossed together. No fees moved.
            </p>
          )}
          {duel.status === 'expired' && (
            <p className="mt-3 text-xs text-neutral-400">
              Neither coin graduated in time. No fees moved.
            </p>
          )}
        </div>
      )}
      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-500">
          {live && duel.expiresAt ? formatCountdown(duel.expiresAt, Date.now()) : ''}
        </span>
        <span className="text-xs font-bold text-[#32f27b] transition group-hover:translate-x-0.5">
          View duel →
        </span>
      </div>
    </Link>
  );
}

function Section({ title, duels }: { title: string; duels: Duel[] }) {
  if (duels.length === 0) return null;
  return (
    <section aria-label={title} className="mt-10">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-[11px] font-bold tracking-[0.25em] text-neutral-400">{title}</h2>
        <span className="h-px flex-1 bg-white/10" />
        <span className="text-[11px] font-bold text-neutral-600">{duels.length}</span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {duels.map((d) => (
          <LineupCard key={d.id} duel={d} />
        ))}
      </div>
    </section>
  );
}

export default function DuelsIndexPage() {
  const list = useDuelList(50);
  const duels = list.data?.duels ?? [];
  const { active, challenged, settled, rest } = groupDuels(duels);

  return (
    <Page>
      <div className="mx-auto w-full max-w-5xl px-4 py-10">
        <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#0b0e0c] px-6 py-10 text-center sm:px-10">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse 70% 60% at 50% 0%, #e8b64c14, transparent 70%)',
            }}
          />
          <div className="relative">
            <div className="flex justify-center">
              <VsMedallion size="lg" />
            </div>
            <h1 className="mt-5 text-3xl font-black tracking-tight text-neutral-50 sm:text-4xl">
              Coin Duels
            </h1>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-neutral-400 sm:text-base">
              Two coins launch head to head. First one to graduate takes the loser creator
              fees. Winner takes all.
            </p>
          </div>
        </div>

        {list.isLoading ? (
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-48 animate-pulse rounded-3xl bg-white/[0.04]" />
            ))}
          </div>
        ) : list.isError ? (
          <p className="mt-10 text-center text-sm text-neutral-500">
            Could not load duels right now. Try again in a moment.
          </p>
        ) : duels.length === 0 ? (
          <div className="mt-10 rounded-3xl border border-white/10 bg-[#0d1110] px-8 py-14 text-center">
            <p className="text-lg font-bold text-neutral-100">No duels yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-neutral-400">
              Nobody has thrown the first gauntlet. Open any coin page and challenge it to
              start the first fight night.
            </p>
          </div>
        ) : (
          <>
            <Section title="LIVE NOW" duels={active} />
            <Section title="AWAITING ACCEPT" duels={challenged} />
            <Section title="SETTLED" duels={settled} />
            <Section title="FINISHED" duels={rest} />
          </>
        )}
      </div>
    </Page>
  );
}
