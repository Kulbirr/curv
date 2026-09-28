import { Connection, PublicKey } from '@solana/web3.js'
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'

const key = execSync(
  `grep "^HELIUS_API_KEY=" /home/hatch/workspace/worlds-fair/rugcheck-bot/.env | cut -d= -f2 | tr -d ' "\\r'`,
  { encoding: 'utf8' }
).trim()
const c = new Connection(`https://devnet.helius-rpc.com/?api-key=${key}`, 'confirmed')

for (const a of [
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
]) {
  const i = await c.getAccountInfo(new PublicKey(a))
  if (!i) { console.log(a.slice(0, 12), 'MISSING'); continue }
  console.log(a.slice(0, 12), 'len', i.data.length, 'owner', i.owner.toBase58().slice(0, 12), 'exec', i.executable, 'head', i.data.subarray(0, 12).toString('hex'))
  // If upgradeable Program account, dump the ELF too
  if (i.data.readUInt32LE(0) === 3) {
    const pd = new PublicKey(i.data.subarray(4, 36))
    const pdi = await c.getAccountInfo(pd)
    if (pdi) {
      const elf = pdi.data.subarray(45)
      writeFileSync(`/tmp/spike-programs/${a.slice(0, 6)}.so`, elf)
      console.log('  dumped', elf.length, 'bytes')
    }
  } else if (i.executable && i.data[0] === 0x7f) {
    writeFileSync(`/tmp/spike-programs/${a.slice(0, 6)}.so`, i.data)
    console.log('  dumped raw ELF', i.data.length, 'bytes')
  }
}
