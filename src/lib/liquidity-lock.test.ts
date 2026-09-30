import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import {
  OFF_POOL_TOKEN_A_MINT,
  OFF_POOL_TOKEN_B_MINT,
  OFF_POSITION_PERMANENT_LOCKED_LIQUIDITY,
  OFF_POSITION_UNLOCKED_LIQUIDITY,
  OFF_POSITION_VESTED_LIQUIDITY,
  POSITION_DISCRIMINATOR,
  assignPositionRole,
  decodePosition,
  getLockViewModel,
  isPositionPermanentlyLocked,
  poolMatchesMints,
  scanDammV2Pool,
  u128IsZero,
  verifyLiquidityLock,
  type DecodedPosition,
  type LiquidityLockResult,
} from './liquidity-lock';

/**
 * Devnet graduation proof fixtures (verified on-chain 2026-09-30, used
 * here only as well-formed inputs for the scan/match logic):
 * DBC pool HGGtnXhcPgX8LdyKuiY4BT7K87XubgzZPzktGF6KttRT graduated to
 * DAMM v2 pool 9Rt6KW2SY3c431mvMYAur9HnXdRiofzosLrQWGBc4qA5.
 *
 * Note: the pure-PDA helper deriveDammV2PoolAddress from the installed
 * DBC SDK does NOT reproduce that pool address (it derives
 * JAqsAAyCb7XjYhxuZy5CbBhf359XEqUXJzAcxKRqJ3S2 for the proof config and
 * mints), so the API finds the DAMM v2 pool by scanning cp-amm Pool
 * accounts for the mint pair instead of deriving it.
 */
const PROOF_BASE_MINT = 'BZGKUxxj9apfnytAfihucw5cSXrhR1T5dPvF8BePb4dF';
const PROOF_QUOTE_MINT = 'ExDuXdVxERLuA9PnTP4h8WE7BcxhdSakupi4dk6d7H8M';
const PROOF_DAMM_V2_POOL = '9Rt6KW2SY3c431mvMYAur9HnXdRiofzosLrQWGBc4qA5';
const PROOF_CREATOR_POSITION = '4yf9Y2Yjj9kuDsMvrHNKLYnkYd7H9t1bD6SCRS7Cw17u';
const PROOF_PARTNER_POSITION = 'CgYrHSPr2RhkN7JJMqtfRhcEfMyJ5bhLyqbdAn6mXUjt';

/** Synthetic cp-amm Position account with chosen liquidity buckets. */
function makePositionBuffer(opts: {
  pool: PublicKey;
  nftMint: PublicKey;
  unlocked?: boolean;
  vested?: boolean;
  permanentLocked?: boolean;
  badDiscriminator?: boolean;
}): Buffer {
  const buf = Buffer.alloc(240);
  if (opts.badDiscriminator) {
    buf.fill(9, 0, 8);
  } else {
    Buffer.from(POSITION_DISCRIMINATOR).copy(buf, 0);
  }
  opts.pool.toBuffer().copy(buf, 8);
  opts.nftMint.toBuffer().copy(buf, 40);
  // Nonzero bytes placed at different ends of each 16-byte window, so a
  // test that reads the wrong window would fail.
  if (opts.unlocked) buf[OFF_POSITION_UNLOCKED_LIQUIDITY + 15] = 1;
  if (opts.vested) buf[OFF_POSITION_VESTED_LIQUIDITY] = 1;
  if (opts.permanentLocked) buf[OFF_POSITION_PERMANENT_LOCKED_LIQUIDITY + 7] = 1;
  return buf;
}

/** Synthetic cp-amm Pool account holding the given mint pair. */
function makePoolBuffer(tokenA: PublicKey, tokenB: PublicKey): Buffer {
  const buf = Buffer.alloc(400);
  tokenA.toBuffer().copy(buf, OFF_POOL_TOKEN_A_MINT);
  tokenB.toBuffer().copy(buf, OFF_POOL_TOKEN_B_MINT);
  return buf;
}

describe('u128IsZero', () => {
  it('detects zero vs nonzero 16-byte windows', () => {
    const buf = Buffer.alloc(32);
    expect(u128IsZero(buf, 0)).toBe(true);
    expect(u128IsZero(buf, 16)).toBe(true);
    buf[31] = 1;
    expect(u128IsZero(buf, 0)).toBe(true); // byte 31 sits outside window [0, 16)
    expect(u128IsZero(buf, 16)).toBe(false); // byte 31 sits inside window [16, 32)
    expect(u128IsZero(buf, 1)).toBe(true);
  });
});

