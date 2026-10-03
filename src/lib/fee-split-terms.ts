import { PublicKey } from '@solana/web3.js';

/**
 * Creator fee split terms: the pure, dependency light half of the fee
 * split feature (validation and share math). Kept free of database
 * imports so API validation and client code can share it. The storage
 * half lives in lib/db/fee-splits.ts.
 *
 * A split shares the creator trading fee (0.30% of volume) across up
 * to 10 wallets by basis points. The creator always keeps the
 * remainder: recipients can be assigned at most 9,000 of 10,000 bps,
 * so a launch can never give away the creator's entire stream.
 */

export interface FeeSplitRecipient {
  /** Recipient wallet (base58); optional for handle-only placeholders bound later */
  wallet?: string;
  /** Share of the creator trading fee, in basis points */
  bps: number;
  /** Optional public X handle, without the @ */
  handle?: string;
}

export const MAX_SPLIT_RECIPIENTS = 10;
/** Recipients together can take at most 90% of the creator fee. */
export const MAX_SPLIT_TOTAL_BPS = 9_000;
export const BPS_TOTAL = 10_000;

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Validate and normalize a raw splits payload. Returns the canonical
 * recipient list, or throws with a message safe to show the user. The
 * creator may list themselves only implicitly (the remainder), never
 * as a recipient.
 */
export function validateFeeSplits(raw: unknown, creatorWallet: string): FeeSplitRecipient[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('Fee splits must be a list');
  if (raw.length === 0) return [];
  if (raw.length > MAX_SPLIT_RECIPIENTS) {
    throw new Error(`At most ${MAX_SPLIT_RECIPIENTS} fee split recipients`);
  }
  const seen = new Set<string>();
  const seenHandles = new Set<string>();
  let total = 0;
  const out: FeeSplitRecipient[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (typeof entry !== 'object' || entry === null) throw new Error('Invalid fee split entry');
    let wallet: string | undefined;
    const rawWallet = entry.wallet;
    if (rawWallet !== undefined && rawWallet !== null && rawWallet !== '') {
      try {
        wallet = new PublicKey(String(rawWallet)).toBase58();
      } catch {
        throw new Error('A fee split wallet is not a valid Solana address');
      }
      if (wallet === creatorWallet) {
        throw new Error('The creator keeps the remainder and cannot also be a split recipient');
      }
      if (seen.has(wallet)) throw new Error('A wallet appears twice in the fee splits');
      seen.add(wallet);
    }
    const bps = entry.bps;
    if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 1 || bps > MAX_SPLIT_TOTAL_BPS) {
      throw new Error('Each fee split share must be a whole number of basis points, at least 1');
    }
    total += bps;
    if (total > MAX_SPLIT_TOTAL_BPS) {
      throw new Error('Fee split recipients can share at most 90% of the creator fee');
    }
    let handle: string | undefined;
    if (entry.handle !== undefined && entry.handle !== null && entry.handle !== '') {
      const h = String(entry.handle).replace(/^@/, '');
      if (!HANDLE_RE.test(h)) throw new Error('An X handle in the fee splits is not valid');
      const lowered = h.toLowerCase();
      if (seenHandles.has(lowered)) throw new Error('An X handle appears twice in the fee splits');
      seenHandles.add(lowered);
      handle = h;
    }
    if (!wallet && !handle) {
      throw new Error('A fee split entry needs a Solana wallet, an X handle, or both');
    }
    out.push({ ...(wallet ? { wallet } : {}), bps, ...(handle ? { handle } : {}) });
  }
  return out;
}

/** The creator's remainder share in bps after all recipients. */
export function creatorRemainderBps(recipients: FeeSplitRecipient[]): number {
  return BPS_TOTAL - recipients.reduce((sum, r) => sum + r.bps, 0);
}

/**
 * One recipient's share of an accrued raw fee amount, as a decimal
 * string. BigInt math throughout: raw token amounts overflow floats.
 * Floors toward zero, so a distribution can never exceed the claim.
 */
export function splitShareRaw(rawAmount: string | null | undefined, bps: number): string {
  if (rawAmount === null || rawAmount === undefined) return '0';
  let amount: bigint;
  try {
    amount = BigInt(rawAmount);
  } catch {
    return '0';
  }
  if (amount <= BigInt(0) || bps <= 0) return '0';
  return ((amount * BigInt(bps)) / BigInt(BPS_TOTAL)).toString();
}

/**
 * A wallet bound to a fee split entry through a recipient onboarding
 * link. One row per (pool, entry), written once and never updated or
 * deleted: the first valid signature wins, and the bound wallet becomes
 * the entry's payout wallet at claim time. When the recipient claimed
 * through Login with X, x_user_id records the verified numeric X user
 * ID (stable across handle renames) and x_handle the handle at bind
 * time for display.
 */
export interface FeeSplitBinding {
  poolAddress: string;
  entryIndex: number;
  wallet: string;
  boundAt: number;
  xUserId?: string;
  xHandle?: string;
}

/** A split recipient annotated with its effective payout wallet. */
export interface EffectiveFeeSplitRecipient extends FeeSplitRecipient {
  /** The wallet payouts go to: the bound wallet when set, else the registered wallet. */
  effectiveWallet?: string;
  /** True once a binding exists for this entry. */
  bound: boolean;
}

/**
 * Annotate each recipient with the wallet that will actually be paid:
 * the bound wallet when a binding exists, otherwise the wallet the
 * creator registered. Handle-only entries stay unbound until the
 * collaborator signs the onboarding message.
 */
export function resolveEffectiveRecipients(
  recipients: FeeSplitRecipient[],
  bindings: FeeSplitBinding[],
): EffectiveFeeSplitRecipient[] {
  return recipients.map((r, i) => {
    const binding = bindings.find((b) => b.entryIndex === i);
    if (binding) {
      return { ...r, wallet: r.wallet, effectiveWallet: binding.wallet, bound: true };
    }
    return { ...r, effectiveWallet: r.wallet, bound: !!r.wallet };
  });
}

/**
 * Pure eligibility check for binding a wallet to a split entry.
 * Throws with a user-safe message when the binding is not allowed.
 * Rules: the entry must exist and not already be bound; the wallet
 * must be a valid address and not the creator's; wallet-registered
 * entries can only be bound by that same wallet (proof of control);
 * one wallet per entry per pool, so a wallet already effective for
 * another entry in the same pool is rejected.
 */
export function checkBindingEligibility(
  recipients: FeeSplitRecipient[],
  bindings: FeeSplitBinding[],
  entryIndex: number,
  wallet: string,
  creatorWallet: string,
): void {
  const entry = recipients[entryIndex];
  if (!entry) throw new Error('This split entry does not exist in this pool');
  if (bindings.some((b) => b.entryIndex === entryIndex)) {
    throw new Error('This split entry already has a wallet bound to it');
  }
  let normalized: string;
  try {
    normalized = new PublicKey(wallet).toBase58();
  } catch {
    throw new Error('This is not a valid Solana address');
  }
  if (normalized === creatorWallet) {
    throw new Error('The creator wallet cannot be bound to a split entry');
  }
  if (entry.wallet && normalized !== entry.wallet) {
    throw new Error('This entry is registered to a different wallet, which must sign instead');
  }
  const used = new Set<string>();
  recipients.forEach((r, i) => {
    if (i === entryIndex) return; // the entry being bound may reuse its own wallet
    const b = bindings.find((x) => x.entryIndex === i);
    const effective = b ? b.wallet : r.wallet;
    if (effective) used.add(effective);
  });
  if (used.has(normalized)) {
    throw new Error('This wallet is already used by another split entry in this pool');
  }
}
