import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildJudgePrompt,
  judgeEndpoint,
  parseJudgeReply,
  runJudge,
  sanitizeAiText,
} from './judge';
import type { CandidateInput, GateResult, MarketSnapshot } from './gates';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.JUDGE_PROVIDER;
  delete process.env.JUDGE_MODEL;
});

function input(): { candidate: CandidateInput; market: MarketSnapshot | null; gateResults: GateResult[] } {
  return {
    candidate: {
      baseMint: 'SOL_MINT',
      baseSymbol: 'SOL',
      quoteMint: 'USDC_MINT',
      quoteSymbol: 'USDC',
      entryLow: 100,
      entryHigh: 105,
      stopPrice: 95,
      targets: [115, 130],
      sizeText: null,
      thesis: 'Clean retest of the broken level with rising volume.',
      noKnownUnlock: true,
    },
    market: {
      coingeckoId: 'solana',
      price: 102,
      change24hPct: 1.5,
      change7dPct: 6,
      volume24h: 2_000_000_000,
      volume30dAvg: 1_800_000_000,
      mcap: 70_000_000_000,
      fetchedAt: Date.now(),
    },
    gateResults: [{ name: 'universe', status: 'pass', reason: 'in universe' }],
  };
}

describe('sanitizeAiText', () => {
  it('removes dash characters', () => {
    expect(sanitizeAiText('risk-reward is good — really good')).not.toMatch(/[-—–]/);
  });
  it('collapses whitespace', () => {
    expect(sanitizeAiText('  too   many   spaces  ')).toBe('too many spaces');
  });
});

describe('buildJudgePrompt', () => {
  it('embeds the candidate, market and gates', () => {
    const { system, user } = buildJudgePrompt(input());
    expect(system).toContain('strict JSON');
    expect(user).toContain('SOL');
    expect(user).toContain('100 to 105');
    expect(user).toContain('Live price: $102');
    expect(user).toContain('universe: pass');
  });
  it('handles a missing market snapshot', () => {
    const { user } = buildJudgePrompt({ ...input(), market: null });
    expect(user).toContain('Market snapshot unavailable');
  });
});

describe('parseJudgeReply', () => {
  it('parses strict JSON', () => {
    const parsed = parseJudgeReply(
      '{"verdict":"approved","reasons":["Clean retest zone"],"checks":[{"name":"entry quality","pass":true,"note":"ok"}]}',
    );
    expect(parsed?.verdict).toBe('approved');
    expect(parsed?.reasons).toEqual(['Clean retest zone']);
    expect(parsed?.checks).toHaveLength(1);
  });
  it('parses JSON wrapped in fences', () => {
    const parsed = parseJudgeReply(
      '```json\n{"verdict":"rejected","reasons":["Chasing"],"checks":[]}\n```',
    );
    expect(parsed?.verdict).toBe('rejected');
  });
  it('rejects a bad verdict value', () => {
    expect(parseJudgeReply('{"verdict":"maybe","reasons":["x"],"checks":[]}')).toBeNull();
  });
  it('rejects missing reasons', () => {
    expect(parseJudgeReply('{"verdict":"approved","reasons":[],"checks":[]}')).toBeNull();
  });
  it('rejects non JSON', () => {
    expect(parseJudgeReply('I approve this trade')).toBeNull();
  });
  it('sanitizes dashes from reasons', () => {
    const parsed = parseJudgeReply(
      '{"verdict":"approved","reasons":["risk-reward looks good"],"checks":[]}',
    );
    expect(parsed?.reasons[0]).not.toMatch(/[-—–]/);
  });
});

describe('runJudge', () => {
  it('returns unavailable without an API key', async () => {
    const r = await runJudge(input());
    expect(r.status).toBe('unavailable');
  });

  it('returns ok on a valid model reply', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"verdict":"approved","reasons":["Clean zone"],"checks":[{"name":"entry quality","pass":true,"note":"retest"}]}',
              },
            },
          ],
        }),
      })),
    );
    const r = await runJudge(input());
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.verdict).toBe('approved');
      expect(r.model).toContain('hermes');
    }
  });

  it('returns error on http failure', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })));
    const r = await runJudge(input());
    expect(r.status).toBe('error');
  });

  it('returns error on garbage reply', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'not json' } }] }),
      })),
    );
    const r = await runJudge(input());
    expect(r.status).toBe('error');
  });
});

describe('judgeEndpoint', () => {
  it('returns null with no key configured', () => {
    expect(judgeEndpoint()).toBeNull();
  });

  it('uses OpenRouter by default with its key', () => {
    process.env.OPENROUTER_API_KEY = 'x';
    const e = judgeEndpoint();
    expect(e?.url).toContain('openrouter.ai');
    expect(e?.model).toBe('nousresearch/hermes-4-70b');
    expect(e?.headers['http-referer']).toBe('https://curvpad.fun');
  });

  it('uses NVIDIA when JUDGE_PROVIDER=nvidia', () => {
    process.env.JUDGE_PROVIDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'y';
    const e = judgeEndpoint();
    expect(e?.url).toContain('integrate.api.nvidia.com');
    expect(e?.model).toBe('nvidia/nemotron-3-super-120b-a12b');
  });

  it('returns null for nvidia provider without its key', () => {
    process.env.JUDGE_PROVIDER = 'nvidia';
    process.env.OPENROUTER_API_KEY = 'x';
    expect(judgeEndpoint()).toBeNull();
  });

  it('JUDGE_MODEL overrides the provider default', () => {
    process.env.JUDGE_PROVIDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'y';
    process.env.JUDGE_MODEL = 'custom/model';
    expect(judgeEndpoint()?.model).toBe('custom/model');
  });

  it('reports the nvidia key missing for that provider', async () => {
    process.env.JUDGE_PROVIDER = 'nvidia';
    const r = await runJudge(input());
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toContain('NVIDIA_API_KEY');
  });
});