describe('decodePosition', () => {
  it('decodes a fully locked position', () => {
    const pool = Keypair.generate().publicKey;
    const nft = Keypair.generate().publicKey;
    const decoded = decodePosition(
      'addr1',
      makePositionBuffer({ pool, nftMint: nft, permanentLocked: true })
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.address).toBe('addr1');
    expect(decoded!.pool).toBe(pool.toBase58());
    expect(decoded!.nftMint).toBe(nft.toBase58());
    expect(decoded!.hasUnlockedLiquidity).toBe(false);
    expect(decoded!.hasVestingLiquidity).toBe(false);
    expect(decoded!.hasPermanentLockedLiquidity).toBe(true);
  });

  it('reads each liquidity bucket at its exact offset', () => {
    const pool = Keypair.generate().publicKey;
    const nft = Keypair.generate().publicKey;
    const buf = makePositionBuffer({ pool, nftMint: nft, permanentLocked: true });
    // A nonzero byte just outside a window must not leak into it.
    buf[OFF_POSITION_UNLOCKED_LIQUIDITY - 1] = 1;
    buf[OFF_POSITION_PERMANENT_LOCKED_LIQUIDITY + 16] = 1;
    const decoded = decodePosition('addr1', buf);
    expect(decoded!.hasUnlockedLiquidity).toBe(false);
    expect(decoded!.hasVestingLiquidity).toBe(false);
    expect(decoded!.hasPermanentLockedLiquidity).toBe(true);
  });

  it('rejects a wrong discriminator', () => {
    const decoded = decodePosition(
      'addr1',
      makePositionBuffer({
        pool: Keypair.generate().publicKey,
        nftMint: Keypair.generate().publicKey,
        badDiscriminator: true,
      })
    );
    expect(decoded).toBeNull();
  });

  it('rejects short data', () => {
    expect(decodePosition('addr1', Buffer.alloc(100))).toBeNull();
  });
});

describe('isPositionPermanentlyLocked', () => {
  const base: DecodedPosition = {
    address: 'a',
    pool: 'p',
    nftMint: 'n',
    hasUnlockedLiquidity: false,
    hasVestingLiquidity: false,
    hasPermanentLockedLiquidity: true,
  };
  it('is true when only permanent locked liquidity remains', () => {
    expect(isPositionPermanentlyLocked(base)).toBe(true);
  });
  it('is false when any unlocked liquidity remains', () => {
    expect(
      isPositionPermanentlyLocked({ ...base, hasUnlockedLiquidity: true })
    ).toBe(false);
  });
  it('is false when vesting liquidity remains', () => {
    expect(
      isPositionPermanentlyLocked({ ...base, hasVestingLiquidity: true })
    ).toBe(false);
  });
  it('is false when nothing is locked', () => {
    expect(
      isPositionPermanentlyLocked({
        ...base,
        hasPermanentLockedLiquidity: false,
      })
    ).toBe(false);
  });
});

describe('poolMatchesMints', () => {
  const base = new PublicKey(PROOF_BASE_MINT);
  const quote = new PublicKey(PROOF_QUOTE_MINT);

  it('matches the devnet proof mint pair in either order', () => {
    expect(
      poolMatchesMints(
        makePoolBuffer(base, quote),
        PROOF_BASE_MINT,
        PROOF_QUOTE_MINT
      )
    ).toBe(true);
    expect(
      poolMatchesMints(
        makePoolBuffer(quote, base),
        PROOF_BASE_MINT,
        PROOF_QUOTE_MINT
      )
    ).toBe(true);
  });

  it('rejects a different mint pair', () => {
    const other = Keypair.generate().publicKey;
    expect(
      poolMatchesMints(
        makePoolBuffer(base, other),
        PROOF_BASE_MINT,
        PROOF_QUOTE_MINT
      )
    ).toBe(false);
  });

  it('rejects short data', () => {
    expect(poolMatchesMints(Buffer.alloc(100), PROOF_BASE_MINT, PROOF_QUOTE_MINT)).toBe(
      false
    );
  });
});

describe('assignPositionRole', () => {
  const creator = Keypair.generate().publicKey.toBase58();
  const partner = Keypair.generate().publicKey.toBase58();

  it('identifies the creator position', () => {
    expect(assignPositionRole(creator, creator, partner)).toBe('creator');
  });
  it('identifies the Curv position', () => {
    expect(assignPositionRole(partner, creator, partner)).toBe('curv');
  });
  it('marks strangers and unknowns honestly', () => {
    expect(
      assignPositionRole(Keypair.generate().publicKey.toBase58(), creator, partner)
    ).toBe('unknown');
    expect(assignPositionRole(null, creator, partner)).toBe('unknown');
    expect(assignPositionRole(partner, creator, null)).toBe('unknown');
  });
});

