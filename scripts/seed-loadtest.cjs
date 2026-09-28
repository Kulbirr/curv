// Seeds N synthetic pools for load testing. Synthetic rows are marked with
// description = 'LOADTEST-SYNTHETIC' so they can be wiped afterwards.
// Run: node scripts/seed-loadtest.cjs [count]   (default 3000)
const { randomBytes } = require('crypto');
const bs58 = require('bs58').default;
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const COUNT = Math.max(1, parseInt(process.argv[2] || '3000', 10) || 3000);
const DB_PATH = path.join(__dirname, '..', 'data', 'stockcurve.db');

const addr = () => bs58.encode(randomBytes(32));
const QUOTES = [
  { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
];

const db = new DatabaseSync(DB_PATH);
const insert = db.prepare(
  `INSERT OR IGNORE INTO pools
   (pool_address, config_address, base_mint, quote_mint, base_symbol, base_name,
    quote_symbol, description, creator, created_at, verified)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'LOADTEST-SYNTHETIC', ?, ?, 0)`,
);
const now = Date.now();
let added = 0;
db.exec('BEGIN');
for (let i = 0; i < COUNT; i++) {
  const q = QUOTES[i % QUOTES.length];
  const r = insert.run(
    addr(),
    addr(),
    addr(),
    q.mint,
    `T${i}`,
    `Load Test Token ${i}`,
    q.symbol,
    addr(),
    now - Math.floor(Math.random() * 30 * 24 * 3600_000),
  );
  added += r.changes;
}
db.exec('COMMIT');
const total = db.prepare('SELECT COUNT(*) AS c FROM pools').get().c;
console.log(`inserted ${added} synthetic pools (${total} total in registry)`);
db.close();
