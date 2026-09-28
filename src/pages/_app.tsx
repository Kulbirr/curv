import '@/styles/globals.css';
import '@/styles/curv-spec.css';
import type { AppProps } from 'next/app';
import { ThemeProvider } from 'next-themes';
import dynamic from 'next/dynamic';

// Wallet adapters break Node SSR (Ledger ESM) — load all wallet providers client-side only.
const AppProviders = dynamic(() => import('@/components/AppProviders'), {
  ssr: false,
});

export default function App(props: AppProps) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
      <AppProviders {...props} />
    </ThemeProvider>
  );
}
