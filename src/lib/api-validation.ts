import type { NextApiRequest } from 'next';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { SOLANA_NETWORK } from './solana';
import { isCrossNetworkKnownMint } from './quote-assets';
import { normalizeTwitterUrl } from './twitter';
import { validateFeeSplits } from './fee-split-terms';
import type { FeeSplitRecipient } from './fee-split-terms';

/**
 * Strict input schemas for the API routes.
 *
 * Every route validates and normalizes its inputs here before touching the
 * database or the chain. Unknown body fields are dropped (we pick known
 * fields explicitly), malformed values are rejected with a 400 naming the
 * problem. Nothing in here trusts the client.
 */

/** Normalize a base58 Solana address, or null when malformed. */
export function parseAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

/** Validate a base58 ed25519 signature (64 bytes), or null when malformed. */
export function parseSignature(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  try {
    const raw = bs58.decode(value);
    if (raw.length !== 64) return null;
    return value;
  } catch {
    return null;
  }
}

function requiredText(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length === 0 || t.length > maxLen) return null;
  return t;
}

function optionalText(value: unknown, maxLen: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (t.length === 0) return undefined;
  if (t.length > maxLen) throw new Error('Field too long');
  return t;
}

function optionalHttpUrl(value: unknown, maxLen: number): string | undefined {
  const t = optionalText(value, maxLen);
  if (t === undefined) return undefined;
  if (!/^https?:\/\//.test(t)) throw new Error('URL must be http(s)');
  return t;
}
/**
 * Normalize an X (Twitter) handle or profile URL to a canonical
 * https://x.com/<handle> link. Returns undefined for empty input or for
 * input that is not a plausible handle: the field is optional, and the
 * value is rendered as an anchor href, so anything unparseable is dropped
 * rather than stored (this also keeps javascript: / data: hrefs out).
 */
function optionalTwitterUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  if (value.trim().length > 200) throw new Error('Field too long');
  // The field is optional and the value is rendered as an anchor href, so
  // unparseable input is dropped rather than stored (this also keeps
  // javascript: / data: hrefs out of the database).
  return normalizeTwitterUrl(value) ?? undefined;
}

