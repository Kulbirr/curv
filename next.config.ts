import type { NextConfig } from 'next';

/**
 * Content Security Policy, scoped to what Curv actually uses.
 *
 * Browser-side network inventory (why each entry exists):
 * - connect-src 'self': same-origin /api/* (RPC proxy, state, history, metadata)
 * - wss://push.curvpad.fun: Oracle price-state pushes (usePoolStatePush)
 * - wss://relay.walletconnect.com: WalletConnect relay (MetaMask path)
 * - wss://*.jup.ag: Jupiter streams (DataStreamProvider / future use)
 * - https://*.jup.ag: Jupiter HTTPS APIs (lite-api swap quotes, price API)
 *   plus https://plugin.jup.ag in script-src for the Jupiter plugin bundle
 *   loaded in _document.tsx
 * - https://api.devnet.solana.com, https://api.mainnet-beta.solana.com:
 *   public RPC fallback when the server lane fails (fetchWithFallback)
 * - https://*.helius-rpc.com: keyed RPC lane if ever called browser-side
 * - img-src https://*.r2.dev: token images served from the R2 public bucket;
 *   data:/blob: for upload previews and inline SVG icons
 * - font-src 'self': @fontsource self-hosted fonts (no Google Fonts)
 *
 * script-src keeps 'unsafe-inline' deliberately: Next.js Pages Router needs
 * inline bootstrap scripts, and Solana wallet adapters (Phantom/MWA/
 * WalletConnect) inject provider scripts into the page. A nonce-based
 * script-src is future work and must be validated against every wallet
 * adapter before shipping. The other directives still constrain
 * exfiltration (connect-src), framing (frame-ancestors/frame-src) and
 * plugin/base-tag attacks even with permissive script-src.
 */
function contentSecurityPolicy(): string {
  const connect = [
    "'self'",
    'wss://push.curvpad.fun',
    'wss://relay.walletconnect.com',
    'wss://*.jup.ag',
    'https://*.jup.ag',
    'https://plugin.jup.ag',
    'https://api.devnet.solana.com',
    'https://api.mainnet-beta.solana.com',
    'https://*.helius-rpc.com',
  ].join(' ');
  const img = ["'self'", 'data:', 'blob:', 'https://*.r2.dev'].join(' ');
  return [
    "default-src 'self'",
    // See the comment above: 'unsafe-inline' is intentional for now.
    "script-src 'self' 'unsafe-inline' https://plugin.jup.ag",
    // React inline styles are applied via the style attribute everywhere.
    "style-src 'self' 'unsafe-inline'",
    `img-src ${img}`,
    `connect-src ${connect}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
    "frame-src 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
];

/**
 * The chart widget under /embed is meant to be framed by other sites.
 * Only its CSP changes: frame-ancestors opens to any origin. Modern
 * browsers let frame-ancestors govern framing where both it and
 * X-Frame-Options are present, so the rest of the site stays locked.
 */
const embedSecurityHeaders = securityHeaders.map((h) =>
  h.key === 'Content-Security-Policy'
    ? { ...h, value: h.value.replace("frame-ancestors 'self'", 'frame-ancestors *') }
    : h,
);

const nextConfig: NextConfig = {
  /* config options here */
  reactStrictMode: true,
  async headers() {
    return [
      {
        // Security headers on every page and API route.
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // Later entries win per header key: the widget page gets the
        // embed CSP (frameable) while keeping every other header.
        source: '/embed/:path*',
        headers: embedSecurityHeaders,
      },
    ];
  },
  eslint: {
    // Build fails on ESLint errors. Warnings (e.g. no-img-element for
    // external R2 token logos) are allowed.
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
