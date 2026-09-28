import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  VANITY_SUFFIX,
  VanityGrindAbortedError,
  estimateVanityMintAttempts,
  grindVanityMint,
  matchesVanitySuffix,
} from './vanity-mint';

function fakeKeypair(address: string): Keypair {
  return {
    publicKey: { toBase58: () => address },
    secretKey: new Uint8Array(64).fill(7),
  } as unknown as Keypair;
}

describe('matchesVanitySuffix', () => {
  it('matches an exact suffix', async () => {
    expect(matchesVanitySuffix('abcXYZcurv', 'curv')).toBe(true);
  });
  it('is case-sensitive', async () => {
    expect(matchesVanitySuffix('abcXYZCURV', 'curv')).toBe(false);
    expect(matchesVanitySuffix('abcXYZCurv', 'curv')).toBe(false);
    expect(matchesVanitySuffix('abcXYZcUrV', 'curv')).toBe(false);
  });
  it('rejects mid-string occurrences', async () => {
    expect(matchesVanitySuffix('curvXYZabc', 'curv')).toBe(false);
    expect(matchesVanitySuffix('abcurvXYZ', 'curv')).toBe(false);
  });
  it('rejects empty suffix', async () => {
    expect(matchesVanitySuffix('abcXYZcurv', '')).toBe(false);
  });
  it('rejects longer-than-address suffix', async () => {
    expect(matchesVanitySuffix('cur', 'curv')).toBe(false);
  });
});

describe('VANITY_SUFFIX', () => {
  it('is the Curv brand suffix', async () => {
    expect(VANITY_SUFFIX).toBe('curv');
  });
  it('uses only base58 characters', async () => {
    expect(/^[1-9A-HJ-NP-Za-km-z]+$/.test(VANITY_SUFFIX)).toBe(true);
  });
});

describe('estimateVanityMintAttempts', () => {
  it('is 58^4 for a 4-char suffix', async () => {
    expect(estimateVanityMintAttempts('curv')).toBe(11_316_496);
  });
  it('is 58^1 for a 1-char suffix', async () => {
    expect(estimateVanityMintAttempts('x')).toBe(58);
  });
});

describe('grindVanityMint', () => {
  it('returns the first keypair whose address ends with the suffix', async () => {
    const addrs = ['aaa111', 'bbb222', 'ccc333zz'];
    let i = 0;
    const res = await grindVanityMint({
      suffix: 'zz',
      generate: () => fakeKeypair(addrs[i++]),
      yieldEvery: 1000,
      progressEvery: 1000,
    });
    expect(res.keypair.publicKey.toBase58()).toBe('ccc333zz');
    expect(res.attempts).toBe(3);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns the exact keypair object from generate (no copies)', async () => {
    const kp = fakeKeypair('hitzz');
    const res = await grindVanityMint({ suffix: 'zz', generate: () => kp });
    expect(res.keypair).toBe(kp);
  });

  it('reports progress with attempts, rate and elapsed', async () => {
    const seen: number[] = [];
    let calls = 0;
    await grindVanityMint({
      suffix: 'zz',
      generate: () => fakeKeypair(calls++ < 4 ? 'nope00' : 'yeszz'),
      progressEvery: 2,
      yieldEvery: 2,
      onProgress: (p) => {
        seen.push(p.attempts);
        expect(typeof p.attemptsPerSecond).toBe('number');
        expect(p.elapsedMs).toBeGreaterThanOrEqual(0);
      },
    });
    expect(seen).toEqual([2, 4, 5]); // final report fires on success too
  });

  it('throws VanityGrindAbortedError when already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      grindVanityMint({ suffix: 'zz', generate: () => fakeKeypair('nope'), signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(VanityGrindAbortedError);
  });

  it('aborts promptly mid-grind', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    await expect(
      grindVanityMint({
        suffix: 'zz',
        generate: () => fakeKeypair('never-matches-00'),
        signal: ctrl.signal,
        progressEvery: 1,
        yieldEvery: 1,
        onProgress: () => {
          calls++;
          if (calls === 5) ctrl.abort();
        },
      }),
    ).rejects.toBeInstanceOf(VanityGrindAbortedError);
    expect(calls).toBe(5);
  });

  it('gives up after maxAttempts', async () => {
    await expect(
      grindVanityMint({
        suffix: 'zz',
        generate: () => fakeKeypair('nope00'),
        maxAttempts: 10,
        yieldEvery: 1000,
        progressEvery: 1000,
      }),
    ).rejects.toThrow(/gave up after 10 attempts/);
  });

  it('rejects an empty suffix', async () => {
    await expect(grindVanityMint({ suffix: '' })).rejects.toThrow(/non-empty/);
  });

  it('never logs the secret key or touches the network', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await grindVanityMint({
        suffix: 'zz',
        generate: () => fakeKeypair('okzz'),
        yieldEvery: 1000,
        progressEvery: 1000,
      });
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
