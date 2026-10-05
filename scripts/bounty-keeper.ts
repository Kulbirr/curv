/**
 * Shill-to-Earn bounty keeper.
 *
 * Every 30 minutes:
 *   1. Takes engagement snapshots for every active bounty round
 *      (leaderboard data; one tweet failing never kills the pass).
 *   2. Finalizes rounds past ends_at: final snapshot, disqualify
 *      unavailable tweets and the creator's own entries, rank by
 *      score, write immutable winners.
 *   3. Pays bound, unpaid winners from the bounty vault (SPL
 *      transfer, server-signed), recording each payout in the
 *      append-only bounty_payouts ledger.
 *
 * Runs with plain `node` (Node 24 type stripping): it imports only npm
 * packages, node builtins, relative repo source with no @/ aliases
 * (../src/lib/db/bounties.ts, ../src/lib/tweet-verify.ts), and the
 * dependency-free shared RPC failover wrapper, never other repo
 * source, so there is no tsx step and no alias to resolve.
 *
 * Usage:
 *   DATABASE_URL=... SOLANA_RPC_URL=... BOUNTY_VAULT_SECRET='[1,2,...]' \
 *     node scripts/bounty-keeper.ts
 *
 * Env:
 *   DATABASE_URL            Postgres (required, same as the app)
 *   SOLANA_RPC_URL | RPC    Solana RPC primary lane, Helius (required)
 *   ALCHEMY_RPC_URL         Solana RPC fallback lane, Alchemy (optional)
 *   BOUNTY_VAULT_WALLET     Vault address (required; only receives funds)
 *   BOUNTY_VAULT_SECRET     Vault keypair: JSON secret-key array, or a
 *                           path to a JSON keypair file (required; never logged)
 *   NEXT_PUBLIC_SOLANA_NETWORK | SOLANA_NETWORK
 *                           devnet | mainnet-beta (default devnet)
 *
 * Safety:
 *   - One bounty failing never stops the run; the error is logged and
 *     the keeper moves on.
 *   - bounty_payouts has a UNIQUE winner_id: recording is idempotent.
 *   - The vault secret is never printed; only lane names are logged.
 */

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { createFailoverConnection } from '../src/lib/rpc-failover.ts';
import {
  engagementScore,
  finalizeBounty,
  getBountyBalance,
  getBounty,
  listActiveBounties,
  listBountiesDueForFinalize,
  listEntries,
  listPayableWinners,
  recordPayout,
  recordSnapshot,
} from '../src/lib/db/bounties.ts';
import { fetchTweetEngagement } from '../src/lib/tweet-verify.ts';
import fs from 'fs';

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function requiredEnv(name: string, alt = ''): string {
  const v = env(name) || (alt ? env(alt) : '');
  if (!v) throw new Error(`[bounty-keeper] ${name} is not set`);
  return v;
}

function log(...args: unknown[]): void {
  console.log('[bounty-keeper]', ...args);
}

function warn(...args: unknown[]): void {
  console.warn('[bounty-keeper]', ...args);
}

function loadVaultKeypair(): Keypair {
  const raw = requiredEnv('BOUNTY_VAULT_SECRET').trim();
  let arr: unknown;
  if (raw.startsWith('[')) {
    arr = JSON.parse(raw);
  } else {
    arr = JSON.parse(fs.readFileSync(raw, 'utf8'));
  }
  if (!Array.isArray(arr)) throw new Error('[bounty-keeper] BOUNTY_VAULT_SECRET is not a JSON array');
  return Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
}

async function ataBalanceRaw(connection: Connection, ata: PublicKey): Promise<bigint | null> {
  try {
    const bal = await connection.getTokenAccountBalance(ata, 'confirmed');
    return BigInt(bal.value.amount);
  } catch {
    return null;
  }
}

async function sendAndConfirm(connection: Connection, tx: Transaction, label: string): Promise<string> {
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const latest = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    'confirmed',
  );
  log(`${label} confirmed: ${signature}`);
  return signature;
}

