import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { shortenAddress } from '@/lib/utils';
import { previewAddress } from '@/lib/address-preview';

/** The Living Curve mark, ported from the curv-ui spec. */
export function CurveMark({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 31C10.5 30.2 12.3 27.3 16.1 23.2C21 17.9 22.7 9.5 32 4"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

const NAV_LINKS = [
  { label: 'Discover', href: '/' },
  { label: 'Launch', href: '/create-pool' },
  { label: 'Presets', href: '/presets' },
  { label: 'Portfolio', href: '/portfolio' },
  { label: 'FAQs', href: '/faqs' },
];

function activeForPath(pathname: string): string {
  if (pathname === '/create-pool') return 'Launch';
  if (pathname === '/presets') return 'Presets';
  if (pathname === '/portfolio') return 'Portfolio';
  if (pathname === '/faqs') return 'FAQs';
  return 'Discover';
}

export const Header = () => {
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const router = useRouter();

  const { disconnect, publicKey } = useWallet();
  const address = useMemo(() => publicKey?.toBase58(), [publicKey]);
  const active = activeForPath(router.pathname);

  // ---- Address preview search (real behavior, spec styling) ----
  const [search, setSearch] = useState('');
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!search.trim() || searching) return;
    setSearching(true);
    setSearchMsg(null);
    const result = await previewAddress(search);
    setSearching(false);
    if (result.kind === 'pool') {
      setSearch('');
      router.push(`/token/${result.poolAddress}`);
    } else if (result.kind === 'unknown') {
      setSearchMsg('Not a Curv pool. This address is not tracked here.');
    } else if (result.kind === 'invalid') {
      setSearchMsg('That does not look like a Solana address.');
    } else {
      setSearchMsg('Could not check right now. Try again.');
    }
  }

  return (
    <header className="sc-header">
      <Link className="sc-brand" href="/" aria-label="Curv home">
        <CurveMark className="sc-brand-mark" />
        <span>curv</span>
      </Link>
      <nav className="sc-nav" aria-label="Main navigation">
        {NAV_LINKS.map((link) => (
          <Link
            key={link.label}
            href={link.href}
            className={active === link.label ? 'active' : ''}
            aria-current={active === link.label ? 'page' : undefined}
          >
            {link.label}
          </Link>
        ))}
      </nav>
      <form
        className="sc-global-search"
        onSubmit={onSearchSubmit}
        role="search"
        style={{ position: 'relative' }}
      >
        <span aria-hidden="true">⌕</span>
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSearchMsg(null);
          }}
          placeholder="Search tokens or tickers"
          aria-label="Search tokens or tickers"
          spellCheck={false}
        />
        {searchMsg && (
          <p
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 'calc(100% + 6px)',
              zIndex: 50,
              margin: 0,
              padding: '8px 10px',
              border: '1px solid #222829',
              borderRadius: 7,
              background: '#0e1213',
              color: '#a4aca4',
              fontSize: 11,
            }}
            role="status"
          >
            {searchMsg}
          </p>
        )}
      </form>
      {address ? (
        <button
          type="button"
          className="sc-wallet connected"
          onClick={() => disconnect()}
          title="Disconnect wallet"
        >
          <span className="sc-wallet-dot" aria-hidden="true" />
          {shortenAddress(address)}
        </button>
      ) : (
        <button
          type="button"
          className="sc-wallet disconnected"
          onClick={() => setWalletModalVisible(true)}
        >
          Connect wallet
        </button>
      )}
    </header>
  );
};

export default Header;
