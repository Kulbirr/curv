/**
 * Server-only stub for the `rpc-websockets` package.
 *
 * Why this exists: @solana/web3.js does `require('rpc-websockets')` at
 * import time, and rpc-websockets@9 requires the ESM-only uuid@14, so
 * every serverless function that imports web3.js crashes with
 * ERR_REQUIRE_ESM before handling a single request.
 *
 * Curv is REST-only by design (see src/lib/solana.ts): it never opens a
 * websocket subscription, so the real client is never needed server-side.
 * next.config.ts aliases 'rpc-websockets' to this file for server builds
 * only; the browser bundle keeps the real package.
 */
export class Client {
  constructor() {
    throw new Error(
      '[curv] WebSocket subscriptions are disabled: this app is REST-only.',
    );
  }
}

export default { Client };
