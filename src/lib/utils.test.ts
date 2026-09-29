import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNever, cn, getBaseUrl } from './utils';

describe('cn', () => {
  it('merges class names and resolves tailwind conflicts', async () => {
    expect(cn('a', 'b')).toBe('a b');
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn(null, undefined, 'x')).toBe('x');
  });
});

describe('assertNever', () => {
  it('throws with the default and custom messages', async () => {
    expect(() => assertNever('x' as never)).toThrow('Unknown error occured.');
    expect(() => assertNever('x' as never, 'custom')).toThrow('custom');
  });
});

describe('getBaseUrl', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('uses localhost in development', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'development');
    expect((await import('./utils')).getBaseUrl()).toBe('http://localhost:3000');
    vi.resetModules();
  });
  it('prefers the canonical app URL when set', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://curvpad.fun/');
    vi.resetModules();
    expect((await import('./utils')).getBaseUrl()).toBe('https://curvpad.fun');
    vi.resetModules();
  });
  it('falls back to the production default', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERCEL_BRANCH_URL', '');
    expect(getBaseUrl()).toBe('https://curvpad.fun');
  });
});
