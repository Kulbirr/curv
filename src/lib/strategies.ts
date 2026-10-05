import { randomBytes } from 'crypto';
import { PublicKey } from '@solana/web3.js';

/**
 * Trading strategy mirror feed: pure domain logic.
 *
 * The feed publishes identical spot buy signals to every subscriber.
 * Crypto spot only, no leverage, no personalization, no advice tailored
 * to anyone. The operator never touches funds: every mirror is a Jupiter
 * swap the user reviews and signs in their own wallet, one signature per
 * trade. Nothing here holds keys or submits transactions.
 *
 * All user facing strings in this feature avoid dash characters and never
 * promise or imply returns.
 */

/** Flat subscription price: 0.05 SOL for 30 days. No performance cut. */
export const SUBSCRIPTION_PRICE_LAMPORTS = 50_000_000;
export const SUBSCRIPTION_DURATION_MS = 30 * 24 * 3600 * 1000;

/** Slippage guard applied to every mirror (1%), shown in the UI. */
export const MIRROR_SLIPPAGE_BPS = 100;

/** Admin publish route authenticates with this header. */
export const STRATEGIES_ADMIN_HEADER = 'x-strategies-admin';

/** Signals live at most 7 days; anything longer is rejected at publish. */
export const MAX_SIGNAL_TTL_MS = 7 * 24 * 3600 * 1000;

export type SignalSide = 'buy';
export type SignalStatus = 'active' | 'cancelled';

/** How a published signal ended: win/loss on first touch, expired untouched. */
export type SignalOutcome = 'pending' | 'win' | 'loss' | 'expired';

export interface StrategySignal {
  id: string;
  baseMint: string;
  quoteMint: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** Reference price of one base unit in quote units at publish time. */
  entryPrice: number;
  /** Mirror is refused when the live price is above this. */
  maxPrice: number;
  side: SignalSide;
  sizeText: string | null;
  note: string | null;
  status: SignalStatus;
  expiresAt: number;
  createdAt: number;
  /** Stop level from the approved idea; first touch resolves a loss. */
  stopPrice: number | null;
  /** Target levels from the approved idea; first touch of targets[0] resolves a win. */
  targets: number[] | null;
  /** Resolution state, maintained by the 30-minute resolver. */
  outcome: SignalOutcome;
  resolvedAt: number | null;
  /** Price of the resolving sample, or the last sample at expiry. */
  resolvedPrice: number | null;
  /** True when the signal passed the AI judge in the approval pipeline. */
  aiApproved: boolean;
  /** The judge's reasons, shown on the signal card when approved. */
  aiReasons: string[] | null;
}

export interface StrategySubscription {
  wallet: string;
  expiresAt: number;
  txSignature: string | null;
  createdAt: number;
}

/**
 * TODO: weekly P and L credit ("a down week earns a free month").
 * When weekly P and L tracking exists, a subscriber who ends a tracked
 * week down gets their expiry extended by SUBSCRIPTION_DURATION_MS at no
 * charge. This is a flat fee credit, not a share of profits. Not
 * implemented yet: there is no P and L tracking to base it on.
 */

/** Well known mint decimals so the admin can omit them for common pairs. */
export const KNOWN_MINT_DECIMALS: Record<string, number> = {
  So11111111111111111111111111111111111111112: 9,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 8,
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: 8,
};

/** Local logo assets for well known mints, used by the signal cards. */
export const KNOWN_TOKEN_LOGOS: Record<string, string> = {
  So11111111111111111111111111111111111111112: '/tokens/sol.png',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: '/tokens/usdc.png',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': '/tokens/eth.png',
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: '/tokens/btc.png',
};

export function newSignalId(): string {
  return `sig_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`;
}

export function isSignalExpired(signal: Pick<StrategySignal, 'expiresAt'>, nowMs: number): boolean {
  return nowMs >= signal.expiresAt;
}

export function isSignalLive(
  signal: Pick<StrategySignal, 'status' | 'expiresAt'>,
  nowMs: number,
): boolean {
  return signal.status === 'active' && !isSignalExpired(signal, nowMs);
}

export function isSubscriptionActive(
  sub: Pick<StrategySubscription, 'expiresAt'> | null,
  nowMs: number,
): boolean {
  return sub !== null && sub.expiresAt > nowMs;
}

/**
 * Price of one base unit in quote units from raw swap amounts.
 * Returns null when the amounts are unusable.
 */
export function quoteToBasePrice(
  inRaw: string | bigint,
  outRaw: string | bigint,
  inDecimals: number,
  outDecimals: number,
): number | null {
  let inN: bigint;
  let outN: bigint;
  try {
    inN = typeof inRaw === 'bigint' ? inRaw : BigInt(inRaw);
    outN = typeof outRaw === 'bigint' ? outRaw : BigInt(outRaw);
  } catch {
    return null;
  }
  if (inN <= BigInt(0) || outN <= BigInt(0)) return null;
  if (!Number.isInteger(inDecimals) || !Number.isInteger(outDecimals)) return null;
  if (inDecimals < 0 || inDecimals > 18 || outDecimals < 0 || outDecimals > 18) return null;
  const quoteUnits = Number(inN) / 10 ** inDecimals;
  const baseUnits = Number(outN) / 10 ** outDecimals;
  if (!Number.isFinite(quoteUnits) || !Number.isFinite(baseUnits) || baseUnits <= 0) return null;
  return quoteUnits / baseUnits;
}

/** True when the live price is at or under the signal's ceiling. */
export function isPriceAcceptable(livePrice: number, maxPrice: number): boolean {
  return Number.isFinite(livePrice) && livePrice > 0 && livePrice <= maxPrice;
}

