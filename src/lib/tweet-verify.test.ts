import { describe, expect, it } from 'vitest';
import { extractTweetId, extractWalletFromText, tweetCodeFor, tweetIntentUrl } from './tweet-verify';

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
  it('builds a pre-filled intent URL containing the code and a wallet placeholder', () => {
    const url = tweetIntentUrl('CURV-ABCDEF');
    expect(url.startsWith('https://x.com/intent/post?text=')).toBe(true);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('CURV-ABCDEF');
    expect(decoded).toContain('PASTE_YOUR_SOLANA_WALLET_HERE');
  });
});

describe('extractWalletFromText', () => {
  const W1 = '7QxYBtYcJ8nWJ9zK3mP2vL5xR8tN1qA4sD6fG7hJ9kL';
  const W2 = 'B9FvhipCiG13g9RMf84Y1z4srURmi5fkkgfzT7UD8icr';

  it('returns null when no wallet is present', () => {
    expect(extractWalletFromText('Claiming my share. Code: CURV-ABCDEF')).toBeNull();
    expect(extractWalletFromText('')).toBeNull();
  });

  it('extracts a single valid wallet', () => {
    expect(extractWalletFromText(`Code CURV-ABCDEF, my wallet: ${W1}`)).toBe(W1);
  });

  it('returns null when two different wallets are present', () => {
    expect(extractWalletFromText(`Wallets ${W1} and ${W2}`)).toBeNull();
  });

  it('deduplicates the same wallet repeated', () => {
    expect(extractWalletFromText(`${W1} ... ${W1}`)).toBe(W1);
  });

  it('ignores the verification code (too short to match)', () => {
    expect(extractWalletFromText('CURV-ABCDEF')).toBeNull();
  });
});
