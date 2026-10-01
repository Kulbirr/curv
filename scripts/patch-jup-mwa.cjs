/**
 * Postinstall patch for @jup-ag/wallet-adapter.
 *
 * Jupiter's bundled WalletConnectionProvider registers a Mobile Wallet
 * Adapter wallet with a hardcoded mainnet-first chain list:
 *   chains: ['solana:mainnet', 'solana:devnet']
 * Combined with @solana-mobile's default chain selector (which prefers
 * solana:mainnet whenever it is listed), Android wallet authorize requests
 * ask for mainnet — so Phantom in Testnet Mode rejects the connection with
 * "Incorrect mode" on our devnet deployment.
 *
 * This patch rewrites that chain list to honor window.__CURV_MWA_CHAINS__,
 * which src/components/AppProviders.tsx sets from SOLANA_NETWORK before any
 * provider renders. Falls back to the original list if the global is absent.
 *
 * Idempotent: safe to run on every install. Fails loudly (non-zero exit) if
 * the upstream bundle no longer contains the expected code, so a Jupiter
 * upgrade that changes this area breaks the install instead of silently
 * reintroducing the bug.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  '@jup-ag',
  'wallet-adapter',
  'dist',
  'components.esm.js'
);

const needle = "chains: ['solana:mainnet', 'solana:devnet'],";
const replacement =
  "chains: (typeof window !== 'undefined' && window.__CURV_MWA_CHAINS__) || ['solana:mainnet', 'solana:devnet'],";

try {
  const src = fs.readFileSync(target, 'utf8');
  if (src.includes(replacement)) {
    console.log('[patch-jup-mwa] already patched, nothing to do');
    process.exit(0);
  }
  if (!src.includes(needle)) {
    console.error(
      '[patch-jup-mwa] FAIL: expected chain list not found in @jup-ag/wallet-adapter bundle. ' +
        'Upstream probably changed this code — update scripts/patch-jup-mwa.cjs.'
    );
    process.exit(1);
  }
  fs.writeFileSync(target, src.replace(needle, replacement));
  console.log('[patch-jup-mwa] patched MWA chain list in @jup-ag/wallet-adapter');
} catch (err) {
  console.error('[patch-jup-mwa] FAIL:', err.message);
  process.exit(1);
}
