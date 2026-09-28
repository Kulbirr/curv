/**
 * StockCurve devnet spike — DEVNET ONLY.
 * Tests: DBC config + pool creation with a CUSTOM SPL quote mint.
 * Throwaway keypairs, devnet airdrop SOL. Nothing touches mainnet.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
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

function loadOrGen(pathEnv: string | undefined): Keypair {
  if (pathEnv) {
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(pathEnv, 'utf8')))
    return Keypair.fromSecretKey(secret)
  }
  return Keypair.generate()
}

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com'
const QUOTE_DECIMALS = 6 // dummy quote mint decimals
const BASE_DECIMALS = 6

async function airdrop(conn: Connection, pubkey: PublicKey, label: string) {
  let lastErr: unknown
  for (let i = 1; i <= 6; i++) {
    try {
      const sig = await conn.requestAirdrop(pubkey, 2 * LAMPORTS_PER_SOL)
      await conn.confirmTransaction(sig, 'confirmed')
      console.log(`[ok] airdropped 2 SOL to ${label} (${pubkey.toBase58()})`)
      return
    } catch (e) {
      lastErr = e
      console.log(`[retry ${i}/6] airdrop failed, waiting ${i * 10}s...`)
      await new Promise((r) => setTimeout(r, i * 10000))
    }
  }
  throw new Error(
    `airdrop to ${pubkey.toBase58()} failed: ${(lastErr as Error)?.message ?? lastErr}`
  )
}

async function main() {
  const connection = new Connection(RPC, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')

  // 1. throwaway keypairs (reuse funded ones via env to dodge faucet limits)
  const payer = loadOrGen(process.env.SPIKE_PAYER)
  const configKp = loadOrGen(process.env.SPIKE_CONFIG)
  const baseMintKp = loadOrGen(process.env.SPIKE_BASE_MINT)
  if (!process.env.SPIKE_PAYER) {
    fs.writeFileSync(
      '/tmp/stockcurve-spike-keys.json',
      JSON.stringify({
        payer: Array.from(payer.secretKey),
        note: 'THROWAWAY devnet keys — do not reuse',
      })
    )
  }

  const bal = await connection.getBalance(payer.publicKey)
  console.log(`payer balance: ${bal / LAMPORTS_PER_SOL} SOL`)
  if (bal < 1 * LAMPORTS_PER_SOL) {
    await airdrop(connection, payer.publicKey, 'payer')
  } else {
    console.log('[skip] payer funded, skipping faucet')
  }

  // 2. dummy CUSTOM SPL quote mint (stands in for a tokenized stock mint)
  const quoteMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    QUOTE_DECIMALS
  )
  console.log(`[ok] dummy quote mint: ${quoteMint.toBase58()}`)
  const payerQuoteAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    quoteMint,
    payer.publicKey
  )
  await mintTo(
    connection,
    payer,
    quoteMint,
    payerQuoteAta.address,
    payer.publicKey,
    1_000_000 * 10 ** QUOTE_DECIMALS
  )
  console.log(`[ok] minted 1,000,000 dummy quote tokens to payer`)

  // 3. curve config — same shape as SDK's own test config, quote decimals = 6
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

  // 4. create config + pool in ONE transaction (custom quote mint!)
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
  tx.feePayer = payer.publicKey
  const sig = await sendAndConfirmTransaction(connection, tx, [
    payer,
    configKp,
    baseMintKp,
  ])
  console.log(`[ok] createConfigAndPool tx: ${sig}`)

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
      `[ok] config quoteMint matches dummy: ${poolConfig.quoteMint.toBase58() === quoteMint.toBase58()}`
    )
  }

  // 5. swap test: buy base tokens with dummy quote tokens
  const amountIn = new BN(10 * 10 ** QUOTE_DECIMALS) // 10 quote tokens
  const swapTx = await client.pool.swap({
    owner: payer.publicKey,
    payer: payer.publicKey,
    pool,
    amountIn,
    minimumAmountOut: new BN(0),
    swapBaseForQuote: false, // quote -> base (buy)
    referralTokenAccount: null,
  })
  swapTx.feePayer = payer.publicKey
  const swapSig = await sendAndConfirmTransaction(connection, swapTx, [payer])
  console.log(`[ok] swap (quote->base) tx: ${swapSig}`)

  // 6. pool status after swap
  const status = await client.state.getPool(pool)
  console.log(`[ok] pool base reserve: ${status?.baseReserve?.toString()}`)
  console.log(`[ok] pool quote reserve: ${status?.quoteReserve?.toString()}`)

  console.log('\nALL SPIKE CHECKS PASSED — custom SPL quote mint works on devnet')
}

main().catch((e) => {
  console.error('\nSPIKE FAILED:', e?.message ?? e)
  if (e?.logs) console.error('logs:', e.logs.slice(-8).join('\n'))
  process.exit(1)
})
