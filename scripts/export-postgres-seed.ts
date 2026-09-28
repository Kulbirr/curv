/**
 * Export every table from the SQLite-era database (data/stockcurve.db)
 * into data/postgres-seed.json, which the Postgres layer imports once on
 * first boot (see src/lib/db/index.ts runSeedImport).
 *
 * Opens the database normally (not by copying the file) so the WAL
 * (data/stockcurve.db-wal) is read consistently — copying only the main
 * .db file would silently drop recent writes.
 *
 * Vanity pool secrets are exported EXACTLY as stored: encrypted blobs.
 * They are never decrypted here; the same VANITY_POOL_KEY must be set
 * wherever the seed is imported.
 *
 * Usage: npx tsx scripts/export-postgres-seed.ts
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'stockcurve.db');
const OUT_PATH = path.join(DATA_DIR, 'postgres-seed.json');

const TABLES = [
  'pools',
  'pool_states',
  'ticks',
  'nonces',
  'pool_verifications',
  'rate_limits',
  'vanity_pool',
] as const;

function main(): void {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[export] no SQLite database at ${DB_PATH}; nothing to export`);
    process.exit(1);
  }
  // Read-only open: the WAL is applied automatically, and we cannot
  // disturb a running indexer.
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const seed: Record<string, Array<Record<string, unknown>>> = {};
    for (const table of TABLES) {
      const exists = db
        .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { one: number } | undefined;
      if (!exists) {
        console.log(`[export] table ${table} missing — skipping`);
        seed[table] = [];
        continue;
      }
      const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Array<
        Record<string, unknown>
      >;
      // node:sqlite returns BLOBs as Uint8Array/Buffer; JSON-serialize as base64.
      const jsonSafe = rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          out[k] =
            v instanceof Uint8Array
              ? { __buffer_base64: Buffer.from(v).toString('base64') }
              : v;
        }
        return out;
      });
      seed[table] = jsonSafe;
      console.log(`[export] ${table}: ${rows.length} row(s)`);
    }
    fs.writeFileSync(OUT_PATH, JSON.stringify(seed));
    console.log(`[export] wrote ${OUT_PATH}`);
  } finally {
    db.close();
  }
}

main();
