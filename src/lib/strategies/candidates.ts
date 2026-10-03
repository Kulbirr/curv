import { PublicKey } from '@solana/web3.js';

/**
 * Candidate submission validation, shared by the API route and tests.
 * Kept out of the pages directory so Next.js never treats it as a route.
 */

export interface CandidateSubmitBody {
  baseMint: string;
  baseSymbol: string;
  quoteMint: string;
  quoteSymbol: string;
  entryLow: number;
  entryHigh: number;
  stopPrice: number;
  targets: number[];
  sizeText: string | null;
  thesis: string;
  submittedBy: string;
  noKnownUnlock: boolean;
}

function validMint(value: unknown): string | null {
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

function validText(value: unknown, minLen: number, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length < minLen || t.length > maxLen) return null;
  return t;
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function validateCandidateBody(
  body: unknown,
): { ok: true; input: CandidateSubmitBody } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Candidate body must be an object' };
  }
  const b = body as Record<string, unknown>;

  const baseMint = validMint(b.baseMint);
  if (!baseMint) return { ok: false, error: 'baseMint must be a valid Solana address' };
  const baseSymbol = validSymbol(b.baseSymbol);
  if (!baseSymbol) return { ok: false, error: 'baseSymbol must be 1 to 12 letters or digits' };

  const quoteMint = b.quoteMint === undefined ? SOL_MINT : validMint(b.quoteMint);
  if (!quoteMint) return { ok: false, error: 'quoteMint must be a valid Solana address' };
  const quoteSymbol = b.quoteSymbol === undefined ? 'SOL' : validSymbol(b.quoteSymbol);
  if (!quoteSymbol) return { ok: false, error: 'quoteSymbol must be 1 to 12 letters or digits' };
  if (baseMint === quoteMint) return { ok: false, error: 'baseMint and quoteMint must differ' };

  const entryLow = validPrice(b.entryLow);
  if (entryLow === null) return { ok: false, error: 'entryLow must be a positive number' };
  const entryHigh = validPrice(b.entryHigh);
  if (entryHigh === null) return { ok: false, error: 'entryHigh must be a positive number' };
  const stopPrice = validPrice(b.stopPrice);
  if (stopPrice === null) return { ok: false, error: 'stopPrice must be a positive number' };

  if (!Array.isArray(b.targets) || b.targets.length === 0 || b.targets.length > 5) {
    return { ok: false, error: 'targets must be a non empty list of up to 5 prices' };
  }
  const targets: number[] = [];
  for (const t of b.targets) {
    const p = validPrice(t);
    if (p === null) return { ok: false, error: 'every target must be a positive number' };
    targets.push(p);
  }

  let sizeText: string | null = null;
  if (b.sizeText !== undefined && b.sizeText !== null) {
    sizeText = validText(b.sizeText, 1, 40);
    if (!sizeText) return { ok: false, error: 'sizeText must be 1 to 40 characters' };
  }

  const thesis = validText(b.thesis, 10, 2000);
  if (!thesis) return { ok: false, error: 'thesis must be 10 to 2000 characters' };
  const submittedBy = validText(b.submittedBy, 1, 64);
  if (!submittedBy) return { ok: false, error: 'submittedBy must be 1 to 64 characters' };

  return {
    ok: true,
    input: {
      baseMint,
      baseSymbol,
      quoteMint,
      quoteSymbol,
      entryLow,
      entryHigh,
      stopPrice,
      targets,
      sizeText,
      thesis,
      submittedBy,
      noKnownUnlock: b.noKnownUnlock === true,
    },
  };
}
