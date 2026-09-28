import type { SolanaNetwork } from './solana';

/**
 * Network-aware quote asset constants.
 *
 * The launch UI used to hardcode the MAINNET USDC mint for every network,
 * which meant devnet users were offered a mainnet asset as a quote token.
 * Every quote-mint choice must go through these helpers so a mainnet asset
 * can never be presented as a valid devnet quote (or vice versa).
 */

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Circle USDC on Solana mainnet-beta. */
export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Circle USDC on devnet. */
export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** The USDC mint that is valid on the given network. */
export function getUsdcMint(network: SolanaNetwork): string {
  return network === 'mainnet-beta' ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;
}

/**
 * True when `mint` is a well-known asset of a DIFFERENT network than the
 * one we run on. Used as defense-in-depth in registration validation:
 * a cross-network quote mint is rejected even if the UI let it through.
 */
export function isCrossNetworkKnownMint(mint: string, network: SolanaNetwork): boolean {
  if (network === 'mainnet-beta') {
    return mint === DEVNET_USDC_MINT;
  }
  return mint === MAINNET_USDC_MINT;
}
