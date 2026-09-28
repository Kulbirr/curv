import { describe, expect, it } from 'vitest';
import {
  DEVNET_USDC_MINT,
  MAINNET_USDC_MINT,
  SOL_MINT,
  getUsdcMint,
  isCrossNetworkKnownMint,
} from './quote-assets';

describe('quote assets', () => {
  it('serves the network-correct USDC mint', () => {
    expect(getUsdcMint('mainnet-beta')).toBe(MAINNET_USDC_MINT);
    expect(getUsdcMint('devnet')).toBe(DEVNET_USDC_MINT);
    expect(MAINNET_USDC_MINT).not.toBe(DEVNET_USDC_MINT);
  });

  it('flags a well-known mint of the other network', () => {
    // Mainnet deployment must reject devnet USDC and vice versa.
    expect(isCrossNetworkKnownMint(DEVNET_USDC_MINT, 'mainnet-beta')).toBe(true);
    expect(isCrossNetworkKnownMint(MAINNET_USDC_MINT, 'devnet')).toBe(true);
    // Same-network mints are fine.
    expect(isCrossNetworkKnownMint(MAINNET_USDC_MINT, 'mainnet-beta')).toBe(false);
    expect(isCrossNetworkKnownMint(DEVNET_USDC_MINT, 'devnet')).toBe(false);
    // Unknown mints are not our business here (chain validation decides).
    expect(isCrossNetworkKnownMint(SOL_MINT, 'devnet')).toBe(false);
    expect(isCrossNetworkKnownMint('SomeRandomMint111111111111111111111111111', 'devnet')).toBe(
      false,
    );
  });
});
