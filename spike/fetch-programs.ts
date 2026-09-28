// Fetch upgradeable program binaries from devnet via RPC (Node respects the proxy).
import { Connection, PublicKey } from '@solana/web3.js'
import { writeFileSync, mkdirSync } from 'fs'

import { execSync } from 'child_process'

const RPC = (() => {
  try {
    const key = execSync(
      `grep "^HELIUS_API_KEY=" /home/hatch/workspace/worlds-fair/rugcheck-bot/.env | cut -d= -f2 | tr -d ' "\\r'`,
      { encoding: 'utf8' }
    ).trim()
    if (key) return `https://devnet.helius-rpc.com/?api-key=${key}`
  } catch {}
  return 'https://api.devnet.solana.com'
})()
const PROGRAMS = {
  'dbc.so': 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  'spl_token.so': 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ata.so': 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'metadata.so': 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
}

async function main() {
  const conn = new Connection(RPC, 'confirmed')
  mkdirSync('/tmp/spike-programs', { recursive: true })
  for (const [file, addr] of Object.entries(PROGRAMS)) {
    const progInfo = await conn.getAccountInfo(new PublicKey(addr))
    if (!progInfo) throw new Error(`program account not found: ${addr}`)
    // UpgradeableLoaderState::Program { programdata_address } — u32 tag 2 + 32 bytes
    const tag = progInfo.data.readUInt32LE(0)
    if (tag !== 2) throw new Error(`${addr}: not an upgradeable Program account (tag ${tag})`)
    const programdata = new PublicKey(progInfo.data.subarray(4, 36))
    const pdInfo = await conn.getAccountInfo(programdata)
    if (!pdInfo) throw new Error(`programdata not found for ${addr}`)
    const elf = pdInfo.data.subarray(45) // skip ProgramData metadata header
    if (elf[0] !== 0x7f || elf[1] !== 0x45) throw new Error(`${addr}: not ELF`)
    writeFileSync(`/tmp/spike-programs/${file}`, elf)
    console.log(`[ok] ${file}: ${elf.length} bytes (programdata ${programdata.toBase58()})`)
  }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
