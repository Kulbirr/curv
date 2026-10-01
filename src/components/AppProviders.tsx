import { useEffect, useMemo } from 'react';
import type { AppProps } from 'next/app';
import { useTheme } from 'next-themes';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';
import { WalletAdapterNetwork, type Adapter } from '@solana/wallet-adapter-base';
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
import { SOLANA_NETWORK, SOLANA_RPC_URL } from '@/lib/solana';

// Client-only: wallet adapters pull in Ledger deps that break Node SSR
// (this module is dynamically imported with ssr:false from _app.tsx).
//
// We register the Solana Mobile Wallet Adapter exactly once at module scope.
// (A previous integration re-registered it on every render, which produced
// several identical "Mobile" tiles in the connect modal.)
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
      chains: ['solana:mainnet', 'solana:devnet'],
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
    const list: Adapter[] = [
      new PhantomWalletAdapter(),
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

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={SOLANA_RPC_URL}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>
            <Toaster
              theme={resolvedTheme === 'light' ? 'light' : 'dark'}
              richColors
              closeButton
            />
            <Component {...pageProps} />
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
