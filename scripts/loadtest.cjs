// Minimal HTTP load harness (no deps). Hits the app's read paths with N
// concurrent clients and reports throughput + latency percentiles.
// Run: node scripts/loadtest.cjs [baseUrl] [concurrency...]
//   e.g. node scripts/loadtest.cjs http://localhost:3000 10 50 100 200
const BASE = process.argv[2] || 'http://localhost:3000';
const CONCURRENCIES = (process.argv.slice(3).map(Number).filter(Boolean).length
  ? process.argv.slice(3).map(Number).filter(Boolean)
  : [10, 50, 100, 200]
);
const DURATION_MS = 15_000;
const PATHS = ['/api/pools'];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function hammer(concurrency) {
  const latencies = [];
  let ok = 0;
  let errors = 0;
  const stopAt = Date.now() + DURATION_MS;
  let pathIdx = 0;

  async function worker() {
    while (Date.now() < stopAt) {
      const path = PATHS[pathIdx++ % PATHS.length];
      const t0 = Date.now();
      try {
        const res = await fetch(BASE + path);
        await res.text();
        if (res.ok) ok++;
        else errors++;
      } catch {
        errors++;
      }
      latencies.push(Date.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  latencies.sort((a, b) => a - b);
  const secs = DURATION_MS / 1000;
  return {
    concurrency,
    throughput: (ok / secs).toFixed(1),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    errors,
  };
}

(async () => {
  console.log(`target=${BASE} paths=${PATHS.join(',')} duration=${DURATION_MS / 1000}s`);
  console.log('concurrency | req/s | p50 | p95 | p99 | errors');
  for (const c of CONCURRENCIES) {
    const r = await hammer(c);
    console.log(
      `${String(r.concurrency).padStart(11)} | ${String(r.throughput).padStart(5)} | ${String(r.p50).padStart(4)} | ${String(r.p95).padStart(4)} | ${String(r.p99).padStart(4)} | ${r.errors}`,
    );
    await new Promise((r2) => setTimeout(r2, 2000));
  }
})();
