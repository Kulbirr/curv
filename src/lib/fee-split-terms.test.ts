import { describe, expect, it } from 'vitest';
import {
  normalizePlatform,
  validateFeeSplits,
} from './fee-split-terms';

const CREATOR = '4zmTkFjKrcYyy5B5s116vJAxxMwuvfpjZuUTv6xJe9Rz';

describe('normalizePlatform', () => {
  it('defaults to x for absent or unknown values', () => {
    expect(normalizePlatform(undefined)).toBe('x');
    expect(normalizePlatform(null)).toBe('x');
    expect(normalizePlatform('')).toBe('x');
    expect(normalizePlatform('instagram')).toBe('x');
  });
  it('passes through known platforms', () => {
    expect(normalizePlatform('x')).toBe('x');
    expect(normalizePlatform('twitch')).toBe('twitch');
    expect(normalizePlatform('reddit')).toBe('reddit');
  });
});

describe('validateFeeSplits platform handles', () => {
  it('accepts a valid Twitch handle', () => {
    const out = validateFeeSplits(
      [{ bps: 1000, handle: 'ninja', platform: 'twitch' }],
      CREATOR,
    );
    expect(out[0].handle).toBe('ninja');
    expect(out[0].platform).toBe('twitch');
  });

  it('rejects a Twitch handle that is too short', () => {
    expect(() =>
      validateFeeSplits([{ bps: 1000, handle: 'ab', platform: 'twitch' }], CREATOR),
    ).toThrow(/Twitch handle.*not valid/);
  });

  it('rejects a Twitch handle with invalid characters', () => {
    expect(() =>
      validateFeeSplits([{ bps: 1000, handle: 'nin-ja', platform: 'twitch' }], CREATOR),
    ).toThrow(/Twitch handle.*not valid/);
  });

  it('accepts a valid Reddit username with dash', () => {
    const out = validateFeeSplits(
      [{ bps: 1000, handle: 'spez-1', platform: 'reddit' }],
      CREATOR,
    );
    expect(out[0].handle).toBe('spez-1');
    expect(out[0].platform).toBe('reddit');
  });

  it('rejects a Reddit username that is too short', () => {
    expect(() =>
      validateFeeSplits([{ bps: 1000, handle: 'ab', platform: 'reddit' }], CREATOR),
    ).toThrow(/Reddit handle.*not valid/);
  });

  it('accepts a valid X handle and omits the platform (backward compatible)', () => {
    const out = validateFeeSplits([{ bps: 1000, handle: 'nadandarindaa' }], CREATOR);
    expect(out[0].handle).toBe('nadandarindaa');
    expect(out[0].platform).toBeUndefined();
  });

  it('rejects an X handle that is too long', () => {
    expect(() =>
      validateFeeSplits([{ bps: 1000, handle: 'a'.repeat(16) }], CREATOR),
    ).toThrow(/X handle.*not valid/);
  });

  it('treats the same handle on different platforms as distinct', () => {
    const out = validateFeeSplits(
      [
        { bps: 1000, handle: 'ninja', platform: 'twitch' },
        { bps: 1000, handle: 'ninja', platform: 'reddit' },
      ],
      CREATOR,
    );
    expect(out).toHaveLength(2);
  });

  it('rejects the same handle twice on the same platform', () => {
    expect(() =>
      validateFeeSplits(
        [
          { bps: 1000, handle: 'ninja', platform: 'twitch' },
          { bps: 1000, handle: 'NINJA', platform: 'twitch' },
        ],
        CREATOR,
      ),
    ).toThrow(/appears twice/);
  });

  it('strips u/ prefix from Reddit handles', () => {
    const out = validateFeeSplits(
      [{ bps: 1000, handle: 'u/spez', platform: 'reddit' }],
      CREATOR,
    );
    expect(out[0].handle).toBe('spez');
  });
});