async function snapshotBounty(bountyId: number): Promise<number> {
  const bounty = await getBounty(bountyId);
  if (!bounty || bounty.status !== 'active') return 0;
  const entries = await listEntries(bountyId);
  let n = 0;
  for (const entry of entries) {
    if (entry.disqualified) continue;
    try {
      const eng = await fetchTweetEngagement(entry.tweetId);
      if (!eng) continue;
      await recordSnapshot(entry.id, eng, engagementScore(eng, bounty.weights));
      n++;
    } catch (e) {
      warn(`snapshot failed for entry ${entry.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return n;
}

async function finalizeDue(nowMs: number): Promise<void> {
  const due = await listBountiesDueForFinalize(nowMs);
  for (const bounty of due) {
    try {
      const balance = await getBountyBalance(bounty.poolAddress);
      const winners = await finalizeBounty(bounty, (entry) => fetchTweetEngagement(entry.tweetId), balance);
      log(`bounty ${bounty.id} ("${bounty.title}") finalized: ${winners.length} winner(s)`);
    } catch (e) {
      warn(`finalize failed for bounty ${bounty.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function payWinners(connection: Connection, vault: Keypair): Promise<void> {
  const payable = await listPayableWinners();
  if (payable.length === 0) {
    log('no payable winners');
    return;
  }
  const vaultPk = vault.publicKey;
  for (const w of payable) {
    const tag = `bounty ${w.bountyId} rank #${w.rank} @${w.authorHandle}`;
    try {
      if (!w.boundWallet) continue;
      const mint = new PublicKey(w.prizeMint);
      const amount = BigInt(w.prizeRaw);
      if (amount <= BigInt(0)) {
        warn(`${tag}: zero prize, skipping`);
        continue;
      }
      const owner = new PublicKey(w.boundWallet);
      const source = getAssociatedTokenAddressSync(mint, vaultPk);
      const dest = getAssociatedTokenAddressSync(mint, owner);
      const bal = await ataBalanceRaw(connection, source);
      if (bal === null || bal < amount) {
        warn(`${tag}: vault holds ${bal?.toString() ?? 'nothing'}, needs ${amount.toString()}, skipping`);
        continue;
      }
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: vaultPk, recentBlockhash: blockhash });
      const destInfo = await connection.getAccountInfo(dest);
      if (!destInfo) {
        tx.add(createAssociatedTokenAccountInstruction(vaultPk, dest, owner, mint));
      }
      tx.add(createTransferInstruction(source, dest, vaultPk, amount));
      tx.partialSign(vault);
      const sig = await sendAndConfirm(connection, tx, tag);
      const recorded = await recordPayout(w.id, amount.toString(), sig);
      log(`${tag}: paid ${amount.toString()} raw${recorded ? '' : ' (already recorded)'}`);
    } catch (e) {
      warn(`${tag}: payout failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main(): Promise<void> {
  const network = (env('NEXT_PUBLIC_SOLANA_NETWORK') || env('SOLANA_NETWORK') || 'devnet').toLowerCase();
  const isDevnet = network !== 'mainnet-beta' && network !== 'mainnet';

  const vault = loadVaultKeypair();
  const vaultAddr = requiredEnv('BOUNTY_VAULT_WALLET', 'NEXT_PUBLIC_BOUNTY_VAULT_WALLET');
  if (new PublicKey(vaultAddr).toBase58() !== vault.publicKey.toBase58()) {
    throw new Error('[bounty-keeper] BOUNTY_VAULT_WALLET does not match BOUNTY_VAULT_SECRET');
  }
  log(`vault ${vault.publicKey.toBase58()} on ${isDevnet ? 'devnet' : 'mainnet'}`);

  const connection = createFailoverConnection();
  const now = Date.now();

  // 1. Snapshots for every active bounty.
  const active = await listActiveBounties();
  log(`${active.length} active bountie(s)`);
  let snapshotted = 0;
  for (const bounty of active) {
    try {
      const n = await snapshotBounty(bounty.id);
      snapshotted += n;
      log(`bounty ${bounty.id}: ${n} snapshot(s)`);
    } catch (e) {
      warn(`bounty ${bounty.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. Finalize rounds past ends_at.
  await finalizeDue(now);

  // 3. Pay bound, unpaid winners.
  await payWinners(connection, vault);

  log(`done: ${snapshotted} snapshot(s)`);
}

main().catch((e) => {
  console.error('[bounty-keeper] fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
