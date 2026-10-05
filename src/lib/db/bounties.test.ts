import { describe, expect, it } from 'vitest';
import {
  bountyCodeFor,
  compareScores,
  engagementScore,
  normalizeHashtag,
  tweetHasHashtag,
} from './bounties';

describe('engagementScore', () => {
  const w = { likes: 1, retweets: 3, replies: 2, views: 0 };
  it('weights likes/retweets/replies and ignores views by default', () => {
    expect(engagementScore({ likes: 10, retweets: 2, replies: 3, views: 5000 }, w)).toBe('22');
  });
  it('counts views in hundreds when enabled', () => {
    expect(
      engagementScore({ likes: 0, retweets: 0, replies: 0, views: 250 }, { ...w, views: 1 }),
    ).toBe('2');
  });
  it('clamps negatives to zero', () => {
    expect(engagementScore({ likes: -5, retweets: 0, replies: 0, views: 0 }, w)).toBe('0');
  });
});

describe('compareScores', () => {
  it('orders big scores without precision loss', () => {
    expect(compareScores('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareScores('5', '5')).toBe(0);
    expect(compareScores('3', '9')).toBe(-1);
  });
});

describe('normalizeHashtag', () => {
  it('lowercases and strips #', () => {
    expect(normalizeHashtag('#CurvLaunch')).toBe('curvlaunch');
  });
  it('rejects bad hashtags', () => {
    expect(normalizeHashtag('a')).toBeNull();
    expect(normalizeHashtag('has space')).toBeNull();
    expect(normalizeHashtag('x'.repeat(41))).toBeNull();
  });
});

describe('tweetHasHashtag', () => {
  it('matches case-insensitively with word boundary', () => {
    expect(tweetHasHashtag('Loving #CurvLaunch today', 'curvlaunch')).toBe(true);
    expect(tweetHasHashtag('no tag here', 'curvlaunch')).toBe(false);
    expect(tweetHasHashtag('#curvlauncher is different', 'curvlaunch')).toBe(false);
  });
});

describe('bountyCodeFor', () => {
  it('is deterministic and domain-separated from fee split codes', () => {
    const a = bountyCodeFor(7, 3);
    expect(a).toBe(bountyCodeFor(7, 3));
    expect(a).toMatch(/^CURV-[A-Z2-9]{6}$/);
    expect(a).not.toBe(bountyCodeFor(7, 4));
  });
});
