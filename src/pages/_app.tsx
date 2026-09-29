import '@/styles/globals.css';
import '@/styles/curv-spec.css';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { ThemeProvider } from 'next-themes';
import dynamic from 'next/dynamic';
import { getBaseUrl } from '@/lib/utils';

// Wallet adapters break Node SSR (Ledger ESM), load all wallet providers client-side only.
const AppProviders = dynamic(() => import('@/components/AppProviders'), {
  ssr: false,
});

export default function App(props: AppProps) {
  const router = useRouter();
  // Canonical always points at the production domain, even when the app is
  // served from a preview or backup origin.
  const canonicalBase =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') || getBaseUrl();
  const canonical = `${canonicalBase}${router.asPath.split('?')[0].split('#')[0] || '/'}`;
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
      <Head>
        <link rel="canonical" href={canonical} key="canonical" />
      </Head>
      <AppProviders {...props} />
    </ThemeProvider>
  );
}
