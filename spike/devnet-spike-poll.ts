/**
 * StockCurve devnet spike v3 — DEVNET ONLY.
 * Every transaction is built manually and confirmed via REST polling (no websockets,
 * no spl-token internal senders). Idempotent via ../spike/spike-keys.json.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  getMinimumBalanceForRentExemptMint,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  createMintToInstruction,
} from '@solana/spl-token'
import {
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
  buildCurveWithCustomSqrtPrices,
  createSqrtPrices,
  TokenDecimal,
  TokenType,
  TokenAuthorityOption,
  BaseFeeMode,
  CollectFeeMode,
  ActivationType,
  MigrationOption,
  MigrationFeeOption,
  MigratedCollectFeeMode,
  DammV2DynamicFeeMode,
  DammV2BaseFeeMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import * as fs from 'fs'
import * as path from 'path'

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com'
const KEYS_FILE = path.resolve(process.cwd(), '../spike/spike-keys.json')
const QUOTE_DECIMALS = 6

function loadKeys(): Record<string, number[]> {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function saveKeys(k: Record<string, number[]>) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(k))
}
function getKp(store: Record<string, number[]>, name: string): Keypair {
  if (!store[name]) {
    store[name] = Array.from(Keypair.generate().secretKey)
    saveKeys(store)
  }
  return Keypair.fromSecretKey(Uint8Array.from(store[name]))
}

async function sendConfirmPoll(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  feePayer: PublicKey,
  label: string
): Promise<string> {
  let lastSig = ''
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { blockhash, lastValidBlockHeight } =
      await conn.getLatestBlockhash('confirmed')
    tx.recentBlockhash = blockhash
    tx.feePayer = feePayer
    tx.sign(...signers)
    lastSig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    })
    console.log(`[${label}] sent ${lastSig} (attempt ${attempt})`)
    const deadline = Date.now() + 75000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500))
      const { value } = await conn.getSignatureStatuses([lastSig])
      const st = value[0]
      if (st?.err)
        throw new Error(`[${label}] tx failed: ${JSON.stringify(st.err)}`)
      if (
        st &&
        (st.confirmationStatus === 'confirmed' ||
          st.confirmationStatus === 'finalized')
      ) {
        console.log(`[${label}] confirmed: ${lastSig}`)
        return lastSig
      }
      const bh = await conn.getBlockHeight('confirmed').catch(() => 0)
      if (bh > lastValidBlockHeight + 3) {
        console.log(`[${label}] blockhash expired, retrying`)
        break
      }
    }
  }
  throw new Error(`[${label}] not confirmed after retries (last sig ${lastSig})`)
}

async function main() {
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.SPIKE_PAYER!, 'utf8')))
  )
  console.log(`payer: ${payer.publicKey.toBase58()}`)
  const conn = new Connection(RPC, 'confirmed')
  const client = new DynamicBondingCurveClient(conn, 'confirmed')
  const bal = await conn.getBalance(payer.publicKey)
  console.log(`payer balance: ${bal / LAMPORTS_PER_SOL} SOL`)

  const store = loadKeys()
  const configKp = getKp(store, 'config')
  const baseMintKp = getKp(store, 'baseMint')
  const quoteMintKp = getKp(store, 'quoteMint')
  const quoteMint = quoteMintKp.publicKey
  console.log(`config:   ${configKp.publicKey.toBase58()}`)
  console.log(`baseMint: ${baseMintKp.publicKey.toBase58()}`)
  console.log(`quoteMint: ${quoteMint.toBase58()}`)

  // --- step 1: dummy CUSTOM SPL quote mint (stands in for a tokenized stock) ---
  if (!(await conn.getAccountInfo(quoteMint))) {
    const lamports = await getMinimumBalanceForRentExemptMint(conn)
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: quoteMint,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        quoteMint,
        QUOTE_DECIMALS,
        payer.publicKey,
        null,
        TOKEN_PROGRAM_ID
      )
    )
    await sendConfirmPoll(conn, tx, [payer, quoteMintKp], payer.publicKey, 'create quote mint')
  } else {
    console.log('[ok] quote mint already exists, reusing')
  }

  // --- step 2: payer ATA + mint 1M dummy quote tokens ---
  const ata = await getAssociatedTokenAddress(quoteMint, payer.publicKey)
  if (!(await conn.getAccountInfo(ata))) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        payer.publicKey,
        quoteMint
      )
    )
    await sendConfirmPoll(conn, tx, [payer], payer.publicKey, 'create quote ATA')
  }
  {
    const tx = new Transaction().add(
      createMintToInstruction(
        quoteMint,
        ata,
        payer.publicKey,
        BigInt(1_000_000 * 10 ** QUOTE_DECIMALS)
      )
    )
    await sendConfirmPoll(conn, tx, [payer], payer.publicKey, 'mint quote tokens')
    console.log('[ok] minted 1,000,000 dummy quote tokens to payer')
  }

  // --- step 3: DBC config + pool with the CUSTOM quote mint (idempotent) ---
  const existing = await client.state.getPoolConfig(configKp.publicKey).catch(() => null)
  if (!existing) {
    const sqrtPrices = createSqrtPrices(
      [0.001, 0.0011, 0.002, 0.01],
      TokenDecimal.SIX,
      QUOTE_DECIMALS
    )
    const curveConfig = buildCurveWithCustomSqrtPrices({
      token: {
        tokenType: TokenType.SPLToken,
        tokenBaseDecimal: TokenDecimal.SIX,
        tokenQuoteDecimal: QUOTE_DECIMALS,
        tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAuthority,
        totalTokenSupply: 1_000_000_000,
        leftover: 1000,
      },
      fee: {
        baseFeeParams: {
          baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
          feeSchedulerParam: {
            startingFeeBps: 9000,
            endingFeeBps: 120,
            numberOfPeriod: 60,
            totalDuration: 60,
          },
        },
        dynamicFeeEnabled: true,
        collectFeeMode: CollectFeeMode.QuoteToken,
        creatorTradingFeePercentage: 0,
        poolCreationFee: 1,
        enableFirstSwapWithMinFee: false,
      },
      migration: {
        migrationOption: MigrationOption.MET_DAMM_V2,
        migrationFeeOption: MigrationFeeOption.Customizable,
        migrationFee: { feePercentage: 10, creatorFeePercentage: 50 },
        migratedPoolFee: {
          collectFeeMode: MigratedCollectFeeMode.QuoteToken,
          dynamicFee: DammV2DynamicFeeMode.Enabled,
          poolFeeBps: 120,
          baseFeeMode: DammV2BaseFeeMode.FeeTimeSchedulerLinear,
        },
      },
      liquidityDistribution: {
        partnerLiquidityPercentage: 0,
        partnerPermanentLockedLiquidityPercentage: 100,
        creatorLiquidityPercentage: 0,
        creatorPermanentLockedLiquidityPercentage: 0,
      },
      lockedVesting: {
        totalLockedVestingAmount: 0,
        numberOfVestingPeriod: 0,
        cliffUnlockAmount: 0,
        totalVestingDuration: 0,
        cliffDurationFromMigrationTime: 0,
      },
      activationType: ActivationType.Timestamp,
      sqrtPrices,
      liquidityWeights: [2, 1, 1],
    })
    console.log('[ok] curve config built')

    const tx = await client.partner.createConfigAndPool({
      config: configKp.publicKey,
      feeClaimer: payer.publicKey,
      leftoverReceiver: payer.publicKey,
      payer: payer.publicKey,
      quoteMint,
      ...curveConfig,
      preCreatePoolParam: {
        baseMint: baseMintKp.publicKey,
        name: 'Spike Token',
        symbol: 'SPK',
        uri: 'https://example.com/spike.json',
        poolCreator: payer.publicKey,
      },
    })
    const sig = await sendConfirmPoll(
      conn,
      tx,
      [payer, configKp, baseMintKp],
      payer.publicKey,
      'createConfigAndPool'
    )
    console.log(`[ok] createConfigAndPool tx: ${sig}`)
  } else {
    console.log('[ok] config already on-chain, skipping creation')
  }

  const pool = deriveDbcPoolAddress(
    quoteMint,
    baseMintKp.publicKey,
    configKp.publicKey
  )
  console.log(`[ok] pool address: ${pool.toBase58()}`)
  const poolConfig = await client.state.getPoolConfig(configKp.publicKey)
  const poolState = await client.state.getPool(pool)
  console.log(`[ok] config on-chain: ${poolConfig !== null}`)
  console.log(`[ok] pool on-chain: ${poolState !== null}`)
  if (poolConfig) {
    console.log(
      `[ok] config quoteMint is our custom mint: ${poolConfig.quoteMint.toBase58() === quoteMint.toBase58()}`
    )
  }

  // --- step 4: swap quote -> base on the custom-quote pool ---
  const amountIn = new BN(10 * 10 ** QUOTE_DECIMALS)
  const swapTx = await client.pool.swap({
    owner: payer.publicKey,
    payer: payer.publicKey,
    pool,
    amountIn,
    minimumAmountOut: new BN(0),
    swapBaseForQuote: false,
    referralTokenAccount: null,
  })
  const swapSig = await sendConfirmPoll(conn, swapTx, [payer], payer.publicKey, 'swap quote->base')
  console.log(`[ok] swap tx: ${swapSig}`)

  const status = await client.state.getPool(pool)
  console.log(`[ok] pool base reserve: ${status?.baseReserve?.toString()}`)
  console.log(`[ok] pool quote reserve: ${status?.quoteReserve?.toString()}`)

  console.log('\nALL SPIKE CHECKS PASSED — custom SPL quote mint works on devnet')
}

main().catch((e) => {
  console.error('\nSPIKE FAILED:', e?.message ?? e)
  process.exit(1)
})
