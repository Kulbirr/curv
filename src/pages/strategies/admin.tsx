import { useCallback, useEffect, useState } from 'react';
import Page from '@/components/ui/Page/Page';
import { cn } from '@/lib/utils';
import { STRATEGIES_ADMIN_HEADER } from '@/lib/strategies';

/**
 * Strategies pipeline admin. Operator only: every request carries the
 * admin secret from session storage in the x-strategies-admin header,
 * and the API fails closed when STRATEGIES_ADMIN_SECRET is not set.
 *
 * Flow: submit a candidate -> evaluate (deterministic gates, then the
 * Hermes judge) -> publish approved candidates as live signals.
 * Rejected candidates stay visible here as the audit trail and are
 * never shown to subscribers.
 */

const SECRET_KEY = 'strategies-admin-secret';

interface GateResultView {
  name: string;
  status: 'pass' | 'fail' | 'abstain';
  reason: string;
}

interface JudgeCheckView {
  name: string;
  pass: boolean;
  note: string;
}

interface CandidateView {
  id: string;
  baseMint: string;
  baseSymbol: string;
  quoteMint: string;
  quoteSymbol: string;
  entryLow: number;
  entryHigh: number;
  stopPrice: number;
  targets: number[];
  sizeText: string | null;
  thesis: string;
  submittedBy: string;
  noKnownUnlock: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'published';
  ruleResults: GateResultView[] | null;
  aiVerdict: 'approved' | 'rejected' | null;
  aiReasons: string[] | null;
  aiChecks: JudgeCheckView[] | null;
  decidedAt: number | null;
  createdAt: number;
}

interface UniverseView {
  baseMint: string;
  symbol: string;
  coingeckoId: string;
  tier: 'core' | 'satellite';
  active: boolean;
  createdAt: number;
}

function useAdminSecret() {
  const [secret, setSecret] = useState('');
  useEffect(() => {
    setSecret(sessionStorage.getItem(SECRET_KEY) ?? '');
  }, []);
  const save = useCallback((v: string) => {
    setSecret(v);
    if (v) sessionStorage.setItem(SECRET_KEY, v);
    else sessionStorage.removeItem(SECRET_KEY);
  }, []);
  return { secret, save };
}

function useAdminApi(secret: string) {
  return useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(path, {
        ...init,
        headers: { ...(init?.headers ?? {}), [STRATEGIES_ADMIN_HEADER]: secret },
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      return json as Record<string, unknown>;
    },
    [secret],
  );
}

const inputCls =
  'h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-[#32f27b]/50';
const labelCls = 'mb-1.5 block text-xs font-semibold text-neutral-400';

function GateBadge({ status }: { status: GateResultView['status'] }) {
  return (
    <span
      className={cn(
        'rounded-md px-2 py-0.5 text-[11px] font-bold',
        status === 'pass' && 'bg-[#32f27b]/12 text-[#32f27b]',
        status === 'fail' && 'bg-[#fa6d74]/12 text-[#fa6d74]',
        status === 'abstain' && 'bg-amber-400/12 text-amber-300',
      )}
    >
      {status}
    </span>
  );
}

function StatusPill({ status }: { status: CandidateView['status'] }) {
  return (
    <span
      className={cn(
        'rounded-full px-3 py-1 text-[11px] font-bold',
        status === 'approved' && 'bg-[#32f27b]/12 text-[#32f27b]',
        status === 'rejected' && 'bg-[#fa6d74]/12 text-[#fa6d74]',
        status === 'published' && 'bg-sky-400/12 text-sky-300',
        status === 'pending' && 'bg-white/8 text-neutral-300',
      )}
    >
      {status}
    </span>
  );
}