describe('getLockViewModel', () => {
  const lockedResult: LiquidityLockResult = {
    graduatedPool: PROOF_DAMM_V2_POOL,
    positions: [
      {
        address: PROOF_PARTNER_POSITION,
        owner: 'owner1',
        role: 'curv',
        permanentlyLocked: true,
      },
      {
        address: PROOF_CREATOR_POSITION,
        owner: 'owner2',
        role: 'creator',
        permanentlyLocked: true,
      },
    ],
    allLocked: true,
  };

  it('shows the locked state with green copy', () => {
    const vm = getLockViewModel(lockedResult, false);
    expect(vm.status).toBe('locked');
    expect(vm.heading).toBe('Liquidity is locked forever');
    expect(vm.poolAddress).toBe(PROOF_DAMM_V2_POOL);
    expect(vm.positions).toHaveLength(2);
    expect(vm.positions[0].roleLabel).toBe('Curv position');
    expect(vm.positions[1].roleLabel).toBe('Creator position');
    expect(vm.positions.every((p) => p.locked)).toBe(true);
  });

  it('shows the unlocked state when a position is not locked', () => {
    const vm = getLockViewModel(
      {
        ...lockedResult,
        allLocked: false,
        positions: [{ ...lockedResult.positions[0], permanentlyLocked: false }],
      },
      false
    );
    expect(vm.status).toBe('unlocked');
    expect(vm.positions[0].locked).toBe(false);
  });

  it('shows unverified when the pool was not found', () => {
    const vm = getLockViewModel(null, false);
    expect(vm.status).toBe('unverified');
    expect(vm.poolAddress).toBeNull();
    expect(vm.positions).toHaveLength(0);
  });

  it('shows the error state on RPC failure', () => {
    const vm = getLockViewModel(null, true);
    expect(vm.status).toBe('error');
    expect(vm.positions).toHaveLength(0);
  });

  it('uses no dash characters in any user-facing copy', () => {
    const models = [
      getLockViewModel(lockedResult, false),
      getLockViewModel({ ...lockedResult, allLocked: false }, false),
      getLockViewModel(null, false),
      getLockViewModel(null, true),
    ];
    for (const vm of models) {
      for (const text of [vm.heading, vm.body]) {
        expect(text).not.toMatch(/[-–—]/);
      }
    }
  });
});

describe('scanDammV2Pool', () => {
  it('finds the pool holding the proof mint pair', async () => {
    const poolKey = new PublicKey(PROOF_DAMM_V2_POOL);
    const data = makePoolBuffer(
      new PublicKey(PROOF_BASE_MINT),
      new PublicKey(PROOF_QUOTE_MINT)
    );
    const mock = {
      getProgramAccounts: async (): Promise<
        Array<{ pubkey: PublicKey; account: { data: Buffer } }>
      > => [{ pubkey: poolKey, account: { data } }],
    } as unknown as Connection;
    const found = await scanDammV2Pool(mock, PROOF_BASE_MINT, PROOF_QUOTE_MINT);
    expect(found).toBe(PROOF_DAMM_V2_POOL);
  });

  it('returns null when nothing matches', async () => {
    const mock = {
      getProgramAccounts: async (): Promise<never[]> => [],
    } as unknown as Connection;
    const found = await scanDammV2Pool(mock, PROOF_BASE_MINT, PROOF_QUOTE_MINT);
    expect(found).toBeNull();
  });
});

