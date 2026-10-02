import { WalletReadyState } from '@solana/wallet-adapter-base';

/**
 * Android mobile wallet plumbing.
 *
 * Two upstream gaps this module papers over:
 *
 * 1. Phantom deep link is iOS-only upstream. @solana/wallet-adapter-phantom
 *    marks itself WalletReadyState.Loadable (which makes tapping the tile
 *    open the wallet's in-app browser via the ul/browse universal link) only
 *    when isIosAndRedirectable(). Android supports the same
 *    https://phantom.app/ul/browse/<dapp> universal links, but on Android the
 *    adapter stays NotDetected, so the connect modal shows a "Have you
 *    installed Phantom?" dead end whose link just opens the wallet's home
 *    screen. markLoadableForAndroidDeepLink() below promotes it to Loadable
 *    on Android browsers without an injected provider.
 *
 * 2. Duplicate "Mobile" tiles. Both our AppProviders and Jupiter's bundled
 *    WalletConnectionProvider call registerMwa(), and registerMwa() does not
 *    dedupe, so the modal shows two identical Mobile Wallet Adapter entries.
 *    We set window.__CURV_MWA_DONE__ at module scope and the postinstall
 *    patch (scripts/patch-jup-mwa.cjs) makes Jupiter's registration respect
 *    it, leaving exactly one MWA wallet: ours.
 */

/** True on Android browsers (Chrome, Firefox, Samsung Internet, ...). */
export function isAndroidBrowser(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return /android/i.test(navigator.userAgent);
}

/** True when a Solana wallet injects a provider (e.g. inside a wallet's in-app browser). */
export function hasInjectedSolanaProvider(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { phantom?: { solana?: unknown }; solana?: unknown };
  return Boolean(w.phantom?.solana ?? w.solana);
}

interface MutableReadyState {
  readonly readyState: WalletReadyState;
  _readyState: WalletReadyState;
}

/**
 * Promote an adapter to Loadable on Android so its deep link fires.
 * No-op unless ALL of these hold: Android browser, no injected provider,
 * and the adapter currently reports NotDetected. In particular this never
 * overrides Installed/Loadable states set by upstream detection.
 */
export function markLoadableForAndroidDeepLink(adapter: MutableReadyState): void {
  if (!isAndroidBrowser()) return;
  if (hasInjectedSolanaProvider()) return;
  if (adapter.readyState !== WalletReadyState.NotDetected) return;
  adapter._readyState = WalletReadyState.Loadable;
}
