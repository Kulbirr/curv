import { describe, expect, it, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  DEVNET_USDC_MINT,
  MAINNET_USDC_MINT,
  SOL_MINT,
  getUsdcMint,
  inspectQuoteMint,
  isCrossNetworkKnownMint,
} from './quote-assets';

function mockConnection(owner: PublicKey | null) {
  return {
    getAccountInfo: vi.fn().mockResolvedValue(
      owner ? { owner, data: Buffer.alloc(0) } : null,
    ),
  } as unknown as Connection;
}

describe('quote assets', () => {
  it('serves the network-correct USDC mint', async () => {
    expect(getUsdcMint('mainnet-beta')).toBe(MAINNET_USDC_MINT);
    expect(getUsdcMint('devnet')).toBe(DEVNET_USDC_MINT);
    expect(MAINNET_USDC_MINT).not.toBe(DEVNET_USDC_MINT);
  });

  it('flags a well-known mint of the other network', async () => {
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

  it('detects the wSOL pseudo-mint without an RPC call', async () => {
    const conn = mockConnection(null);
    expect(await inspectQuoteMint(conn, SOL_MINT)).toEqual({ kind: 'native' });
    expect(conn.getAccountInfo).not.toHaveBeenCalled();
  });

  it('detects a classic SPL mint by account owner', async () => {
    const conn = mockConnection(TOKEN_PROGRAM_ID);
    expect(await inspectQuoteMint(conn, MAINNET_USDC_MINT)).toEqual({ kind: 'spl' });
  });

  it('returns unknown for malformed mints and missing accounts', async () => {
    const conn = mockConnection(null);
    expect(await inspectQuoteMint(conn, 'not-a-mint')).toEqual({ kind: 'unknown' });
    expect(await inspectQuoteMint(conn, MAINNET_USDC_MINT)).toEqual({ kind: 'unknown' });
  });

  it('returns unknown when the mint owner is neither token program', async () => {
    const conn = mockConnection(new PublicKey('11111111111111111111111111111111'));
    expect(await inspectQuoteMint(conn, MAINNET_USDC_MINT)).toEqual({ kind: 'unknown' });
  });

  it('flags a Token-2022 mint whose extensions cannot be read', async () => {
    // getMint fails (e.g. RPC hiccup): the hook question stays unanswered.
    const conn = mockConnection(TOKEN_2022_PROGRAM_ID);
    const res = await inspectQuoteMint(conn, MAINNET_USDC_MINT);
    expect(res).toEqual({
      kind: 'token-2022',
      transferHook: null,
      hookCheckFailed: true,
    });
  });
});
