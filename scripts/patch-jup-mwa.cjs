/**
 * Postinstall patches for @jup-ag/wallet-adapter.
 *
 * Patch 1 — MWA chain list. Jupiter's bundled WalletConnectionProvider
 * registers a Mobile Wallet Adapter wallet with a hardcoded mainnet-first
 * chain list:
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
 * Patch 2 — MWA dedupe. Jupiter's provider calls registerMwa() on every
 * render with no dedupe guard, and our AppProviders calls it once itself, so
 * the connect modal showed two identical "Mobile" tiles. This patch wraps
 * Jupiter's registerMwa() call so it is skipped when
 * window.__CURV_MWA_DONE__ is set; AppProviders sets that flag at module
 * scope, leaving exactly one MWA wallet: ours.
 *
 * Idempotent: safe to run on every install. Fails loudly (non-zero exit) if
 * the upstream bundle no longer contains the expected code, so a Jupiter
 * upgrade that changes this area breaks the install instead of silently
 * reintroducing a bug.
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

const patches = [
  {
    name: 'MWA chain list',
    needle: "chains: ['solana:mainnet', 'solana:devnet'],",
    replacement:
      "chains: (typeof window !== 'undefined' && window.__CURV_MWA_CHAINS__) || ['solana:mainnet', 'solana:devnet'],",
  },
  {
    name: 'MWA dedupe guard',
    needle: '  registerMwa({\n    appIdentity: {',
    replacement:
      "  if (typeof window === 'undefined' || !window.__CURV_MWA_DONE__) registerMwa({\n    appIdentity: {",
  },
];

function countOccurrences(src, needle) {
  let count = 0;
  let idx = -1;
  while ((idx = src.indexOf(needle, idx + 1)) !== -1) count++;
  return count;
}

try {
  let src = fs.readFileSync(target, 'utf8');
  let applied = 0;
  for (const patch of patches) {
    if (src.includes(patch.replacement)) {
      console.log(`[patch-jup-mwa] "${patch.name}" already applied, skipping`);
      continue;
    }
    const occurrences = countOccurrences(src, patch.needle);
    if (occurrences !== 1) {
      console.error(
        `[patch-jup-mwa] FAIL: "${patch.name}" needle found ${occurrences} times ` +
          '(expected exactly 1). Upstream probably changed this code — update scripts/patch-jup-mwa.cjs.'
      );
      process.exit(1);
    }
    src = src.replace(patch.needle, patch.replacement);
    applied++;
    console.log(`[patch-jup-mwa] applied "${patch.name}"`);
  }
  if (applied > 0) {
    fs.writeFileSync(target, src);
  }
  console.log('[patch-jup-mwa] done');
} catch (err) {
  console.error('[patch-jup-mwa] FAIL:', err.message);
  process.exit(1);
}
