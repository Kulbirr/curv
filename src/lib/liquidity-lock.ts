import { PublicKey, type Connection } from '@solana/web3.js';

/**
 * Liquidity-lock verification for graduated Curv pools.
 *
 * When a bonding-curve pool graduates, 100% of its liquidity migrates to a
 * Meteora DAMM v2 pool split across two positions (50% partner/Curv, 50%
 * creator) that are PERMANENTLY locked via the cp-amm program's
 * `permanent_lock_position`: nobody can ever withdraw the underlying
 * liquidity, while fees stay claimable. Naive rug checkers only look for
 * "LP burned: yes/no", so this module reads the real lock state from the
 * chain and reports it honestly.
 *
 * Byte offsets below come from the cp-amm program's Position and Pool
 * account layouts (verified against the damm-v2 program source):
 *   Position: pool @8, unlockedLiquidity @152, vestedLiquidity @168,
 *             permanentLockedLiquidity @184 (all little-endian u128)
 *   Pool:     tokenAMint @168, tokenBMint @200
 */

/** Meteora DAMM v2 (cp-amm) program id, identical on mainnet and devnet. */
export const CP_AMM_PROGRAM_ID = new PublicKey(
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'
);

/** Anchor discriminator of the cp-amm Position account. */
export const POSITION_DISCRIMINATOR = Buffer.from([
  170, 188, 143, 228, 122, 64, 247, 208,
]);

export const OFF_POSITION_POOL = 8;
export const OFF_POSITION_NFT_MINT = 40;
export const OFF_POSITION_UNLOCKED_LIQUIDITY = 152;
export const OFF_POSITION_VESTED_LIQUIDITY = 168;
export const OFF_POSITION_PERMANENT_LOCKED_LIQUIDITY = 184;
export const POSITION_MIN_DATA_LEN = 200;

export const OFF_POOL_TOKEN_A_MINT = 168;
export const OFF_POOL_TOKEN_B_MINT = 200;
export const POOL_MIN_DATA_LEN = 232;

export type PositionRole = 'curv' | 'creator' | 'unknown';

export interface DecodedPosition {
  address: string;
  nftMint: string;
  pool: string;
  hasUnlockedLiquidity: boolean;
  hasVestingLiquidity: boolean;
  hasPermanentLockedLiquidity: boolean;
}

export interface LockPositionInfo {
  address: string;
  /** Wallet holding the position NFT, null when it could not be resolved. */
  owner: string | null;
  role: PositionRole;
  permanentlyLocked: boolean;
}

export interface LiquidityLockResult {
  graduatedPool: string;
  positions: LockPositionInfo[];
  allLocked: boolean;
}

/**
 * True when the 16 bytes at offset are all zero (a u128 equal to 0).
 * The lock check only needs zero vs nonzero, so no bigint math is needed.
 */
export function u128IsZero(data: Uint8Array, offset: number): boolean {
  for (let i = 0; i < 16; i++) {
    if (data[offset + i] !== 0) return false;
  }
  return true;
}

/**
 * Decode a cp-amm Position account. Returns null when the data is too
 * short or the discriminator does not match (not a Position account).
 */
export function decodePosition(
  address: string,
  data: Uint8Array
): DecodedPosition | null {
  if (data.length < POSITION_MIN_DATA_LEN) return null;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== POSITION_DISCRIMINATOR[i]) return null;
  }
  const pubkeyAt = (offset: number) =>
    new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  return {
    address,
    pool: pubkeyAt(OFF_POSITION_POOL),
    nftMint: pubkeyAt(OFF_POSITION_NFT_MINT),
    hasUnlockedLiquidity: !u128IsZero(data, OFF_POSITION_UNLOCKED_LIQUIDITY),
    hasVestingLiquidity: !u128IsZero(data, OFF_POSITION_VESTED_LIQUIDITY),
    hasPermanentLockedLiquidity: !u128IsZero(
      data,
      OFF_POSITION_PERMANENT_LOCKED_LIQUIDITY
    ),
  };
}

/**
 * A position counts as permanently locked when it holds locked liquidity
 * and nothing remains withdrawable (no unlocked, no vesting liquidity).
 */
export function isPositionPermanentlyLocked(p: DecodedPosition): boolean {
  return (
    p.hasPermanentLockedLiquidity &&
    !p.hasUnlockedLiquidity &&
    !p.hasVestingLiquidity
  );
}

/**
 * True when a raw cp-amm Pool account holds exactly the given mint pair
 * (in either order).
 */
export function poolMatchesMints(
  data: Uint8Array,
  baseMint: string,
  quoteMint: string
): boolean {
  if (data.length < POOL_MIN_DATA_LEN) return false;
  const mintAt = (offset: number) =>
    new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  const tokenA = mintAt(OFF_POOL_TOKEN_A_MINT);
  const tokenB = mintAt(OFF_POOL_TOKEN_B_MINT);
  return (
    (tokenA === baseMint && tokenB === quoteMint) ||
    (tokenA === quoteMint && tokenB === baseMint)
  );
}

/**
 * Find the DAMM v2 pool for a mint pair by scanning cp-amm Pool accounts.
 * Pure PDA derivation is not used: the derivation helper in the installed
 * DBC SDK version does not reproduce pool addresses created by the
 * on-chain migration, so the scan is the source of truth.
 */