export default function StrategiesAdmin() {
  const { secret, save } = useAdminSecret();
  const api = useAdminApi(secret);
  const [universe, setUniverse] = useState<UniverseView[]>([]);
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [filter, setFilter] = useState<'all' | CandidateView['status']>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [form, setForm] = useState({
    baseMint: '',
    entryLow: '',
    entryHigh: '',
    stopPrice: '',
    targets: '',
    sizeText: '',
    thesis: '',
    submittedBy: 'operator',
    noKnownUnlock: false,
  });
  const [overrideReason, setOverrideReason] = useState('');

  const load = useCallback(async () => {
    if (!secret) return;
    setError(null);
    try {
      const [u, c] = await Promise.all([
        api('/api/strategies/universe'),
        api(`/api/strategies/candidates${filter === 'all' ? '' : `?status=${filter}`}`),
      ]);
      setUniverse((u.universe ?? []) as UniverseView[]);
      setCandidates((c.candidates ?? []) as CandidateView[]);
      setForm((f) => ({
        ...f,
        baseMint: f.baseMint || ((u.universe ?? []) as UniverseView[])[0]?.baseMint || '',
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load admin data');
    }
  }, [api, secret, filter]);

  useEffect(() => {
    load();
  }, [load]);

  const submitCandidate = useCallback(async () => {
    setBusy('submit');
    setError(null);
    try {
      const coin = universe.find((u) => u.baseMint === form.baseMint);
      const targets = form.targets
        .split(',')
        .map((t) => Number(t.trim()))
        .filter((t) => Number.isFinite(t) && t > 0);
      await api('/api/strategies/candidates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseMint: form.baseMint,
          baseSymbol: coin?.symbol ?? 'UNKNOWN',
          entryLow: Number(form.entryLow),
          entryHigh: Number(form.entryHigh),
          stopPrice: Number(form.stopPrice),
          targets,
          sizeText: form.sizeText.trim() || null,
          thesis: form.thesis.trim(),
          submittedBy: form.submittedBy.trim(),
          noKnownUnlock: form.noKnownUnlock,
        }),
      });
      setForm((f) => ({ ...f, entryLow: '', entryHigh: '', stopPrice: '', targets: '', thesis: '' }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Submit failed');
    } finally {
      setBusy(null);
    }
  }, [api, form, universe, load]);

  const evaluate = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      try {
        await api(`/api/strategies/candidates/${id}/evaluate`, { method: 'POST' });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Evaluation failed');
      } finally {
        setBusy(null);
      }
    },
    [api, load],
  );

  const publish = useCallback(
    async (id: string, override: boolean) => {
      setBusy(id);
      setError(null);
      try {
        await api(`/api/strategies/candidates/${id}/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(override ? { overrideReason: overrideReason.trim() } : {}),
        });
        setOverrideReason('');
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Publish failed');
      } finally {
        setBusy(null);
      }
    },
    [api, load, overrideReason],
  );

  const toggleUniverse = useCallback(
    async (baseMint: string, active: boolean) => {
      setError(null);
      try {
        await api('/api/strategies/universe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'toggle', baseMint, active }),
        });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Universe update failed');
      }
    },
    [api, load],
  );

  return (
    <Page>
      <div className="mx-auto w-full max-w-4xl">
        <p className="text-[11px] font-bold tracking-[0.2em] text-[#32f27b]">STRATEGIES ADMIN</p>
        <h1 className="mt-2 text-3xl font-bold text-neutral-50">Signal pipeline</h1>
        <p className="mt-2 max-w-xl text-sm text-neutral-400">
          Submit candidates, run the gates and the AI judge, publish the winners. Rejections stay
          here as the record and never reach subscribers.
        </p>

        <div className="mt-6 rounded-3xl border border-white/10 bg-[#0e1112] p-6">
          <label className={labelCls} htmlFor="admin-secret">
            Admin secret
          </label>
          <input
            id="admin-secret"
            type="password"
            value={secret}
            onChange={(e) => save(e.target.value)}
            placeholder="STRATEGIES_ADMIN_SECRET"
            className={inputCls}
            autoComplete="off"
          />
          <p className="mt-2 text-xs text-neutral-500">
            Kept only in this tab session. The API rejects everything without it.
          </p>
        </div>

        {error && (
          <div className="mt-4 rounded-2xl border border-[#fa6d74]/30 bg-[#fa6d74]/10 px-4 py-3">
            <p className="text-sm font-semibold text-[#fa6d74]">{error}</p>
          </div>
        )}

        {secret && (
          <>
            <section className="mt-8">
              <h2 className="text-lg font-bold text-neutral-50">Universe</h2>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {universe.map((u) => (
                  <div
                    key={u.baseMint}
                    className="flex items-center justify-between rounded-2xl border border-white/10 bg-[#0e1112] px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-bold text-neutral-100">{u.symbol}</p>
                      <p className="text-xs text-neutral-500">{u.tier}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleUniverse(u.baseMint, !u.active)}
                      className={cn(
                        'rounded-full px-3 py-1 text-[11px] font-bold',
                        u.active ? 'bg-[#32f27b]/12 text-[#32f27b]' : 'bg-white/8 text-neutral-400',
                      )}
                    >
                      {u.active ? 'active' : 'off'}
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="mt-8 rounded-3xl border border-white/10 bg-[#0e1112] p-6 md:p-8">
              <h2 className="text-lg font-bold text-neutral-50">New candidate</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Coin</label>
                  <select
                    value={form.baseMint}
                    onChange={(e) => setForm({ ...form, baseMint: e.target.value })}
                    className={inputCls}
                  >
                    {universe
                      .filter((u) => u.active)
                      .map((u) => (
                        <option key={u.baseMint} value={u.baseMint}>
                          {u.symbol} ({u.tier})
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Suggested size (optional)</label>
                  <input
                    value={form.sizeText}
                    onChange={(e) => setForm({ ...form, sizeText: e.target.value })}
                    placeholder="e.g. 2 percent of book"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Entry low</label>
                  <input
                    value={form.entryLow}
                    onChange={(e) => setForm({ ...form, entryLow: e.target.value })}
                    placeholder="0.00"
                    inputMode="decimal"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Entry high</label>
                  <input
                    value={form.entryHigh}
                    onChange={(e) => setForm({ ...form, entryHigh: e.target.value })}
                    placeholder="0.00"
                    inputMode="decimal"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Stop</label>
                  <input
                    value={form.stopPrice}
                    onChange={(e) => setForm({ ...form, stopPrice: e.target.value })}
                    placeholder="0.00"
                    inputMode="decimal"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Targets (comma separated)</label>
                  <input
                    value={form.targets}
                    onChange={(e) => setForm({ ...form, targets: e.target.value })}
                    placeholder="0.00, 0.00"
                    inputMode="decimal"
                    className={inputCls}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelCls}>Thesis</label>
                  <textarea
                    value={form.thesis}
                    onChange={(e) => setForm({ ...form, thesis: e.target.value })}
                    placeholder="Why this trade, what is the catalyst, what invalidates it"
                    rows={3}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-[#32f27b]/50"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-neutral-300 sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={form.noKnownUnlock}
                    onChange={(e) => setForm({ ...form, noKnownUnlock: e.target.checked })}
                    className="h-4 w-4 accent-[#32f27b]"
                  />
                  No large unlock known within the next 30 days
                </label>
              </div>
              <button
                type="button"
                onClick={submitCandidate}
                disabled={busy === 'submit' || !form.baseMint}
                className="mt-6 inline-flex h-11 items-center rounded-full bg-[#32f27b] px-7 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60"
              >
                {busy === 'submit' ? 'Submitting…' : 'Submit candidate'}
              </button>
            </section>

            <section className="mt-8">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-neutral-50">Candidates</h2>
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as typeof filter)}
                  className="h-9 rounded-xl border border-white/10 bg-white/5 px-3 text-xs text-neutral-200 outline-none"
                >
                  {['all', 'pending', 'approved', 'rejected', 'published'].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-3 space-y-3">
                {candidates.map((c) => (
                  <article
                    key={c.id}
                    className="rounded-3xl border border-white/10 bg-[#0e1112] p-5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-base font-bold text-neutral-50">
                          {c.baseSymbol}
                          <span className="font-medium text-neutral-500">/{c.quoteSymbol}</span>
                        </p>
                        <p className="mt-0.5 text-xs text-neutral-500">
                          Zone {c.entryLow} to {c.entryHigh} · stop {c.stopPrice} · targets{' '}
                          {c.targets.join(', ')}
                        </p>
                      </div>
                      <StatusPill status={c.status} />
                    </div>
                    <p className="mt-3 text-sm text-neutral-400">{c.thesis}</p>

                    {c.ruleResults && c.ruleResults.length > 0 && (
                      <div className="mt-4 space-y-1.5">
                        {c.ruleResults.map((g, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs">
                            <GateBadge status={g.status} />
                            <span className="text-neutral-400">
                              <span className="font-semibold text-neutral-300">{g.name}:</span>{' '}
                              {g.reason}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {c.aiVerdict && (
                      <div
                        className={cn(
                          'mt-4 rounded-2xl border px-4 py-3',
                          c.aiVerdict === 'approved'
                            ? 'border-[#32f27b]/30 bg-[#32f27b]/8'
                            : 'border-[#fa6d74]/30 bg-[#fa6d74]/8',
                        )}
                      >
                        <p
                          className={cn(
                            'text-sm font-bold',
                            c.aiVerdict === 'approved' ? 'text-[#32f27b]' : 'text-[#fa6d74]',
                          )}
                        >
                          {c.aiVerdict === 'approved' ? 'Approved by AI' : 'Rejected by AI'}
                        </p>
                        {c.aiReasons && (
                          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-neutral-300">
                            {c.aiReasons.map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {c.status === 'pending' && (
                        <button
                          type="button"
                          onClick={() => evaluate(c.id)}
                          disabled={busy === c.id}
                          className="inline-flex h-9 items-center rounded-full bg-white/10 px-4 text-xs font-bold text-neutral-100 transition hover:bg-white/15 disabled:opacity-60"
                        >
                          {busy === c.id ? 'Evaluating…' : 'Evaluate'}
                        </button>
                      )}
                      {c.status === 'approved' && (
                        <button
                          type="button"
                          onClick={() => publish(c.id, false)}
                          disabled={busy === c.id}
                          className="inline-flex h-9 items-center rounded-full bg-[#32f27b] px-4 text-xs font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60"
                        >
                          {busy === c.id ? 'Publishing…' : 'Publish signal'}
                        </button>
                      )}
                      {(c.status === 'pending' || c.status === 'rejected') && (
                        <div className="flex w-full items-center gap-2">
                          <input
                            value={overrideReason}
                            onChange={(e) => setOverrideReason(e.target.value)}
                            placeholder="Override reason (publishes without the AI badge)"
                            className="h-9 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 text-xs text-neutral-100 placeholder:text-neutral-600 outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => publish(c.id, true)}
                            disabled={busy === c.id || !overrideReason.trim()}
                            className="inline-flex h-9 shrink-0 items-center rounded-full border border-white/15 px-4 text-xs font-bold text-neutral-200 transition hover:border-white/30 disabled:opacity-60"
                          >
                            Override publish
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                ))}
                {candidates.length === 0 && (
                  <p className="rounded-2xl border border-white/5 bg-[#0e1112] p-6 text-center text-sm text-neutral-500">
                    No candidates{filter === 'all' ? ' yet' : ` with status ${filter}`}.
                  </p>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </Page>
  );
}
