# Curv

**Every token launch gets its own designer bonding curve.**

Curv is a launchpad built on Meteora's Dynamic Bonding Curve. Where pump.fun gives every launch the same fixed curve, Curv lets each creator design theirs: the shape of the price curve, the fee schedule that decays from launch, and the graduation design that carries the pool onto the open market.

## Why designer curves

The bonding curve is the product. A fixed curve treats a memecoin, a game token and a community treasury the same way. Curv treats the curve as a design surface: pick a preset or draw your own, set how fees start high to deter sniper bots then decay, and choose when the pool graduates to a real market.

## Meteora DBC integration

Curv builds on the DBC SDK at depth, not as a thin wrapper:

* Custom sqrt price curves derived from the visual designer, with per segment liquidity weights
* Exponential fee scheduler with creator set start and end fees, decay periods and duration
* Dynamic fees on the bonding curve and on the post graduation DAMM v2 pool
* Creator trading fee of 0.3 percent on every bonding curve trade, claimed with a wallet signed transaction
* Migration to DAMM v2 at a graduation threshold computed by the SDK's own math from the curve
* Graduation target matching: name the threshold you want and the curve rescales to hit it
* Configurable migration fee and post graduation pool fee
* Quote pairs in SOL, USDC or any SPL mint

## Liquidity lock

Curv does not burn graduated liquidity. It locks it forever.

When a pool graduates, all of its liquidity migrates into a Meteora DAMM v2 pool inside two permanently locked positions: 80 percent owned by the creator, 20 percent by Curv. The lock is enforced by the Meteora program itself, so neither side can ever withdraw the underlying liquidity. Both sides keep only the right to claim trading fees, which accrue to the locked positions.

This reads as "LP not burned" to naive rug checkers, so the pool page verifies the lock on chain and links straight to the DAMM v2 pool and both position accounts. Anyone can confirm the lock without trusting us.

## Creator economics

* 0.3 percent of every bonding curve trade goes to the creator, matching pump.fun
* At graduation, a 4 percent migration fee is taken from the migrating liquidity: 2 percent to Curv and 2 percent to the creator
* Pool creation costs 0.02 SOL, matching pump.fun. Meteora takes 10 percent of it and Curv receives the rest
* Every figure on the launch page is computed from the same constants that build the on chain config. Nothing is estimated or mocked

## Launch flow

1. Design the curve, set the economics, upload art and metadata. No wallet needed
2. Claim an instant ...curv vanity mint from the warm pool, or grind one in the browser while you design. A random mint is the final fallback
3. Review the full fee disclosure, then connect a wallet. Launch takes exactly two signatures
4. Trade on the pool page with live price updates, quick buy and sell presets, and a price chart drawn from real indexed samples with gaps preserved
5. At the graduation threshold the pool migrates to DAMM v2 automatically

## Verified on devnet

The full path runs against devnet through the real app code: launch, pool registration, two buys, one sell, indexer pickup, API serving.

* Pool: `AcdyunXSN1dLgS8tPCRPLTauZxmi84mLLQvi2xhKQoP4`
* Launch tx: `3GYcTgkUCxTWXHCJEkyx46oeADDQM3PmUqcVpudK6FpVDudpH11SNGWdTcMsNTXDLUfakWvXLmhnePAXqfpGBhmB`
* Total spend for the whole run: under 0.03 SOL

## Stack

Next.js and TypeScript, `@meteora-ag/dynamic-bonding-curve-sdk`, SQLite registry with a REST API, Solana RPC REST polling, 504 automated tests.

## Run it

```bash
npm install
npm run dev
```

The app targets devnet by default. Set `SOLANA_RPC_URL` to your own endpoint for heavier use. Copy `.env.example` to `.env` for object storage and RPC keys.

Key scripts: `npm test`, `npm run typecheck`, `npm run indexer`, `npm run grind` (vanity mint warm pool; needs `VANITY_POOL_KEY`).

## Project layout

* `src/pages` — the five pages: Discover, Launch, Pool, Presets, Portfolio
* `src/lib/launch.ts` — designer spec to DBC SDK params, validation, graduation math
* `src/lib/launch-fees.ts` — canonical economics constants and the fee disclosure
* `src/lib/vanity-*` — ...curv mint grinding, encrypted warm pool, atomic claims
* `src/pages/api` — pool registry, vanity mint handout, strictly validated APIs
* `scripts/` — indexer, grinder, seed

## Status

Devnet verified end to end. In progress: hosted staging, production RPC and load testing, then mainnet.

Built for the Meteora DBC bounty on Superteam Earn.
