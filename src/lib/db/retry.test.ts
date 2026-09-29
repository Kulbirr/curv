import { describe, expect, it, vi } from 'vitest';
import { _isConnectionError, _queryWithRetry } from './index';

describe('_isConnectionError', () => {
  it('classifies dead-connection errors', () => {
    expect(_isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(_isConnectionError(new Error('Connection ended unexpectedly'))).toBe(true);
    const reset = new Error('read ECONNRESET') as Error & { code: string };
    reset.code = 'ECONNRESET';
    expect(_isConnectionError(reset)).toBe(true);
    expect(_isConnectionError(new Error('terminating connection due to administrator command'))).toBe(true);
    expect(_isConnectionError(new Error('server closed the connection unexpectedly'))).toBe(true);
  });

  it('does not classify query errors as connection errors', () => {
    expect(_isConnectionError(new Error('duplicate key value violates unique constraint'))).toBe(false);
    expect(_isConnectionError(new Error('syntax error at or near "SELCT"'))).toBe(false);
    expect(_isConnectionError(new Error('boom'))).toBe(false);
    expect(_isConnectionError(null)).toBe(false);
    expect(_isConnectionError('Connection terminated unexpectedly')).toBe(true);
  });
});

describe('_queryWithRetry', () => {
  it('returns the first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(_queryWithRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries dead connections and returns the eventual success', async () => {
    const dead = new Error('Connection terminated unexpectedly');
    const fn = vi.fn().mockRejectedValueOnce(dead).mockRejectedValueOnce(dead).mockResolvedValue('ok');
    await expect(_queryWithRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry query errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('duplicate key value violates unique constraint'));
    await expect(_queryWithRetry(fn)).rejects.toThrow('duplicate key');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the max attempts and throws the last error', async () => {
    const dead = new Error('Connection terminated unexpectedly');
    const fn = vi.fn().mockRejectedValue(dead);
    await expect(_queryWithRetry(fn)).rejects.toThrow('Connection terminated unexpectedly');
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
