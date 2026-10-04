/**
 * Buyback and burn keeper.
 *
 * Sweeps every pool with buyback_bps > 0: reads the buyback vault's
 * quote token balance for the pool, swaps it for the base token via
 * Jupiter when it clears a $5 dust threshold, burns the base tokens
 * received, and records the burn in buyback_burns.
 *
 * Runs with plain `node` (Node 24 type stripping): it imports only npm
 * packages and node builtins, never repo source, so there is no tsx
 * step and no @/ alias to resolve.
 *
 * Usage:
 *   DATABASE_URL=... SOLANA_RPC_URL=... BUYBACK_VAULT_SECRET='[1,2,...]' \
 *     node scripts/buyback-keeper.ts
 *
 * Env:
 *   DATABASE_URL            Postgres (required, same as the app)
 *   SOLANA_RPC_URL | RPC    Solana RPC (required)
 *   BUYBACK_VAULT_SECRET    Vault keypair: JSON secret-key array, or a
 *                           path to a JSON keypair file (required; never logged)
 *   NEXT_PUBLIC_SOLANA_NETWORK | SOLANA_NETWORK
 *                           devnet | mainnet-beta (default devnet)
 *   BUYBACK_SLIPPAGE_BPS    Jupiter slippage (default 100 = 1%)
 *   BUYBACK_MIN_USD         Dust threshold in USD (default 5)
 *
 * Safety:
 *   - One pool failing never stops the sweep; the error is logged and
 *     the keeper moves on.
 *   - buyback_burns has a UNIQUE tx_signature: recording is idempotent,
 *     and the keeper checks for the signature before inserting.
 *   - On devnet the swap is skipped and logged (Jupiter has no devnet
 *     routes), mirroring the app's own mirroring guard.
 *   - The vault secret is never printed.
 */

import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { createBurnInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Pool as PgPool } from 'pg';
import fs from 'fs';

const JUP_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';
const JUP_PRICE_URL = 'https://api.jup.ag/price/v3';

interface BuybackPool {
  poolAddress: string;
  buybackBps: number;
  baseMint: string;
  quoteMint: string;
  baseSymbol: string;
}

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function requiredEnv(name: string, alt = ''): string {
  const v = env(name) || (alt ? env(alt) : '');
  if (!v) throw new Error(`[keeper] ${name} is not set`);
  return v;
}

function log(...args: unknown[]): void {
  console.log('[keeper]', ...args);
}

function warn(...args: unknown[]): void {
  console.warn('[keeper]', ...args);
}

/** Minimal pg pool, same connection shape as the app's db layer. */
function makeDb(): PgPool {
  const url = requiredEnv('DATABASE_URL');
  const isLocal = /(^|[@/])(localhost|127\.0\.0\.1)([:/]|$)/.test(url);
  // Neon's pooler rejects `options` as a startup param; set search_path
  // per-client instead (mirrors src/lib/db/index.ts getPool()).
  const isNeonPooler = /-pooler\./.test(url);
  const db = new PgPool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    ...(isNeonPooler ? {} : { options: '-c search_path=curv,public' }),
    max: 2,
    connectionTimeoutMillis: 10_000,
  });
  if (isNeonPooler) {
    // Neon's pooler rejects the `options` startup parameter, so search_path
    // is set on every checkout instead. It must be awaited before the client
    // is handed out: a fire-and-forget pool.on('connect') SET has a race
    // where the first query can run before the SET completes (this once
    // caused a seed import to see an empty pools table and write junk into
    // `public`). pool.query() routes through connect() internally, so this
    // covers all query paths.
    const origConnect = db.connect.bind(db);
    db.connect = ((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as
        | ((err: Error | null, client?: unknown, done?: () => void) => void)
        | undefined;
      const p = (async () => {
        const client = await (origConnect as () => Promise<any>)();
        try {
          await client.query('SET search_path = curv, public');
        } catch (err) {
          client.release();
          throw err;
        }
        return client;
      })();
      if (cb) {
        p.then(
          (client: any) => cb(null, client, () => client.release()),
          (err) => cb(err as Error),
        );
        return undefined;
      }
      return p;
    }) as typeof db.connect;
  }
  return db;
}