export async function scanDammV2Pool(
  connection: Connection,
  baseMint: string,
  quoteMint: string
): Promise<string | null> {
  const seen = new Map<string, Uint8Array>();
  for (const offset of [OFF_POOL_TOKEN_A_MINT, OFF_POOL_TOKEN_B_MINT]) {
    const accounts = await connection.getProgramAccounts(CP_AMM_PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset, bytes: baseMint } }],
    });
    for (const { pubkey, account } of accounts) {
      seen.set(pubkey.toBase58(), account.data);
    }
  }
  for (const [address, data] of seen) {
    if (poolMatchesMints(data, baseMint, quoteMint)) return address;
  }
  return null;
}

/** All cp-amm Position accounts belonging to one DAMM v2 pool. */
export async function fetchPoolPositions(
  connection: Connection,
  dammV2Pool: string
): Promise<DecodedPosition[]> {
  const accounts = await connection.getProgramAccounts(CP_AMM_PROGRAM_ID, {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: OFF_POSITION_POOL, bytes: dammV2Pool } }],
  });
  const out: DecodedPosition[] = [];
  for (const { pubkey, account } of accounts) {
    const decoded = decodePosition(pubkey.toBase58(), account.data);
    if (decoded) out.push(decoded);
  }
  return out;
}

/**
 * Resolve the wallet holding a position NFT (supply is 1, so the largest
 * token account is the owner). Null when it cannot be resolved.
 */
export async function resolvePositionOwner(
  connection: Connection,
  nftMint: string
): Promise<string | null> {
  try {
    const largest = await connection.getTokenLargestAccounts(
      new PublicKey(nftMint)
    );
    const holder = largest.value[0]?.address;
    if (!holder) return null;
    const info = await connection.getParsedAccountInfo(holder);
    const data = info.value?.data as
      | { parsed?: { info?: { owner?: string } } }
      | undefined;
    const owner = data?.parsed?.info?.owner;
    return typeof owner === 'string' && owner.length > 0 ? owner : null;
  } catch {
    return null;
  }
}

export function assignPositionRole(
  owner: string | null,
  creator: string,
  partnerWallet: string | null
): PositionRole {
  if (owner && owner === creator) return 'creator';
  if (owner && partnerWallet && owner === partnerWallet) return 'curv';
  return 'unknown';
}

/**
 * Full verification for one graduated pool: find the DAMM v2 pool, read
 * its positions, resolve owners, and report the lock state. Throws on
 * RPC failure so the caller can distinguish "chain unreachable" from
 * "pool not found".
 */
export async function verifyLiquidityLock(
  connection: Connection,
  baseMint: string,
  quoteMint: string,
  creator: string,
  partnerWallet: string | null
): Promise<LiquidityLockResult | null> {
  const graduatedPool = await scanDammV2Pool(connection, baseMint, quoteMint);
  if (!graduatedPool) return null;
  const decoded = await fetchPoolPositions(connection, graduatedPool);
  const positions: LockPositionInfo[] = [];
  for (const p of decoded) {
    const owner = await resolvePositionOwner(connection, p.nftMint);
    positions.push({
      address: p.address,
      owner,
      role: assignPositionRole(owner, creator, partnerWallet),
      permanentlyLocked: isPositionPermanentlyLocked(p),
    });
  }
  return {
    graduatedPool,
    positions,
    allLocked: positions.length > 0 && positions.every((p) => p.permanentlyLocked),
  };
}

export type LockViewStatus =
  | 'loading'
  | 'locked'
  | 'unlocked'
  | 'unverified'
  | 'error';

export interface LockViewPosition {
  address: string;
  roleLabel: string;
  locked: boolean;
}

export interface LockViewModel {
  status: LockViewStatus;
  heading: string;
  body: string;
  poolAddress: string | null;
  positions: LockViewPosition[];
}

const ROLE_LABELS: Record<PositionRole, string> = {
  curv: 'Curv position',
  creator: 'Creator position',
  unknown: 'Position',
};

/**
 * Maps an API result (or failure) to exactly what the UI shows. All
 * user-facing copy lives here so the locked/unlocked/loading/error
 * branches are unit-testable without a browser harness.
 */
export function getLockViewModel(
  result: LiquidityLockResult | null,
  failed: boolean
): LockViewModel {
  if (failed) {
    return {
      status: 'error',
      heading: 'Lock check failed',
      body: 'We could not reach the chain to verify the lock. Nothing on this page is affected.',
      poolAddress: null,
      positions: [],
    };
  }
  if (result === null) {
    return {
      status: 'unverified',
      heading: 'Lock status unavailable',
      body: 'We could not find this pool on Meteora yet. Try again in a bit.',
      poolAddress: null,
      positions: [],
    };
  }
  const positions: LockViewPosition[] = result.positions.map((p) => ({
    address: p.address,
    roleLabel: ROLE_LABELS[p.role],
    locked: p.permanentlyLocked,
  }));
  if (result.allLocked) {
    return {
      status: 'locked',
      heading: 'Liquidity is locked forever',
      body: 'No one can remove it, not even us. Verified on chain.',
      poolAddress: result.graduatedPool,
      positions,
    };
  }
  return {
    status: 'unlocked',
    heading: 'Liquidity is not fully locked',
    body: 'Some liquidity in this pool can still be withdrawn. Check the positions below.',
    poolAddress: result.graduatedPool,
    positions,
  };
}
