import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  VanityGrindAbortedError,
  grindVanityMintParallel,
  type VanityProgress,
} from './vanity-mint';

type WorkerMessage =
  | { type: 'progress'; attempts: number }
  | { type: 'found'; secretKey: number[]; attempts: number }
  | { type: 'error'; message: string };

/** Minimal Worker stand-in: the test drives its messages by hand. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: WorkerMessage }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];
  constructor(public url: URL) {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: unknown) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  emit(msg: WorkerMessage) {
    this.onmessage?.({ data: msg });
  }
  fail() {
    this.onerror?.(new Error('worker failed'));
  }
}

function stubWorker() {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('grindVanityMintParallel', () => {
  it('resolves with the found keypair and terminates every worker', async () => {
    stubWorker();
    const kp = Keypair.generate();
    const pending = grindVanityMintParallel({ suffix: 'zz', workerCount: 3 });
    expect(FakeWorker.instances).toHaveLength(3);
    // Workers receive the suffix to grind.
    for (const w of FakeWorker.instances) {
      expect(w.posted).toEqual([{ suffix: 'zz' }]);
    }
    FakeWorker.instances[1].emit({ type: 'progress', attempts: 1000 });
    FakeWorker.instances[1].emit({
      type: 'found',
      secretKey: Array.from(kp.secretKey),
      attempts: 1001,
    });
    const res = await pending;
    expect(res.keypair.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
  });

  it('aggregates worker progress', async () => {
    stubWorker();
    const seen: VanityProgress[] = [];
    const pending = grindVanityMintParallel({
      suffix: 'zz',
      workerCount: 1,
      onProgress: (p) => seen.push(p),
    });
    FakeWorker.instances[0].emit({ type: 'progress', attempts: 500 });
    expect(seen).toHaveLength(1);
    expect(seen[0].attempts).toBe(500);
    expect(typeof seen[0].attemptsPerSecond).toBe('number');
    // Late winner still resolves after progress was reported.
    const kp = Keypair.generate();
    FakeWorker.instances[0].emit({
      type: 'found',
      secretKey: Array.from(kp.secretKey),
      attempts: 501,
    });
    const res = await pending;
    expect(res.keypair.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('aborts all workers and rejects with VanityGrindAbortedError', async () => {
    stubWorker();
    const ctrl = new AbortController();
    const pending = grindVanityMintParallel({
      suffix: 'zz',
      workerCount: 2,
      signal: ctrl.signal,
    });
    expect(FakeWorker.instances).toHaveLength(2);
    ctrl.abort();
    await expect(pending).rejects.toBeInstanceOf(VanityGrindAbortedError);
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
  });

  it('rejects immediately on a pre-aborted signal without spawning workers', async () => {
    stubWorker();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      grindVanityMintParallel({ suffix: 'zz', workerCount: 2, signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(VanityGrindAbortedError);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('falls back to single-threaded grind when Worker is unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    // 1-char suffix: ~58 attempts expected, completes in well under a second.
    const res = await grindVanityMintParallel({ suffix: '1' });
    expect(res.keypair.publicKey.toBase58().endsWith('1')).toBe(true);
    expect(res.attempts).toBeGreaterThan(0);
  });

  it('falls back to single-threaded grind when a worker errors', async () => {
    stubWorker();
    const pending = grindVanityMintParallel({ suffix: '1', workerCount: 2 });
    FakeWorker.instances[0].fail();
    const res = await pending;
    expect(res.keypair.publicKey.toBase58().endsWith('1')).toBe(true);
    // Broken workers were torn down before the fallback.
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
  });

  it('rejects an empty suffix', async () => {
    stubWorker();
    await expect(grindVanityMintParallel({ suffix: '' })).rejects.toThrow(/non-empty/);
  });
});