function loadVaultKeypair(): Keypair {
  const raw = requiredEnv('BUYBACK_VAULT_SECRET').trim();
  let arr: unknown;
  if (raw.startsWith('[')) {
    arr = JSON.parse(raw);
  } else {
    // Otherwise treat it as a path to a JSON keypair file.
    arr = JSON.parse(fs.readFileSync(raw, 'utf8'));
  }
  if (!Array.isArray(arr)) throw new Error('[keeper] BUYBACK_VAULT_SECRET is not a JSON array');
  return Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
}

interface JupPrice {
  usdPrice: number | null;
  decimals: number | null;
}

async function jupiterPrice(mint: string): Promise<JupPrice> {
  try {
    const res = await fetch(`${JUP_PRICE_URL}?ids=${mint}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return { usdPrice: null, decimals: null };
    const json = (await res.json()) as Record<string, { usdPrice?: number; decimals?: number }>;
    const e = json?.[mint];
    const usdPrice = typeof e?.usdPrice === 'number' && e.usdPrice > 0 ? e.usdPrice : null;
    const decimals =
      typeof e?.decimals === 'number' && Number.isInteger(e.decimals) && e.decimals >= 0 && e.decimals <= 18
        ? e.decimals
        : null;
    return { usdPrice, decimals };
  } catch {
    return { usdPrice: null, decimals: null };
  }
}

interface JupQuote {
  inAmount: string;
  outAmount: string;
  raw: Record<string, unknown>;
}

async function jupiterQuote(inputMint: string, outputMint: string, amountRaw: string, slippageBps: number): Promise<JupQuote> {
  const qs = new URLSearchParams({ inputMint, outputMint, amount: amountRaw, slippageBps: String(slippageBps) });
  const res = await fetch(`${JUP_QUOTE_URL}?${qs.toString()}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jupiter quote failed (http ${res.status})`);
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.inAmount !== 'string' || typeof json.outAmount !== 'string') {
    throw new Error('Jupiter quote came back unreadable');
  }
  return { inAmount: json.inAmount as string, outAmount: json.outAmount as string, raw: json };
}

async function jupiterSwapTransaction(quote: JupQuote, userPublicKey: string): Promise<string> {
  const res = await fetch(JUP_SWAP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap build failed (http ${res.status})`);
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.swapTransaction !== 'string' || json.swapTransaction.length === 0) {
    throw new Error('Jupiter swap came back unreadable');
  }
  return json.swapTransaction as string;
}

function signWithKeypair(txBase64: string, kp: Keypair): Uint8Array {
  const buf = Buffer.from(txBase64, 'base64');
  // Versioned transactions carry the 0x80 bit on the first byte.
  if ((buf[0] & 0x80) !== 0) {
    const vtx = VersionedTransaction.deserialize(buf);
    vtx.sign([kp]);
    return vtx.serialize();
  }
  const tx = Transaction.from(buf);
  if (!tx.feePayer) tx.feePayer = kp.publicKey;
  tx.partialSign(kp);
  return tx.serialize();
}

async function sendAndConfirm(connection: Connection, signed: Uint8Array, label: string): Promise<string> {
  const signature = await connection.sendRawTransaction(signed, { skipPreflight: false, maxRetries: 3 });
  const latest = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    'confirmed',
  );
  log(`${label} confirmed: ${signature}`);
  return signature;
}

async function ataBalanceRaw(connection: Connection, ata: PublicKey): Promise<bigint | null> {
  try {
    const bal = await connection.getTokenAccountBalance(ata, 'confirmed');
    return BigInt(bal.value.amount);
  } catch {
    return null; // No account yet: nothing to sweep.
  }
}

async function burnRecorded(db: PgPool, txSignature: string): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM buyback_burns WHERE tx_signature = $1', [txSignature]);
  return (r.rowCount ?? 0) > 0;
}

async function recordBurn(
  db: PgPool,
  poolAddress: string,
  txSignature: string,
  quoteAmountRaw: string,
  baseAmountRaw: string,
): Promise<void> {
  if (await burnRecorded(db, txSignature)) {
    log(`burn ${txSignature} already recorded, skipping insert`);
    return;
  }
  await db.query(
    `INSERT INTO buyback_burns (pool_address, tx_signature, quote_amount_raw, base_amount_raw, burned_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tx_signature) DO NOTHING`,
    [poolAddress, txSignature, quoteAmountRaw, baseAmountRaw, Date.now()],
  );
}

