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
  const [authorized, setAuthorized] = useState(false);

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
  const [genCount, setGenCount] = useState(2);
  const [genNote, setGenNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!secret) {
      setAuthorized(false);
      return;
    }
    setError(null);
    try {
      const [u, c] = await Promise.all([
        api('/api/strategies/universe'),
        api(`/api/strategies/candidates${filter === 'all' ? '' : `?status=${filter}`}`),
      ]);
      setAuthorized(true);
      setUniverse((u.universe ?? []) as UniverseView[]);
      setCandidates((c.candidates ?? []) as CandidateView[]);
      setForm((f) => ({
        ...f,
        baseMint: f.baseMint || ((u.universe ?? []) as UniverseView[])[0]?.baseMint || '',
      }));
    } catch (e) {
      setAuthorized(false);
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

  // The idea engine: scan the universe for momentum, build the ideas,
  // run them through the gates and the judge, publish the approved ones.
  const generateIdeas = useCallback(async () => {
    setBusy('generate');
    setError(null);
    setGenNote(null);
    try {
      const res = (await api('/api/strategies/candidates/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count: genCount, autoPublish: true }),
      })) as {
        ideas?: Array<{
          id: string;
          baseSymbol: string;
          status: string;
          publishedSignalId: string | null;
          note: string | null;
        }>;
        note?: string;
      };
      const ideas = res.ideas ?? [];
      if (ideas.length === 0) {
        setGenNote(res.note ?? 'No eligible momentum setups right now');
      } else {
        setGenNote(
          ideas
            .map((i) => {
              const outcome =
                i.status === 'published'
                  ? 'published to the feed'
                  : i.status === 'approved'
                    ? 'approved, awaiting your publish'
                    : i.status === 'rejected'
                      ? 'rejected by the checks'
                      : 'pending your decision';
              return `${i.baseSymbol}: ${outcome}${i.note ? ` (${i.note})` : ''}`;
            })
            .join(' · '),
        );
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Idea generation failed');
    } finally {
      setBusy(null);
    }
  }, [api, genCount, load]);
  const submitAndAutoPublish = useCallback(async () => {
    setBusy('auto');
    setError(null);
    try {
      const coin = universe.find((u) => u.baseMint === form.baseMint);
      const targets = form.targets
        .split(',')
        .map((t) => Number(t.trim()))
        .filter((t) => Number.isFinite(t) && t > 0);
      const created = (await api('/api/strategies/candidates', {
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
      })) as { candidate?: { id?: string } };
      const id = created.candidate?.id;
      if (!id) throw new Error('Submit did not return a candidate');
      const evaluated = (await api(`/api/strategies/candidates/${id}/evaluate`, {
        method: 'POST',
      })) as { candidate?: CandidateView; judgeUnavailable?: boolean };
      const status = evaluated.candidate?.status;
      if (status === 'approved') {
        await api(`/api/strategies/candidates/${id}/publish`, { method: 'POST' });
      } else if (status === 'pending' || evaluated.judgeUnavailable) {
        setError('Judge unavailable, the idea is pending your decision below');
      }
      setForm((f) => ({ ...f, entryLow: '', entryHigh: '', stopPrice: '', targets: '', thesis: '' }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Auto publish failed');
    } finally {
      setBusy(null);
    }
  }, [api, form, universe, load]);
  const evaluate = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      setNotice(null);
      try {
        const res = (await api(`/api/strategies/candidates/${id}/evaluate`, {
          method: 'POST',
        })) as {
          candidate?: { status?: string; baseSymbol?: string };
          judgeSkipped?: boolean;
          judgeUnavailable?: boolean;
          judgeError?: string;
          note?: string;
        };
        const status = res.candidate?.status ?? 'pending';
        const symbol = res.candidate?.baseSymbol ?? 'idea';
        if (res.note || res.judgeError) {
          setNotice(`${symbol}: ${res.note ?? res.judgeError}`);
        } else if (status === 'approved') {
          setNotice(`${symbol} approved by the judge, ready to publish`);
        } else if (status === 'rejected') {
          setNotice(`${symbol} rejected, see the reasons below`);
        }
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

        {notice && (
          <div className="mt-4 rounded-2xl border border-[#32f27b]/30 bg-[#32f27b]/10 px-4 py-3">
            <p className="text-sm font-semibold text-neutral-100">{notice}</p>
          </div>
        )}

        {authorized && (
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

            <section className="mt-8 rounded-3xl border border-[#32f27b]/20 bg-[#0c1410] p-6 md:p-8">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-neutral-50">Idea engine</h2>
                  <p className="mt-1 max-w-xl text-sm text-neutral-400">
                    Scans the universe for the strongest 1 to 4 week momentum, builds the ideas,
                    runs the rule checks and the AI judge, and publishes the approved ones.
                    Rejected ideas stay in the log.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <label className="text-xs text-neutral-400">
                    Ideas
                    <select
                      value={genCount}
                      onChange={(e) => setGenCount(Number(e.target.value))}
                      className="ml-2 rounded-xl border border-white/10 bg-[#0e1112] px-3 py-2 text-sm text-neutral-100"
                    >
                      {[1, 2, 3].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={generateIdeas}
                    disabled={busy === 'generate'}
                    className="inline-flex h-11 items-center rounded-full bg-[#32f27b] px-7 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60"
                  >
                    {busy === 'generate' ? 'Scanning the market…' : 'Generate ideas'}
                  </button>
                </div>
              </div>
              {genNote && <p className="mt-4 text-sm text-neutral-300">{genNote}</p>}
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
                  <label className={labelCls}>Entry low (in USDC)</label>
                  <input
                    value={form.entryLow}
                    onChange={(e) => setForm({ ...form, entryLow: e.target.value })}
                    placeholder="0.00"
                    inputMode="decimal"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Entry high (in USDC)</label>
                  <input
                    value={form.entryHigh}
                    onChange={(e) => setForm({ ...form, entryHigh: e.target.value })}
                    placeholder="0.00"
                    inputMode="decimal"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Stop (in USDC)</label>
                  <input
                    value={form.stopPrice}
                    onChange={(e) => setForm({ ...form, stopPrice: e.target.value })}
                    placeholder="0.00"
                    inputMode="decimal"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Targets in SOL (comma separated)</label>
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
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={submitCandidate}
                  disabled={busy === 'submit' || busy === 'auto' || !form.baseMint}
                  className="inline-flex h-11 items-center rounded-full bg-[#32f27b] px-7 text-sm font-bold text-[#04120a] transition hover:bg-[#4bf78f] disabled:opacity-60"
                >
                  {busy === 'submit' ? 'Submitting…' : 'Submit candidate'}
                </button>
                <button
                  type="button"
                  onClick={submitAndAutoPublish}
                  disabled={busy === 'submit' || busy === 'auto' || !form.baseMint}
                  className="inline-flex h-11 items-center rounded-full border border-[#32f27b]/40 px-7 text-sm font-bold text-[#32f27b] transition hover:bg-[#32f27b]/10 disabled:opacity-60"
                >
                  {busy === 'auto' ? 'Checking and publishing…' : 'Submit and auto publish'}
                </button>
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                Auto publish runs the rule checks and the AI judge, then publishes at once when
                approved. Rejected ideas go to the rejected log.
              </p>
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
                        {Array.isArray(c.aiReasons) && c.aiReasons.length > 0 && (
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