/** Minimum acceptable output after slippage, in raw units. */
export function minOutWithSlippage(outRaw: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) throw new Error('Bad slippage');
  return (outRaw * BigInt(10_000 - slippageBps)) / BigInt(10000);
}

/**
 * Human countdown to expiry: "2h 14m", "9m 41s", "41s", or "expired".
 * Dash free by construction.
 */
export function formatCountdown(expiresAt: number, nowMs: number): string {
  const ms = expiresAt - nowMs;
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function validAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

function validSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().toUpperCase();
  if (t.length === 0 || t.length > 12 || !/^[A-Z0-9]+$/.test(t)) return null;
  return t;
}

function validPrice(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function validDecimals(value: unknown, fallback: number | undefined): number | null {
  if (value === undefined || value === null) {
    return fallback !== undefined ? fallback : null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 18) return null;
  return value;
}

function validFutureMs(value: unknown, nowMs: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value <= nowMs || value - nowMs > MAX_SIGNAL_TTL_MS) return null;
  return value;
}

function validOptionalText(value: unknown, maxLen: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length === 0) return null;
  if (t.length > maxLen) return null;
  return t;
}

export type SignalInput = Omit<
  StrategySignal,
  'id' | 'status' | 'createdAt' | 'aiApproved' | 'aiReasons' | 'outcome' | 'resolvedAt' | 'resolvedPrice'
>;

export function validateSignalInput(
  body: unknown,
  nowMs: number,
): { ok: true; input: SignalInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Signal body must be an object' };
  }
  const b = body as Record<string, unknown>;

  const baseMint = validAddress(b.baseMint);
  if (!baseMint) return { ok: false, error: 'baseMint must be a valid Solana address' };
  const quoteMint = validAddress(b.quoteMint);
  if (!quoteMint) return { ok: false, error: 'quoteMint must be a valid Solana address' };
  if (baseMint === quoteMint) return { ok: false, error: 'baseMint and quoteMint must differ' };

  const baseSymbol = validSymbol(b.baseSymbol);
  if (!baseSymbol) return { ok: false, error: 'baseSymbol must be 1 to 12 letters or digits' };
  const quoteSymbol = validSymbol(b.quoteSymbol);
  if (!quoteSymbol) return { ok: false, error: 'quoteSymbol must be 1 to 12 letters or digits' };

  const baseDecimals = validDecimals(b.baseDecimals, KNOWN_MINT_DECIMALS[baseMint]);
  if (baseDecimals === null) return { ok: false, error: 'baseDecimals must be 0 to 18' };
  const quoteDecimals = validDecimals(b.quoteDecimals, KNOWN_MINT_DECIMALS[quoteMint]);
  if (quoteDecimals === null) return { ok: false, error: 'quoteDecimals must be 0 to 18' };

  const entryPrice = validPrice(b.entryPrice);
  if (entryPrice === null) return { ok: false, error: 'entryPrice must be a positive number' };
  const maxPrice = validPrice(b.maxPrice);
  if (maxPrice === null) return { ok: false, error: 'maxPrice must be a positive number' };
  if (maxPrice < entryPrice) {
    return { ok: false, error: 'maxPrice must be at least the entryPrice' };
  }

  if (b.side !== undefined && b.side !== 'buy') {
    return { ok: false, error: 'side must be buy, spot only' };
  }

  const expiresAt = validFutureMs(b.expiresAt, nowMs);
  if (expiresAt === null) {
    return { ok: false, error: 'expiresAt must be a future time within 7 days' };
  }

  const sizeText = validOptionalText(b.sizeText, 40);
  const note = validOptionalText(b.note, 140);

  // Stop/targets come from the approved idea; they power the public
  // track record. A buy signal's stop sits below entry, targets above.
  let stopPrice: number | null = null;
  if (b.stopPrice !== undefined && b.stopPrice !== null) {
    stopPrice = validPrice(b.stopPrice);
    if (stopPrice === null) return { ok: false, error: 'stopPrice must be a positive number' };
    if (stopPrice >= entryPrice) {
      return { ok: false, error: 'stopPrice must be below the entryPrice for a buy signal' };
    }
  }
  let targets: number[] | null = null;
  if (b.targets !== undefined && b.targets !== null) {
    if (!Array.isArray(b.targets) || b.targets.length === 0 || b.targets.length > 5) {
      return { ok: false, error: 'targets must be an array of 1 to 5 prices' };
    }
    const parsed: number[] = [];
    for (const t of b.targets) {
      const p = validPrice(t);
      if (p === null || p <= entryPrice) {
        return { ok: false, error: 'every target must be above the entryPrice for a buy signal' };
      }
      parsed.push(p);
    }
    targets = parsed;
  }

  return {
    ok: true,
    input: {
      baseMint,
      quoteMint,
      baseSymbol,
      quoteSymbol,
      baseDecimals,
      quoteDecimals,
      entryPrice,
      maxPrice,
      side: 'buy',
      sizeText,
      note,
      expiresAt,
      stopPrice,
      targets,
    },
  };
}

/**
 * Admin authentication for the publish route. Fail closed: when no secret
 * is configured, every publish is rejected.
 */
export function isAdminAuthorized(headerValue: unknown, configuredSecret: string | undefined): boolean {
  if (!configuredSecret || typeof headerValue !== 'string' || headerValue.length === 0) return false;
  if (headerValue.length !== configuredSecret.length) return false;
  let diff = 0;
  for (let i = 0; i < headerValue.length; i++) {
    diff |= headerValue.charCodeAt(i) ^ configuredSecret.charCodeAt(i);
  }
  return diff === 0;
}
