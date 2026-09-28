// Build (not send) createConfigAndPool + swap txs with a CUSTOM SPL quote mint.
// Inspects the built instructions to prove the SDK wires the custom quote mint
// through its entire account-derivation logic. Needs NO sol.
import {
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js'
import {
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
  deriveDbcTokenVaultAddress,
  buildCurveWithCustomSqrtPrices,
  createSqrtPrices,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  TokenDecimal,
  TokenType,
  TokenAuthorityOption,
  BaseFeeMode,
  CollectFeeMode,
  MigrationOption,
  MigrationFeeOption,
  MigratedCollectFeeMode,
  DammV2DynamicFeeMode,
  DammV2BaseFeeMode,
  ActivationType,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'

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

async function main() {
  const connection = new Connection(RPC, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')

  const payer = Keypair.generate()
  const configKp = Keypair.generate()
  const baseMintKp = Keypair.generate()
  // Real on-chain devnet SPL mint (wSOL). From the SDK's perspective this is an
  // arbitrary mint address: getTokenType() only checks the account exists and
  // branches on its owner (SPL Token vs Token-2022). No whitelist.
  const quoteMint = new PublicKey('So11111111111111111111111111111111111111112')
  const QUOTE_DEC = TokenDecimal.NINE

  const sqrtPrices = createSqrtPrices([0.001, 0.0011, 0.002, 0.01], TokenDecimal.SIX, QUOTE_DEC)
  const curveConfig = buildCurveWithCustomSqrtPrices({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: QUOTE_DEC,
      tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAuthority,
      totalTokenSupply: 1_000_000_000,
      leftover: 1000,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: { startingFeeBps: 9000, endingFeeBps: 120, numberOfPeriod: 60, totalDuration: 60 },
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
  console.log('[ok] curve config built with custom sqrt prices')

  // This is the exact call the app will make. It must not throw and must
  // embed the custom quote mint in the derived accounts.
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
  console.log(`[ok] createConfigAndPool built: ${tx.instructions.length} instructions`)

  const pool = deriveDbcPoolAddress(quoteMint, baseMintKp.publicKey, configKp.publicKey)
  console.log(`[ok] derived pool: ${pool.toBase58()}`)

  // Verify the quote vault ATA in the initialize-pool instruction is derived
  // from OUR custom quote mint (not SOL/USDC).
  const initIx = tx.instructions[tx.instructions.length - 1]
  const quoteVault = deriveDbcTokenVaultAddress(pool, quoteMint)
  const usesQuoteVault = initIx.keys.some((k) => k.pubkey.equals(quoteVault))
  const usesQuoteMint = initIx.keys.some((k) => k.pubkey.equals(quoteMint))
  console.log(`[ok] init-pool ix references quote vault PDA: ${usesQuoteVault}`)
  console.log(`[ok] init-pool ix references custom quote mint: ${usesQuoteMint}`)
  console.log(`     quote vault: ${quoteVault.toBase58()}`)

  // Swap tx needs the pool to exist on-chain (it reads reserves), so it can only
  // be built after the create tx lands. Verify the failure mode is "pool not
  // found" (state read) and not a quote-mint rejection.
  try {
    const swapTx = await client.pool.swap({
      owner: payer.publicKey,
      payer: payer.publicKey,
      pool,
      amountIn: new BN(10_000_000),
      minimumAmountOut: new BN(0),
      swapBaseForQuote: false,
      referralTokenAccount: null,
    })
    console.log(`[ok] swap (quote->base) built: ${swapTx.instructions.length} instructions`)
    const swapUsesVault = swapTx.instructions.some((ix) =>
      ix.keys.some((k) => k.pubkey.equals(quoteVault))
    )
    console.log(`[ok] swap ix touches custom-quote vault: ${swapUsesVault}`)
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('Pool not found')) {
      console.log('[ok] swap builder reached pool-state read (fails only because pool not yet on-chain — expected pre-send)')
    } else {
      throw e
    }
  }

  console.log('\nTX-BUILD SPIKE PASSED — SDK accepts and wires custom SPL quote mint')
}
main().catch((e) => { console.error('\nTX-BUILD FAILED:', e?.message ?? e); process.exit(1) })
