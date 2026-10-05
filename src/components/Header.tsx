import { useWallet } from '@solana/wallet-adapter-react';
import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { shortenAddress } from '@/lib/utils';
import { parsePreviewAddress, previewAddress } from '@/lib/address-preview';
import { NotificationBell } from '@/components/NotificationBell';

/** The Curv brand mark: the signature green curve. */
export function CurveMark({ className = '' }: { className?: string }) {
  return (
    <img
      src="/curv-logo.png"
      alt=""
      aria-hidden="true"
      className={className}
      style={{ objectFit: 'contain' }}
    />
  );
}

const NAV_LINKS = [
  { label: 'Discover', href: '/' },
  { label: 'Launch', href: '/create-pool' },
  { label: 'Signals', href: '/strategies' },
  { label: 'Presets', href: '/presets' },
  { label: 'Portfolio', href: '/portfolio' },
  { label: 'Claim', href: '/claim' },
  { label: 'FAQs', href: '/faqs' },
];

function activeForPath(pathname: string): string {
  if (pathname === '/create-pool') return 'Launch';
  if (pathname === '/strategies') return 'Signals';
  if (pathname === '/presets') return 'Presets';
  if (pathname === '/portfolio') return 'Portfolio';
  if (pathname === '/claim') return 'Claim';
  if (pathname === '/faqs') return 'FAQs';
  return 'Discover';
}

export const Header = () => {
  const { setShowModal: setWalletModalVisible } = useUnifiedWalletContext();
  const router = useRouter();

  const { disconnect, publicKey } = useWallet();
  const address = useMemo(() => publicKey?.toBase58(), [publicKey]);
  const active = activeForPath(router.pathname);

  // ---- Connected-wallet menu (copy address / disconnect) ----
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // Clipboard API unavailable (permissions / insecure context): fallback.
      const ta = document.createElement('textarea');
      ta.value = address;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      setMenuOpen(false);
    }, 900);
  }

  async function onDisconnect() {
    setMenuOpen(false);
    try {
      await disconnect();
    } catch {
      // Disconnect failures are non-fatal; the adapter resets on next connect.
    }
  }

  // ---- Address preview search (real behavior, spec styling) ----
  const [search, setSearch] = useState('');
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const query = search.trim();
    if (!query || searching) return;
    // A pasted address jumps straight to that token when it is tracked.
    if (parsePreviewAddress(query)) {
      setSearching(true);
      setSearchMsg(null);
      const result = await previewAddress(search);
      setSearching(false);
      if (result.kind === 'pool' || result.kind === 'mint') {
        setSearch('');
        router.push(`/token/${result.poolAddress}`);
      } else if (result.kind === 'unknown') {
        setSearchMsg('Not a Curv pool. This address is not tracked here.');
      } else if (result.kind === 'invalid') {
        setSearchMsg('That does not look like a Solana address.');
      } else {
        setSearchMsg('Could not check right now. Try again.');
      }
      return;
    }
    // A name or ticker hands off to Discover, which filters the token list.
    setSearch('');
    setSearchMsg(null);
    router.push({ pathname: '/', query: { q: query } });
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
          placeholder="Search name, ticker, or address"
          aria-label="Search tokens by name, ticker, or address"
          spellCheck={false}
        />
        {search && (
          <button
            type="button"
            className="sc-search-clear"
            aria-label="Clear search"
            onClick={() => {
              setSearch('');
              setSearchMsg(null);
            }}
          >
            ×
          </button>
        )}
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
        <div className="flex items-center gap-2">
          <NotificationBell wallet={address} />
          <div ref={menuRef} className="sc-wallet-wrap">
          <button
            type="button"
            className="sc-wallet connected"
            onClick={() => setMenuOpen((v) => !v)}
            title={address}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="sc-wallet-dot" aria-hidden="true" />
            {shortenAddress(address)}
          </button>
          {menuOpen && (
            <div className="sc-wallet-menu" role="menu">
              <button
                type="button"
                className="sc-wallet-menu-item"
                role="menuitem"
                onClick={copyAddress}
              >
                {copied ? 'Copied' : 'Copy address'}
              </button>
              <button
                type="button"
                className="sc-wallet-menu-item sc-wallet-menu-item-danger"
                role="menuitem"
                onClick={onDisconnect}
              >
                Disconnect
              </button>
            </div>
          )}
          </div>
        </div>
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
