// Runtime probe: fetch the devnet spike DBC pool and print its fields + computed price.
// Usage: node scripts/probe-pool.cjs [poolAddress]
const { Connection, PublicKey } = require('@solana/web3.js');
const dbc = require('@meteora-ag/dynamic-bonding-curve-sdk');

const POOL = process.argv[2] || '79NyTpth6aGUePHRMgckCA7pRotpbAPXwfGexoXv167v';
const RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

function dump(name, v, depth) {
  if (depth > 2) return;
  if (v && typeof v === 'object' && v.constructor && v.constructor.name === 'BN') {
    console.log(' '.repeat(depth * 2) + name + ' = BN(' + v.toString() + ')');
    return;
  }
  if (v instanceof PublicKey) {
    console.log(' '.repeat(depth * 2) + name + ' = Pubkey(' + v.toBase58() + ')');
    return;
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    console.log(' '.repeat(depth * 2) + name + ':');
    for (const k of Object.keys(v)) dump(k, v[k], depth + 1);
    return;
  }
  console.log(' '.repeat(depth * 2) + name + ' = ' + String(v).slice(0, 80));
}

(async () => {
  const connection = new Connection(RPC, 'confirmed');
  const client = new dbc.DynamicBondingCurveClient(connection, 'confirmed');
  const pool = await client.state.getPool(new PublicKey(POOL));
  if (!pool) { console.log('POOL NOT FOUND'); process.exit(1); }
  console.log('=== VirtualPool fields ===');
  dump('pool', pool, 0);

  // Config for graduation threshold
  let config = null;
  try {
    config = await client.state.getPoolConfig(pool.config);
    console.log('\n=== PoolConfig (partial) ===');
    dump('migrationQuoteThreshold', config.migrationQuoteThreshold, 0);
    dump('poolCreator', config.poolCreator, 0);
  } catch (e) { console.log('config fetch failed:', e.message); }

  // Decimals + price
  const baseMint = pool.baseMint.toBase58();
  const quoteMint = pool.quoteMint.toBase58();
  const baseInfo = await connection.getParsedAccountInfo(pool.baseMint);
  const quoteInfo = await connection.getParsedAccountInfo(pool.quoteMint);
  const baseDec = baseInfo.value.data.parsed.info.decimals;
  const quoteDec = quoteInfo.value.data.parsed.info.decimals;
  console.log('\nbaseMint', baseMint, 'decimals', baseDec);
  console.log('quoteMint', quoteMint, 'decimals', quoteDec);
  const price = dbc.getPriceFromSqrtPrice(pool.sqrtPrice, new dbc.TokenDecimal(baseDec), quoteDec);
  console.log('PRICE (quote per base) =', price.toString());
})().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
