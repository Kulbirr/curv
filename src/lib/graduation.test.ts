import { describe, expect, it } from 'vitest';
import { displayProgress } from './graduation';

describe('displayProgress', () => {
  it('passes valid 0-100 values through unchanged', () => {
    expect(displayProgress(0)).toBe(0);
    expect(displayProgress(50)).toBe(50);
    expect(displayProgress(6.42)).toBe(6.42);
    expect(displayProgress(100)).toBe(100);
  });

  it('clamps out-of-range values into 0-100', () => {
    expect(displayProgress(-5)).toBe(0);
    expect(displayProgress(-0.001)).toBe(0);
    expect(displayProgress(100.4)).toBe(100);
    expect(displayProgress(250)).toBe(100);
  });

  it('returns null for missing or non-finite input', () => {
    expect(displayProgress(null)).toBeNull();
    expect(displayProgress(undefined)).toBeNull();
    expect(displayProgress(NaN)).toBeNull();
    expect(displayProgress(Number.POSITIVE_INFINITY)).toBeNull();
    expect(displayProgress(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('never invents a value: null in means null out', () => {
    // The UI hides the badge / renders a dash on null. It must not fall
    // back to recomputing a percent from reserves (see module docs):
    // the indexer's progress field is the single source of truth.
    expect(displayProgress(null)).toBeNull();
  });
});
