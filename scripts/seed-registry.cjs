// Seeds the pool registry (data/stockcurve.db) with the devnet spike pool.
// Idempotent: INSERT OR IGNORE on the pool_address primary key.
// Run: node scripts/seed-registry.cjs   (or: npm run seed)
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'stockcurve.db');

const SEED = {
  poolAddress: '79NyTpth6aGUePHRMgckCA7pRotpbAPXwfGexoXv167v',
  configAddress: '6GVmjQ39GLzznfJiN5YqL58dr4STFL3QRd7phU1vPjTN',
  baseMint: '9x7XJeNLZmRzQiSaPbcgyhxkxPUibAVWb6CFyDPHL8Pt',
  quoteMint: '5KUTva3hjo1YQ6nauS96gZKZFkR2Mxw7CKzacemMHtfS',
  baseSymbol: 'TEST',
  baseName: 'Devnet Spike Token',
  quoteSymbol: 'TQUOTE',
  description: 'Devnet feasibility pool: custom quote mint on a Meteora DBC curve.',
  creator: '4zmTkFjKrcYyy5B5s116vJAxxMwuvfpjZuUTv6xJe9Rz',
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
// Same portable schema as src/lib/db/index.ts (subset needed for seeding).
db.exec(`CREATE TABLE IF NOT EXISTS pools (
  pool_address TEXT PRIMARY KEY, config_address TEXT NOT NULL,
  base_mint TEXT NOT NULL, quote_mint TEXT NOT NULL,
  base_symbol TEXT NOT NULL, base_name TEXT NOT NULL, quote_symbol TEXT NOT NULL,
  description TEXT, image_url TEXT, website TEXT, twitter TEXT,
  creator TEXT NOT NULL, created_at INTEGER NOT NULL,
  launched_at INTEGER, verified INTEGER NOT NULL DEFAULT 0
);`);
const res = db
  .prepare(
    `INSERT OR IGNORE INTO pools
     (pool_address, config_address, base_mint, quote_mint, base_symbol, base_name,
      quote_symbol, description, creator, created_at, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  .run(
    SEED.poolAddress, SEED.configAddress, SEED.baseMint, SEED.quoteMint,
    SEED.baseSymbol, SEED.baseName, SEED.quoteSymbol,
    SEED.description, SEED.creator, Date.now(),
  );
console.log(res.changes === 1 ? 'seeded devnet spike pool' : 'already seeded');
db.close();
