import { Keypair } from '@solana/web3.js';
import {
  VANITY_SUFFIX,
  estimateVanityMintAttempts,
  matchesVanitySuffix,
} from './vanity-core';

// Re-exported so existing importers (create-pool.tsx, tests) keep working.
export { VANITY_SUFFIX, estimateVanityMintAttempts, matchesVanitySuffix };

/**
 * Vanity mint grinding for Curv launches.
 *
 * Every token launched through the app gets a mint address ending in
 * VANITY_SUFFIX (like pump.fun's "...pump"). Nothing on-chain enforces
 * this — it is purely cosmetic branding. The grind runs client-side in the
 * user's browser; the keypair never leaves browser memory, is never sent
 * to any server, never logged, and never persisted — exactly the same
 * handling as the ephemeral mint keypair the launch flow already used.
 *
 * Security invariants (covered by tests in vanity-mint.test.ts):
 * - the secret key is only ever held in memory and handed to the caller
 * - the suffix match is exact and case-sensitive (endsWith, no tricks)
 * - grinding performs zero network I/O
 */

export interface VanityProgress {
  attempts: number;
  attemptsPerSecond: number;
  elapsedMs: number;
}

export interface VanityMintResult {
  keypair: Keypair;
  attempts: number;
  durationMs: number;
}

export class VanityGrindAbortedError extends Error {
  constructor() {
    super('Vanity grind aborted');
    this.name = 'VanityGrindAbortedError';
  }
}

export interface GrindVanityMintOptions {
  suffix?: string;
  /** Injected for tests — production always uses Keypair.generate(). */
  generate?: () => Keypair;
  onProgress?: (p: VanityProgress) => void;
  signal?: AbortSignal;
  /** Yield to the event loop every N attempts so the page stays responsive. */
  yieldEvery?: number;
  /** Report progress every N attempts. */
  progressEvery?: number;
  /** Hard cap on attempts; 0 (default) means unlimited. */
  maxAttempts?: number;
}

function reportProgress(
  onProgress: ((p: VanityProgress) => void) | undefined,
  attempts: number,
  startedAt: number,
): void {
  if (!onProgress) return;
  const elapsedMs = Date.now() - startedAt;
  onProgress({
    attempts,
    attemptsPerSecond: elapsedMs > 0 ? (attempts / elapsedMs) * 1000 : 0,
    elapsedMs,
  });
}

/**
 * Single-threaded vanity grind. Yields to the event loop periodically so
 * the UI stays interactive, and throws VanityGrindAbortedError promptly
 * when the signal aborts. Used directly as the fallback when Web Workers
 * are unavailable, and inside each worker thread for the parallel grind.
 */
export async function grindVanityMint(
  opts: GrindVanityMintOptions = {},
): Promise<VanityMintResult> {
  const {
    suffix = VANITY_SUFFIX,
    generate = () => Keypair.generate(),
    onProgress,
    signal,
    yieldEvery = 2000,
    progressEvery = 2000,
    maxAttempts = 0,
  } = opts;
  if (!suffix) throw new Error('vanity suffix must be non-empty');
  if (signal?.aborted) throw new VanityGrindAbortedError();

  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    const kp = generate();
    attempts += 1;
    if (matchesVanitySuffix(kp.publicKey.toBase58(), suffix)) {
      reportProgress(onProgress, attempts, startedAt);
      return { keypair: kp, attempts, durationMs: Date.now() - startedAt };
    }
    if (maxAttempts > 0 && attempts >= maxAttempts) {
      throw new Error(`Vanity grind gave up after ${attempts} attempts`);
    }
    if (attempts % yieldEvery === 0) {
      // Let the browser paint and handle input between batches.
      await new Promise<void>((r) => setTimeout(r, 0));
      if (signal?.aborted) throw new VanityGrindAbortedError();
    }
    if (attempts % progressEvery === 0) {
      reportProgress(onProgress, attempts, startedAt);
      if (signal?.aborted) throw new VanityGrindAbortedError();
    }
  }
}

