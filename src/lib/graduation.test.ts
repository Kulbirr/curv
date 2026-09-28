import { describe, expect, it } from 'vitest';
import { graduationDisplay } from './graduation';

describe('graduationDisplay', () => {
  it('computes reserve/threshold as a 0-100 percentage', async () => {
    expect(graduationDisplay(40, 80)).toEqual({ pct: 50, reached: false });
    expect(graduationDisplay(0, 80)).toEqual({ pct: 0, reached: false });
  });

  it('clamps over-threshold reserves to 100 and marks reached', async () => {
    expect(graduationDisplay(120, 80)).toEqual({ pct: 100, reached: true });
    expect(graduationDisplay(80, 80)).toEqual({ pct: 100, reached: true });
  });

  it('clamps negative reserves to 0', async () => {
    expect(graduationDisplay(-5, 80)).toEqual({ pct: 0, reached: false });
  });

  it('HONESTY: null pct when either input is missing or the threshold is not positive', async () => {
    expect(graduationDisplay(null, 80).pct).toBeNull();
    expect(graduationDisplay(40, null).pct).toBeNull();
    expect(graduationDisplay(40, 0).pct).toBeNull();
    expect(graduationDisplay(40, -10).pct).toBeNull();
    expect(graduationDisplay(NaN, 80).pct).toBeNull();
    expect(graduationDisplay(40, Number.POSITIVE_INFINITY).pct).toBeNull();
  });

  it('matches the indexer progress formula (quoteReserve / threshold * 100)', async () => {
    // pool-state.ts computes progress identically; the header bar and the
    // indexed value must never disagree.
    const quoteReserve = 33.333;
    const threshold = 100;
    const { pct } = graduationDisplay(quoteReserve, threshold);
    expect(pct).toBeCloseTo((quoteReserve / threshold) * 100, 10);
  });
});
