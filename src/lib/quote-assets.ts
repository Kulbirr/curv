import type { SolanaNetwork } from './solana';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getMint,
  getTransferHook,
} from '@solana/spl-token';

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

/**
 * What the chain says about a prospective quote mint.
 *
 * The DBC SDK auto-detects the quote mint's token program at pool-creation
 * and swap time, so plain Token-2022 quotes work. Transfer-hook mints do
 * not: they need a separate SDK path (`createConfigAndPoolWithTransferHook`)
 * that Curv has not wired up. `unknown` means the mint does not exist on
 * this network or the RPC call failed; it is not an error by itself because
 * the directory lists mainnet assets while the app may run on devnet.
 */
export type QuoteMintProgram =
  | { kind: 'native' }
  | { kind: 'spl' }
  | { kind: 'token-2022'; transferHook: string | null; hookCheckFailed: boolean }
  | { kind: 'unknown' };

export async function inspectQuoteMint(
  connection: Connection,
  mint: string,
): Promise<QuoteMintProgram> {
  let mintPk: PublicKey;
  try {
    mintPk = new PublicKey(mint);
  } catch {
    return { kind: 'unknown' };
  }
  if (mintPk.equals(new PublicKey(SOL_MINT))) return { kind: 'native' };
  const info = await connection.getAccountInfo(mintPk).catch((): null => null);
  if (!info) return { kind: 'unknown' };
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return { kind: 'spl' };
  if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) return { kind: 'unknown' };
  try {
    const mintData = await getMint(connection, mintPk, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const hook = getTransferHook(mintData);
    return {
      kind: 'token-2022',
      transferHook: hook ? hook.programId.toBase58() : null,
      hookCheckFailed: false,
    };
  } catch {
    // The mint is Token-2022 but its extensions could not be read; callers
    // must treat the transfer-hook question as unanswered, not as "none".
    return { kind: 'token-2022', transferHook: null, hookCheckFailed: true };
  }
}