export interface RegistrationInput {
  poolAddress: string;
  configAddress: string;
  baseMint: string;
  quoteMint: string;
  creator: string;
  baseSymbol: string;
  baseName: string;
  quoteSymbol: string;
  description?: string;
  imageUrl?: string;
  website?: string;
  twitter?: string;
  timestamp: number;
  signature: string;
  launchedAt?: number;
  /** Creator fee splits fixed at launch; validated by fee-split-terms. */
  feeSplits?: FeeSplitRecipient[];
  /**
   * Optional dev buy in quote lamports, disclosed at launch and shown on
   * the trust panel. Bound into the signed registration message so the
   * stored value is exactly what the creator committed.
   */
  devBuyLamports?: number;
  /**
   * Buyback and burn commitment: basis points (0-10000) of the creator fee
   * share committed to automatic buyback and burn. Bound into the signed
   * registration message so the stored value is exactly what the creator
   * committed. Immutable after launch.
   */
  buybackBps?: number;
  /**
   * Trader rewards: top N net buyers split bps of the creator fee,
   * winners decided at graduation. Bound into the signed registration
   * message. Immutable after launch.
   */
  traderReward?: { count: number; bps: number; rule: 'top_net_buyers' };
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

// NOTE for callers: narrow with `result.ok === false`, not `!result.ok`.
// This project's tsconfig sets strictNullChecks: false, under which
// TypeScript does not narrow discriminated unions on falsy checks.

/**
 * Validate POST /api/pools. Picks only known fields; everything else in
 * the body is ignored. Addresses are normalized to canonical base58.
 */
export function validateRegistrationBody(body: unknown): ValidationResult<RegistrationInput> {
  const fail = (error: string): ValidationResult<RegistrationInput> => ({ ok: false, error });
  if (typeof body !== 'object' || body === null) return fail('Request body must be JSON');

  const b = body as Record<string, unknown>;
  try {
    const poolAddress = parseAddress(b.poolAddress);
    if (!poolAddress) return fail('poolAddress is not a valid Solana address');
    const configAddress = parseAddress(b.configAddress);
    if (!configAddress) return fail('configAddress is not a valid Solana address');
    const baseMint = parseAddress(b.baseMint);
    if (!baseMint) return fail('baseMint is not a valid Solana address');
    const quoteMint = parseAddress(b.quoteMint);
    if (!quoteMint) return fail('quoteMint is not a valid Solana address');
    const creator = parseAddress(b.creator);
    if (!creator) return fail('creator is not a valid Solana address');

    if (baseMint === quoteMint) return fail('baseMint and quoteMint must differ');

    // Never accept a well-known asset of another network as the quote mint
    // (e.g. mainnet USDC submitted while we run on devnet).
    if (isCrossNetworkKnownMint(quoteMint, SOLANA_NETWORK)) {
      return fail(`quoteMint belongs to a different network than this ${SOLANA_NETWORK} deployment`);
    }

    const baseSymbol = requiredText(b.baseSymbol, 12);
    if (!baseSymbol) return fail('baseSymbol is required (max 12 chars)');
    const baseName = requiredText(b.baseName, 64);
    if (!baseName) return fail('baseName is required (max 64 chars)');
    const quoteSymbol = requiredText(b.quoteSymbol, 12);
    if (!quoteSymbol) return fail('quoteSymbol is required (max 12 chars)');

    const timestamp = Number(b.timestamp);
    if (!Number.isFinite(timestamp)) return fail('timestamp must be a number');
    const signature = parseSignature(b.signature);
    if (!signature) return fail('signature is not a valid ed25519 signature');

    let launchedAt: number | undefined;
    if (b.launchedAt !== undefined && b.launchedAt !== null) {
      launchedAt = Number(b.launchedAt);
      if (!Number.isFinite(launchedAt) || launchedAt < 0 || launchedAt > Date.now() + 60_000) {
        return fail('launchedAt must be a valid timestamp');
      }
    }

    // Fee splits are optional and fixed at launch. The validator throws
    // with a user safe message, which becomes the 400 text.
    let feeSplits: FeeSplitRecipient[] | undefined;
    if (b.feeSplits !== undefined && b.feeSplits !== null) {
      const parsedSplits = validateFeeSplits(b.feeSplits, creator);
      if (parsedSplits.length > 0) feeSplits = parsedSplits;
    }

    // Dev buy is optional. Positive integer lamports only; the exact
    // amount is bound into the signed registration message, so a forged
    // value fails signature verification.
    let devBuyLamports: number | undefined;
    if (b.devBuyLamports !== undefined && b.devBuyLamports !== null) {
      const n = Number(b.devBuyLamports);
      if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
        return fail('devBuyLamports must be a positive integer');
      }
      devBuyLamports = n;
    }

    // Buyback bps is bound into the signed registration message, so a
    // forged value fails signature verification.
    let buybackBps = 0;
    if (b.buybackBps !== undefined && b.buybackBps !== null) {
      const n = Number(b.buybackBps);
      if (!Number.isInteger(n) || n < 0 || n > 10000) {
        return fail('buybackBps must be an integer between 0 and 10000');
      }
      buybackBps = n;
    }

    // Trader rewards: {count, bps}, reserved for top net buyers.
    // Bound into the signed message like fee splits. The bps counts
    // toward the 90% recipient cap together with fee splits.
    let traderReward: { count: number; bps: number } | undefined;
    if (b.traderReward !== undefined && b.traderReward !== null) {
      const tr = b.traderReward as { count?: unknown; bps?: unknown };
      const count = Number(tr.count);
      const bps = Number(tr.bps);
      if (!Number.isInteger(count) || count < 1 || count > 5) {
        return fail('traderReward.count must be an integer between 1 and 5');
      }
      if (!Number.isInteger(bps) || bps < 1 || bps > 9000) {
        return fail('traderReward.bps must be an integer between 1 and 9000');
      }
      const splitsBps = (feeSplits ?? []).reduce((s, r) => s + r.bps, 0);
      if (splitsBps + bps > 9000) {
        return fail('Fee splits and trader rewards together can use at most 90% of the creator fee');
      }
      traderReward = { count, bps };
    }

    return {
      ok: true,
      value: {
        poolAddress,
        configAddress,
        baseMint,
        quoteMint,
        creator,
        baseSymbol: baseSymbol.toUpperCase(),
        baseName,
        quoteSymbol: quoteSymbol.toUpperCase(),
        description: optionalText(b.description, 500),
        imageUrl: optionalHttpUrl(b.imageUrl, 500),
        website: optionalHttpUrl(b.website, 200),
        twitter: optionalTwitterUrl(b.twitter),
        timestamp,
        signature,
        launchedAt,
        feeSplits,
        devBuyLamports,
        buybackBps,
        traderReward: traderReward ? { ...traderReward, rule: 'top_net_buyers' as const } : undefined,
      },
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Invalid request body');
  }
}

/**
 * Best-effort client IP for rate limiting, hosting-aware.
 *
 * Never trust x-forwarded-for's leftmost entry blindly: any client can prepend
 * arbitrary values, which would let an attacker rotate rate-limit identities.
 * On Vercel the edge sets x-real-ip to the connecting client IP, so prefer it.
 * Self-hosted deployments behind their own proxy can name the header their
 * proxy sets-and-strips via TRUSTED_PROXY_IP_HEADER.
 */
export function getClientIp(req: NextApiRequest): string {
  const trusted = process.env.TRUSTED_PROXY_IP_HEADER?.toLowerCase();
  if (trusted) {
    const v = req.headers[trusted];
    const ip = Array.isArray(v) ? v[0] : typeof v === 'string' ? v.split(',')[0]?.trim() : '';
    if (ip) return ip;
  }
  const real = req.headers['x-real-ip'];
  const realIp = Array.isArray(real) ? real[0] : typeof real === 'string' ? real.split(',')[0]?.trim() : '';
  if (realIp) return realIp;
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : typeof fwd === 'string' ? fwd.split(',')[0]?.trim() : '';
  return first || req.socket.remoteAddress || 'unknown';
}
