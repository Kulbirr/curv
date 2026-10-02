import { describe, expect, it, vi, afterEach } from 'vitest';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import {
  isAndroidBrowser,
  hasInjectedSolanaProvider,
  markLoadableForAndroidDeepLink,
} from './mobile-wallet';

const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function stubBrowser(userAgent: string, injected?: { phantom?: unknown; solana?: unknown }) {
  vi.stubGlobal('window', { ...(injected ?? {}) });
  vi.stubGlobal('navigator', { userAgent });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isAndroidBrowser', () => {
  it('detects Android Chrome', () => {
    stubBrowser(ANDROID_CHROME_UA);
    expect(isAndroidBrowser()).toBe(true);
  });

  it('rejects iPhone Safari', () => {
    stubBrowser(IPHONE_SAFARI_UA);
    expect(isAndroidBrowser()).toBe(false);
  });

  it('rejects desktop Chrome', () => {
    stubBrowser(DESKTOP_UA);
    expect(isAndroidBrowser()).toBe(false);
  });

  it('is false with no window (SSR)', () => {
    expect(isAndroidBrowser()).toBe(false);
  });
});

describe('hasInjectedSolanaProvider', () => {
  it('detects window.phantom.solana', () => {
    stubBrowser(ANDROID_CHROME_UA, { phantom: { solana: {} } });
    expect(hasInjectedSolanaProvider()).toBe(true);
  });

  it('detects window.solana', () => {
    stubBrowser(ANDROID_CHROME_UA, { solana: {} });
    expect(hasInjectedSolanaProvider()).toBe(true);
  });

  it('is false in a plain browser', () => {
    stubBrowser(ANDROID_CHROME_UA);
    expect(hasInjectedSolanaProvider()).toBe(false);
  });
});

function fakeAdapter(state: WalletReadyState) {
  return { readyState: state, _readyState: state };
}

describe('markLoadableForAndroidDeepLink', () => {
  it('promotes NotDetected to Loadable on Android without injection', () => {
    stubBrowser(ANDROID_CHROME_UA);
    const adapter = fakeAdapter(WalletReadyState.NotDetected);
    markLoadableForAndroidDeepLink(adapter);
    expect(adapter._readyState).toBe(WalletReadyState.Loadable);
  });

  it('does nothing when a provider is injected (in-app browser)', () => {
    stubBrowser(ANDROID_CHROME_UA, { phantom: { solana: {} } });
    const adapter = fakeAdapter(WalletReadyState.NotDetected);
    markLoadableForAndroidDeepLink(adapter);
    expect(adapter._readyState).toBe(WalletReadyState.NotDetected);
  });

  it('does nothing on iPhone', () => {
    stubBrowser(IPHONE_SAFARI_UA);
    const adapter = fakeAdapter(WalletReadyState.NotDetected);
    markLoadableForAndroidDeepLink(adapter);
    expect(adapter._readyState).toBe(WalletReadyState.NotDetected);
  });

  it('does nothing on desktop', () => {
    stubBrowser(DESKTOP_UA);
    const adapter = fakeAdapter(WalletReadyState.NotDetected);
    markLoadableForAndroidDeepLink(adapter);
    expect(adapter._readyState).toBe(WalletReadyState.NotDetected);
  });

  it('never overrides an Installed adapter', () => {
    stubBrowser(ANDROID_CHROME_UA);
    const adapter = fakeAdapter(WalletReadyState.Installed);
    markLoadableForAndroidDeepLink(adapter);
    expect(adapter._readyState).toBe(WalletReadyState.Installed);
  });

  it('is a no-op during SSR', () => {
    const adapter = fakeAdapter(WalletReadyState.NotDetected);
    markLoadableForAndroidDeepLink(adapter);
    expect(adapter._readyState).toBe(WalletReadyState.NotDetected);
  });
});