async function sweepPool(
  connection: Connection,
  db: PgPool,
  vault: Keypair,
  pool: BuybackPool,
  opts: { isDevnet: boolean; slippageBps: number; minUsd: number },
): Promise<void> {
  const tag = `${pool.baseSymbol} (${pool.poolAddress.slice(0, 8)})`;
  const quoteMint = new PublicKey(pool.quoteMint);
  const baseMint = new PublicKey(pool.baseMint);
  const vaultPk = vault.publicKey;

  const quoteAta = getAssociatedTokenAddressSync(quoteMint, vaultPk);
  const quoteBal = await ataBalanceRaw(connection, quoteAta);
  if (quoteBal === null || quoteBal === BigInt(0)) {
    log(`${tag}: vault holds no ${pool.quoteMint.slice(0, 8)}, nothing to sweep`);
    return;
  }

  const price = await jupiterPrice(pool.quoteMint);
  if (price.usdPrice === null || price.decimals === null) {
    log(`${tag}: quote mint unpriced, skipping (vault holds ${quoteBal.toString()} raw)`);
    return;
  }
  const usdValue = (Number(quoteBal) / 10 ** price.decimals) * price.usdPrice;
  if (usdValue < opts.minUsd) {
    log(`${tag}: vault balance ~$${usdValue.toFixed(2)}, below $${opts.minUsd} dust threshold, skipping`);
    return;
  }

  if (opts.isDevnet) {
    // Jupiter has no devnet routes; the app mirrors this same guard.
    log(`${tag}: devnet, Jupiter cannot route here, skipping swap (vault holds ~$${usdValue.toFixed(2)})`);
    return;
  }

  log(`${tag}: sweeping ~$${usdValue.toFixed(2)} of quote into ${pool.baseSymbol}`);

  const quote = await jupiterQuote(pool.quoteMint, pool.baseMint, quoteBal.toString(), opts.slippageBps);
  log(`${tag}: quote ${quote.inAmount} -> ~${quote.outAmount} base`);
  const swapB64 = await jupiterSwapTransaction(quote, vaultPk.toBase58());
  const swapSig = await sendAndConfirm(connection, signWithKeypair(swapB64, vault), `${tag} swap`);

  const baseAta = getAssociatedTokenAddressSync(baseMint, vaultPk);
  const baseBal = await ataBalanceRaw(connection, baseAta);
  if (baseBal === null || baseBal === BigInt(0)) {
    warn(`${tag}: swap ${swapSig} left no base tokens to burn`);
    return;
  }

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const burnTx = new Transaction({ feePayer: vaultPk, recentBlockhash: blockhash }).add(
    createBurnInstruction(baseAta, baseMint, vaultPk, baseBal),
  );
  burnTx.partialSign(vault);
  const burnSig = await sendAndConfirm(connection, burnTx.serialize(), `${tag} burn`);

  await recordBurn(db, pool.poolAddress, burnSig, quoteBal.toString(), baseBal.toString());
  log(`${tag}: burned ${baseBal.toString()} ${pool.baseSymbol} (swap in ${quoteBal.toString()} quote)`);
}

async function main(): Promise<void> {
  const rpc = requiredEnv('SOLANA_RPC_URL', 'RPC');
  const network = (env('NEXT_PUBLIC_SOLANA_NETWORK') || env('SOLANA_NETWORK') || 'devnet').toLowerCase();
  const isDevnet = network !== 'mainnet-beta' && network !== 'mainnet';
  const slippageBps = Number(env('BUYBACK_SLIPPAGE_BPS', '100')) || 100;
  const minUsd = Number(env('BUYBACK_MIN_USD', '5')) || 5;

  const vault = loadVaultKeypair();
  log(`vault ${vault.publicKey.toBase58()} on ${isDevnet ? 'devnet' : 'mainnet'}`);

  const connection = new Connection(rpc, 'confirmed');
  const db = makeDb();
  try {
    const { rows } = await db.query<BuybackPool>(
      `SELECT pool_address AS "poolAddress", buyback_bps AS "buybackBps",
              base_mint AS "baseMint", quote_mint AS "quoteMint", base_symbol AS "baseSymbol"
       FROM pools WHERE buyback_bps > 0`,
    );
    log(`${rows.length} pool(s) with buyback enabled`);
    let ok = 0;
    let failed = 0;
    for (const pool of rows) {
      try {
        await sweepPool(connection, db, vault, pool, { isDevnet, slippageBps, minUsd });
        ok++;
      } catch (e) {
        failed++;
        warn(`${pool.baseSymbol} (${pool.poolAddress.slice(0, 8)}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    log(`done: ${ok} swept, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error('[keeper] fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
