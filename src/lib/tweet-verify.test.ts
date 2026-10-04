import { describe, expect, it } from 'vitest';
import { extractTweetId, tweetCodeFor, tweetIntentUrl } from './tweet-verify';

describe('tweetCodeFor', () => {
  it('is deterministic per pool and entry', () => {
    const a = tweetCodeFor('Pool11111111111111111111111111111111111111111', 0);
    const b = tweetCodeFor('Pool11111111111111111111111111111111111111111', 0);
    expect(a).toBe(b);
    expect(a).toMatch(/^CURV-[A-Z2-9]{6}$/);
  });

  it('differs across entries and pools', () => {
    const pool = 'Pool11111111111111111111111111111111111111111';
    expect(tweetCodeFor(pool, 0)).not.toBe(tweetCodeFor(pool, 1));
    expect(tweetCodeFor(pool, 0)).not.toBe(
      tweetCodeFor('Pool22222222222222222222222222222222222222222', 0)
    );
  });

  it('uses an unambiguous alphabet', () => {
    for (let i = 0; i < 20; i++) {
      const code = tweetCodeFor(`Pool${i}1111111111111111111111111111111111111`, i);
      expect(code).not.toMatch(/[01IO]/);
    }
  });
});

describe('extractTweetId', () => {
  it('parses x.com and twitter.com status URLs', () => {
    expect(extractTweetId('https://x.com/someuser/status/1234567890123456789')).toBe(
      '1234567890123456789'
    );
    expect(extractTweetId('https://twitter.com/someuser/status/987654321')).toBe('987654321');
    expect(extractTweetId('https://x.com/someuser/status/1234567890123456789?s=20')).toBe(
      '1234567890123456789'
    );
  });

  it('rejects non-status URLs', () => {
    expect(extractTweetId('https://x.com/someuser')).toBeNull();
    expect(extractTweetId('not a url')).toBeNull();
    expect(extractTweetId('')).toBeNull();
  });
});

describe('tweetIntentUrl', () => {
  it('builds a pre-filled intent URL containing the code', () => {
    const url = tweetIntentUrl('CURV-ABCDEF');
    expect(url.startsWith('https://x.com/intent/post?text=')).toBe(true);
    expect(decodeURIComponent(url)).toContain('CURV-ABCDEF');
  });
});
