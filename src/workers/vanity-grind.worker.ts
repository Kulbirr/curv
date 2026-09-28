/**
 * Web Worker entry for parallel vanity mint grinding.
 *
 * Bundled by Next.js via `new Worker(new URL('./vanity-grind.worker.ts',
 * import.meta.url))` in src/lib/vanity-mint.ts. Each worker grinds
 * independently with its own random seeds; the main thread terminates all
 * workers as soon as one reports a match.
 *
 * The found secret key is posted back to the main thread of the same page
 * only (structured clone, stays in browser memory) — never to any server.
 */

// Minimal worker-scope typing so this file typechecks without the
// "webworker" lib.
declare const self: {
  postMessage(message: unknown): void;
  onmessage: ((e: { data: { suffix: string } }) => void) | null;
};

import { grindVanityMint } from '../lib/vanity-mint';

self.onmessage = (e: { data: { suffix: string } }) => {
  const { suffix } = e.data;
  grindVanityMint({
    suffix,
    progressEvery: 5000,
    yieldEvery: 2000,
    onProgress: (p) => self.postMessage({ type: 'progress', attempts: p.attempts }),
  }).then(
    (res) => {
      self.postMessage({
        type: 'found',
        secretKey: Array.from(res.keypair.secretKey),
        attempts: res.attempts,
      });
    },
    (err: unknown) => {
      self.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    },
  );
};