export interface ParallelGrindOptions {
  suffix?: string;
  onProgress?: (p: VanityProgress) => void;
  signal?: AbortSignal;
  /** Worker count; defaults to navigator.hardwareConcurrency, capped at 16. */
  workerCount?: number;
}

function defaultWorkerCount(): number {
  const hc =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(hc || 4, 16));
}

type WorkerCtor = new (url: URL) => Worker;

/**
 * Parallel vanity grind across Web Workers. Each worker grinds
 * independently with its own random seeds; the first to find a match wins.
 * Progress is aggregated and throttled so the UI isn't spammed.
 *
 * Falls back to the single-threaded grind when Web Workers are unavailable
 * (SSR, tests, old browsers) or when a worker fails to start — the caller
 * can't tell the difference apart from speed.
 */
export async function grindVanityMintParallel(
  opts: ParallelGrindOptions = {},
): Promise<VanityMintResult> {
  const { suffix = VANITY_SUFFIX, onProgress, signal } = opts;
  if (!suffix) throw new Error('vanity suffix must be non-empty');
  if (signal?.aborted) return Promise.reject(new VanityGrindAbortedError());

  const Ctor: WorkerCtor | undefined =
    typeof Worker !== 'undefined' ? (Worker as unknown as WorkerCtor) : undefined;
  if (!Ctor) {
    return grindVanityMint({ suffix, onProgress, signal });
  }

  const count = Math.max(1, Math.min(opts.workerCount ?? defaultWorkerCount(), 16));
  const startedAt = Date.now();
  const workerAttempts = new Array<number>(count).fill(0);
  let settled = false;
  let lastReportAt = 0;

  const aggregated = (): VanityProgress => {
    const attempts = workerAttempts.reduce((a, b) => a + b, 0);
    const elapsedMs = Date.now() - startedAt;
    return {
      attempts,
      attemptsPerSecond: elapsedMs > 0 ? (attempts / elapsedMs) * 1000 : 0,
      elapsedMs,
    };
  };
  const maybeReport = () => {
    const now = Date.now();
    if (onProgress && now - lastReportAt >= 250) {
      lastReportAt = now;
      onProgress(aggregated());
    }
  };

  return new Promise<VanityMintResult>((resolve, reject) => {
    const workers: Worker[] = [];
    const teardown = () => {
      for (const w of workers) {
        try {
          w.terminate();
        } catch {
          /* already gone */
        }
      }
    };
    const failover = (err: unknown) => {
      if (settled) return;
      settled = true;
      teardown();
      // Worker path broken (bad bundle, CSP, …) — single-threaded fallback.
      grindVanityMint({ suffix, onProgress, signal }).then(resolve, reject);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      teardown();
      reject(new VanityGrindAbortedError());
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      for (let i = 0; i < count; i++) {
        const worker = new Ctor(
          new URL('../workers/vanity-grind.worker.ts', import.meta.url),
        );
        const idx = i;
        workers.push(worker);
        worker.onmessage = (e: MessageEvent) => {
          if (settled) return;
          const msg = e.data as
            | { type: 'progress'; attempts: number }
            | { type: 'found'; secretKey: number[]; attempts: number }
            | { type: 'error'; message: string };
          if (msg.type === 'progress') {
            workerAttempts[idx] = msg.attempts;
            maybeReport();
          } else if (msg.type === 'found') {
            settled = true;
            teardown();
            signal?.removeEventListener('abort', onAbort);
            if (onProgress) onProgress(aggregated());
            resolve({
              keypair: Keypair.fromSecretKey(Uint8Array.from(msg.secretKey)),
              attempts: aggregated().attempts,
              durationMs: Date.now() - startedAt,
            });
          } else if (msg.type === 'error') {
            failover(new Error(msg.message));
          }
        };
        worker.onerror = () => failover(new Error('vanity worker failed to start'));
        worker.postMessage({ suffix });
      }
    } catch (e) {
      failover(e);
    }
  });
}
