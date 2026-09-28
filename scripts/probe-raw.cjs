// Minimal raw probe with hard timeouts: fetch the pool account raw.
const { Connection, PublicKey } = require('@solana/web3.js');

const POOL = '79NyTpth6aGUePHRMgckCA7pRotpbAPXwfGexoXv167v';
const RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT ' + label)), ms)),
  ]);
}

(async () => {
  const connection = new Connection(RPC, 'confirmed');
  console.log('fetching account info...');
  const info = await withTimeout(connection.getAccountInfo(new PublicKey(POOL)), 25000, 'getAccountInfo');
  console.log('owner:', info.owner.toBase58(), 'dataLen:', info.data.length, 'lamports:', info.lamports);
  console.log('slot...');
  const slot = await withTimeout(connection.getSlot(), 25000, 'getSlot');
  console.log('slot:', slot);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
