import { useEffect, useMemo } from 'react';
import type { AppProps } from 'next/app';
import { useTheme } from 'next-themes';
import {
  Adapter,
  UnifiedWalletProvider,
} from '@jup-ag/wallet-adapter';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { BackpackWalletAdapter } from '@solana/wallet-adapter-backpack';
import { CoinbaseWalletAdapter } from '@solana/wallet-adapter-coinbase';
import { WalletConnectWalletAdapter } from '@solana/wallet-adapter-walletconnect';
import {
  registerMwa,
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
} from '@solana-mobile/wallet-standard-mobile';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { useWindowWidthListener } from '@/lib/device';
import { SOLANA_NETWORK } from '@/lib/solana';
import { markLoadableForAndroidDeepLink } from '@/lib/mobile-wallet';

// Client-only: wallet adapters pull in Ledger deps that break Node SSR
// (this module is dynamically imported with ssr:false from _app.tsx).
//
// We register the Solana Mobile Wallet Adapter exactly once at module scope.
// (A previous integration re-registered it on every render, which produced
// several identical "Mobile" tiles in the connect modal.)
// The dapp must only advertise the network it is actually pointed at.
// @solana-mobile's default chain selector prefers solana:mainnet whenever it
// appears in the chain list, so declaring both chains makes Android wallet
// authorize requests ask for mainnet — Phantom in Testnet Mode then rejects
// the connection with "Incorrect mode" on our devnet deployment.
const MWA_CHAINS: [`${string}:${string}`] =
  SOLANA_NETWORK === 'mainnet-beta' ? ['solana:mainnet'] : ['solana:devnet'];

// Jupiter's bundled wallet adapter registers its own MWA wallet with a
// hardcoded mainnet-first chain list (rewritten at install time by
// scripts/patch-jup-mwa.cjs). Expose our chain list on window before any
// provider renders so the patched bundle picks it up.
//
// Jupiter's provider also calls registerMwa() on every render with no dedupe,
// which produced duplicate "Mobile" tiles alongside our own once-guarded
// registration. Setting __CURV_MWA_DONE__ here (honored by the same patch
// script) suppresses Jupiter's registration; ours below is the single MWA
// wallet.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__CURV_MWA_CHAINS__ =
    MWA_CHAINS;
  (window as unknown as Record<string, unknown>).__CURV_MWA_DONE__ = true;
}

let mwaRegistered = false;
function registerMobileWalletAdapterOnce() {
  if (mwaRegistered || typeof window === 'undefined') return;
  mwaRegistered = true;
  try {
    const appUrl = (
      process.env.NEXT_PUBLIC_APP_URL || 'https://curvpad.fun'
    ).replace(/\/+$/, '');
    registerMwa({
      appIdentity: { name: 'Curv', uri: appUrl },
      authorizationCache: createDefaultAuthorizationCache(),
      chains: MWA_CHAINS,
      chainSelector: createDefaultChainSelector(),
      onWalletNotFound: createDefaultWalletNotFoundHandler(),
    });
  } catch (err) {
    console.warn('[wallet] mobile wallet adapter registration failed', err);
  }
}

export default function AppProviders({ Component, pageProps }: AppProps) {
  const { resolvedTheme } = useTheme();
  const queryClient = useMemo(() => new QueryClient(), []);

  useWindowWidthListener();

  useEffect(() => {
    registerMobileWalletAdapterOnce();
  }, []);

  const network =
    SOLANA_NETWORK === 'mainnet-beta'
      ? WalletAdapterNetwork.Mainnet
      : WalletAdapterNetwork.Devnet;

  const wallets = useMemo<Adapter[]>(() => {
    const appUrl = (
      process.env.NEXT_PUBLIC_APP_URL || 'https://curvpad.fun'
    ).replace(/\/+$/, '');
    const phantom = new PhantomWalletAdapter();
    // Upstream only deep-links Phantom's in-app browser on iOS; Android
    // supports the same ul/browse link. Without this the Phantom tile on
    // Android is a dead end that just opens the wallet's home screen.
    markLoadableForAndroidDeepLink(
      phantom as unknown as Parameters<typeof markLoadableForAndroidDeepLink>[0]
    );
    const list: Adapter[] = [
      phantom,
      new SolflareWalletAdapter(),
      new BackpackWalletAdapter(),
      new CoinbaseWalletAdapter(),
    ];
    // WalletConnect (covers MetaMask mobile and hundreds of other wallets
    // via QR / deep link). Needs a free project id from
    // https://cloud.walletconnect.com as NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID.
    const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    if (wcProjectId) {
      try {
        list.push(
          new WalletConnectWalletAdapter({
            network,
            options: {
              relayUrl: 'wss://relay.walletconnect.com',
              projectId: wcProjectId,
              metadata: {
                name: 'Curv',
                description: 'Curv bonding-curve launchpad on Solana',
                url: appUrl,
                icons: [`${appUrl}/curv-icon-512.png`],
              },
            },
          })
        );
      } catch (err) {
        console.warn('[wallet] WalletConnect adapter init failed', err);
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);

  const walletTheme = resolvedTheme === 'light' ? 'light' : 'dark';
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://curvpad.fun').replace(
    /\/+$/,
    ''
  );

  return (
    <QueryClientProvider client={queryClient}>
      <UnifiedWalletProvider
        wallets={wallets}
        config={{
          env: SOLANA_NETWORK,
          autoConnect: true,
          metadata: {
            name: 'Curv',
            description: 'Curv bonding-curve launchpad on Solana',
            url: appUrl,
            iconUrls: [`${appUrl}/curv-icon-512.png`],
          },
          theme: walletTheme,
          lang: 'en',
        }}
      >
        <Toaster theme={walletTheme} richColors closeButton />
        <Component {...pageProps} />
      </UnifiedWalletProvider>
    </QueryClientProvider>
  );
}
