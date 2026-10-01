// Realistic read-mix load harness (no deps).
// Mix per worker: 60% GET /api/pools?limit=50, 20% GET /api/pools/[addr]/state,
// 15% GET /api/pools/[addr]/history, 5% GET /api/health.
// Also supports a list-heavy mode via MIX=list (95% /api/pools?limit=50, 5% health).
// Run: node scripts/loadtest-mix.cjs [baseUrl] [mode] [concurrency...]
//   e.g. node scripts/loadtest-mix.cjs http://localhost:3100 mix 10 25 50 100
const BASE = process.argv[2] || 'http://localhost:3100';
const MODE = process.argv[3] === 'list' ? 'list' : 'mix';
const CONCURRENCIES = process.argv.slice(4).map(Number).filter(Boolean).length
  ? process.argv.slice(4).map(Number).filter(Boolean)
  : [10, 25, 50, 100];
const DURATION_MS = 20_000;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

let addrs = [];
async function bootstrap() {
  const res = await fetch(BASE + '/api/pools?limit=50');
  const body = await res.json();
  addrs = (body.pools || []).map((p) => p.poolAddress).filter(Boolean);
  if (!addrs.length) throw new Error('no pool addresses from /api/pools?limit=50');
  console.log(`bootstrapped ${addrs.length} pool addresses`);
}

function pickPath(i) {
  const r = Math.random() * 100;
  const a = addrs[i % addrs.length];
  if (MODE === 'list') {
    return r < 95 ? '/api/pools?limit=50' : '/api/health';
  }
  if (r < 60) return '/api/pools?limit=50';
  if (r < 80) return `/api/pools/${a}/state`;
  if (r < 95) return `/api/pools/${a}/history`;
  return '/api/health';
}

async function hammer(concurrency) {
  const lat = { list: [], state: [], history: [], health: [] };
  let ok = 0, errors = 0;
  const stopAt = Date.now() + DURATION_MS;
  let idx = 0;
  async function worker() {
    while (Date.now() < stopAt) {
      const path = pickPath(idx++);
      const t0 = Date.now();
      try {
        const res = await fetch(BASE + path);
        await res.arrayBuffer();
        if (res.ok) ok++; else errors++;
      } catch { errors++; }
      const ms = Date.now() - t0;
      if (path.startsWith('/api/pools?')) lat.list.push(ms);
      else if (path.endsWith('/state')) lat.state.push(ms);
      else if (path.endsWith('/history')) lat.history.push(ms);
      else lat.health.push(ms);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const all = [...lat.list, ...lat.state, ...lat.history, ...lat.health].sort((a, b) => a - b);
  const secs = DURATION_MS / 1000;
  const p = (arr, q) => percentile([...arr].sort((a, b) => a - b), q);
  return {
    concurrency,
    rps: (ok / secs).toFixed(1),
    p50: p(all, 50), p95: p(all, 95), p99: p(all, 99),
    listP50: p(lat.list, 50), stateP50: p(lat.state, 50), histP50: p(lat.history, 50),
    errors,
  };
}

(async () => {
  await bootstrap();
  console.log(`mode=${MODE} target=${BASE} duration=${DURATION_MS / 1000}s`);
  console.log('conc | req/s | p50 | p95 | p99 | list50 | state50 | hist50 | errors');
  for (const c of CONCURRENCIES) {
    const r = await hammer(c);
    console.log(
      `${String(r.concurrency).padStart(4)} | ${String(r.rps).padStart(5)} | ${String(r.p50).padStart(4)} | ${String(r.p95).padStart(4)} | ${String(r.p99).padStart(4)} | ${String(r.listP50).padStart(6)} | ${String(r.stateP50).padStart(7)} | ${String(r.histP50).padStart(6)} | ${r.errors}`,
    );
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
