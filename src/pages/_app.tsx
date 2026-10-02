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
        <TokenPageHead og={(props.pageProps as { og?: TokenOgHead | null }).og ?? null} />
      </Head>
      <AppProviders {...props} />
    </ThemeProvider>
  );
}

/** Open Graph head for a token page, if the page supplied og props. */
interface TokenOgHead {
  name: string;
  symbol: string;
  quoteSymbol: string;
  address: string;
}

/**
 * Rendered in _app's Head (not the page's) because the page component
 * itself renders inside a client-only provider boundary: a Head placed
 * in the page never reaches server-rendered HTML, and link crawlers
 * only read the server HTML. This one is always server-rendered.
 */
function TokenPageHead({ og }: { og: TokenOgHead | null }) {
  if (!og) return null;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://curvpad.fun').replace(/\/+$/, '');
  const title = `${og.name} ($${og.symbol}) · Curv`;
  const description = `${og.name} ($${og.symbol}) is live on Curv, paired with ${og.quoteSymbol}. Fair launch on Meteora DBC with liquidity locked at graduation.`;
  const image = `${appUrl}/api/og/pool/${og.address}`;
  return (
    <>
      <title key="token-title">{title}</title>
      <meta key="token-desc" name="description" content={description} />
      <meta key="token-og-type" property="og:type" content="website" />
      <meta key="token-og-title" property="og:title" content={title} />
      <meta key="token-og-desc" property="og:description" content={description} />
      <meta key="token-og-url" property="og:url" content={`${appUrl}/token/${og.address}`} />
      <meta key="token-og-image" property="og:image" content={image} />
      <meta key="token-og-image-w" property="og:image:width" content="1200" />
      <meta key="token-og-image-h" property="og:image:height" content="630" />
      <meta key="token-tw-card" name="twitter:card" content="summary_large_image" />
      <meta key="token-tw-title" name="twitter:title" content={title} />
      <meta key="token-tw-desc" name="twitter:description" content={description} />
      <meta key="token-tw-image" name="twitter:image" content={image} />
    </>
  );
}