describe('verifyLiquidityLock', () => {
  it('verifies both proof positions as locked with correct roles', async () => {
    const poolKey = new PublicKey(PROOF_DAMM_V2_POOL);
    const poolData = makePoolBuffer(
      new PublicKey(PROOF_BASE_MINT),
      new PublicKey(PROOF_QUOTE_MINT)
    );
    const creator = Keypair.generate().publicKey;
    const partner = Keypair.generate().publicKey;
    const creatorNft = Keypair.generate().publicKey;
    const partnerNft = Keypair.generate().publicKey;
    const creatorPosKey = new PublicKey(PROOF_CREATOR_POSITION);
    const partnerPosKey = new PublicKey(PROOF_PARTNER_POSITION);
    const creatorPosData = makePositionBuffer({
      pool: poolKey,
      nftMint: creatorNft,
      permanentLocked: true,
    });
    const partnerPosData = makePositionBuffer({
      pool: poolKey,
      nftMint: partnerNft,
      permanentLocked: true,
    });
    const creatorTokenAccount = Keypair.generate().publicKey;
    const partnerTokenAccount = Keypair.generate().publicKey;

    const mock = {
      getProgramAccounts: async (
        _program: PublicKey,
        config?: { filters?: Array<{ memcmp?: { offset?: number } }> }
      ): Promise<Array<{ pubkey: PublicKey; account: { data: Buffer } }>> => {
        const offset = config?.filters?.[0]?.memcmp?.offset;
        // Pool scan hits the mint offsets; position scan hits offset 8.
        if (offset === 168 || offset === 200) {
          return [{ pubkey: poolKey, account: { data: poolData } }];
        }
        return [
          { pubkey: creatorPosKey, account: { data: creatorPosData } },
          { pubkey: partnerPosKey, account: { data: partnerPosData } },
        ];
      },
      getTokenLargestAccounts: async (
        mint: PublicKey
      ): Promise<{ value: Array<{ address: PublicKey }> }> => ({
        value: [
          {
            address: mint.equals(creatorNft)
              ? creatorTokenAccount
              : partnerTokenAccount,
          },
        ],
      }),
      getParsedAccountInfo: async (
        address: PublicKey
      ): Promise<{
        value: { data: { parsed: { info: { owner: string } } } } | null;
      }> => ({
        value: {
          data: {
            parsed: {
              info: {
                owner: address.equals(creatorTokenAccount)
                  ? creator.toBase58()
                  : partner.toBase58(),
              },
            },
          },
        },
      }),
    } as unknown as Connection;

    const result = await verifyLiquidityLock(
      mock,
      PROOF_BASE_MINT,
      PROOF_QUOTE_MINT,
      creator.toBase58(),
      partner.toBase58()
    );
    expect(result).not.toBeNull();
    expect(result!.graduatedPool).toBe(PROOF_DAMM_V2_POOL);
    expect(result!.allLocked).toBe(true);
    expect(result!.positions).toHaveLength(2);
    const byRole = Object.fromEntries(result!.positions.map((p) => [p.role, p]));
    expect(byRole.creator.address).toBe(PROOF_CREATOR_POSITION);
    expect(byRole.creator.permanentlyLocked).toBe(true);
    expect(byRole.curv.address).toBe(PROOF_PARTNER_POSITION);
    expect(byRole.curv.permanentlyLocked).toBe(true);
  });

  it('returns null when the DAMM v2 pool is not found', async () => {
    const mock = {
      getProgramAccounts: async (): Promise<never[]> => [],
    } as unknown as Connection;
    const result = await verifyLiquidityLock(
      mock,
      PROOF_BASE_MINT,
      PROOF_QUOTE_MINT,
      Keypair.generate().publicKey.toBase58(),
      null
    );
    expect(result).toBeNull();
  });

  it('reports allLocked false when a position still has unlocked liquidity', async () => {
    const poolKey = new PublicKey(PROOF_DAMM_V2_POOL);
    const poolData = makePoolBuffer(
      new PublicKey(PROOF_BASE_MINT),
      new PublicKey(PROOF_QUOTE_MINT)
    );
    const nft = Keypair.generate().publicKey;
    const posKey = Keypair.generate().publicKey;
    const posData = makePositionBuffer({
      pool: poolKey,
      nftMint: nft,
      unlocked: true,
      permanentLocked: true,
    });
    const mock = {
      getProgramAccounts: async (
        _program: PublicKey,
        config?: { filters?: Array<{ memcmp?: { offset?: number } }> }
      ): Promise<Array<{ pubkey: PublicKey; account: { data: Buffer } }>> => {
        const offset = config?.filters?.[0]?.memcmp?.offset;
        if (offset === 168 || offset === 200) {
          return [{ pubkey: poolKey, account: { data: poolData } }];
        }
        return [{ pubkey: posKey, account: { data: posData } }];
      },
      getTokenLargestAccounts: async (): Promise<{ value: never[] }> => ({
        value: [],
      }),
      getParsedAccountInfo: async (): Promise<{ value: null }> => ({
        value: null,
      }),
    } as unknown as Connection;
    const result = await verifyLiquidityLock(
      mock,
      PROOF_BASE_MINT,
      PROOF_QUOTE_MINT,
      Keypair.generate().publicKey.toBase58(),
      null
    );
    expect(result!.allLocked).toBe(false);
    expect(result!.positions[0].permanentlyLocked).toBe(false);
    expect(result!.positions[0].role).toBe('unknown');
  });
});
