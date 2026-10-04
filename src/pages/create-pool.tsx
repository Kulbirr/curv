import { useEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import bs58 from 'bs58'
import { useWallet } from '@solana/wallet-adapter-react'
import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import Page from '@/components/ui/Page/Page'
import CurvyLoader from '@/components/CurvyLoader'
import { CurveChart } from '../components/Launch/CurveChart'
import { ErrorList, Field, Toggle } from '../components/Launch/ui'
import {
  QuoteAssetPicker,
  type PickedQuoteAsset,
} from '@/components/QuoteAssetPicker'
import {
  CURVE_PRESETS,
  presetCurve,
  asCurvePresetId,
  type CurvePresetId,
} from '@/lib/presets'
import {
  buildCurveParams,
  buildLaunchTransaction,
  formatPriceInput,
  graduationThresholdQuote,
  QUICK_TARGET_START_FDV_USD,
  quickDefaultStartPrice,
  resolveEcon,
  scaleCurveToGraduationTarget,
  validateDevBuy,
  validateLaunchSpec,
  type LaunchEconOverrides,
  type LaunchSpec,
} from '@/lib/launch'
import {
  DEFAULT_QUICK_TIER_ID,
  QUICK_TIERS,
  quickTierById,
  quickTierCurveDesign,
  quickTierDisplayPrices,
  type QuickTierId,
} from '@/lib/launch-tiers'
import { buildDevBuyTransaction } from '@/lib/dev-buy'
import { BN } from '@coral-xyz/anchor'
import { getConnection, isDevnet, SOLANA_NETWORK } from '@/lib/solana'
import { getUsdcMint, inspectQuoteMint } from '@/lib/quote-assets'
import type { QuoteMintProgram } from '@/lib/quote-assets'
import { normalizeTwitterUrl } from '@/lib/twitter'
import { cn } from '@/lib/utils'
import { Keypair } from '@solana/web3.js'
import {
  VANITY_SUFFIX,
  estimateVanityMintAttempts,
  grindVanityMintParallel,
  type VanityMintResult,
  type VanityProgress,
} from '@/lib/vanity-mint'
import { fetchVanityHandout } from '@/lib/vanity-handout'
import { buildFeeDisclosureRows, buildFeeConsequenceLines, effectiveTradeFeeSplit, LAUNCH_FEE_CONFIG } from '@/lib/launch-fees'
import {
  isSignTimeout,
  signingTimeoutMessage,
  withSignTimeout,
} from '@/lib/sign-timeout'

const SOL_MINT = 'So11111111111111111111111111111111111111112'
/** Network-aware USDC: devnet USDC on devnet, mainnet USDC on mainnet. */
const USDC_MINT = getUsdcMint(SOLANA_NETWORK)

type QuoteSel = 'SOL' | 'USDC' | 'custom'
type PresetSel = CurvePresetId | 'custom'
type TokenType = 'Token' | 'Tokenized Stock'

/** Pro designer initial curve: SOL-scaled Quick-style default (sane graduation). */
const PRO_INITIAL_START = quickDefaultStartPrice(200)
type LaunchStatus =
  | 'idle'
  | 'uploading'
  | 'grinding'
  | 'building'
  | 'signing'
  | 'sending'
  | 'confirming'
  | 'devbuy'
  | 'registering'
  | 'done'
  | 'error'

const STATUS_LABEL: Record<
  Exclude<LaunchStatus, 'idle' | 'done' | 'error'>,
  string
> = {
  uploading: 'Uploading metadata…',
  grinding: 'Preparing your vanity mint address…',
  building: 'Building launch transaction…',
  signing: 'Waiting for wallet signature…',
  sending: 'Sending transaction…',
  confirming: 'Confirming on-chain…',
  devbuy: 'Executing your dev buy…',
  registering: 'Registering pool…',
}

import {
  buildRegistrationMessage,
  buildMetadataUploadMessage,
} from '@/lib/signature-messages'
import { validateFeeSplits } from '@/lib/fee-split-terms'
import type { FeeSplitRecipient } from '@/lib/fee-split-terms'

function parsePositiveFloat(s: string): number | null {
  const v = parseFloat(s)
  return Number.isFinite(v) && v > 0 ? v : null
}

function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr
}

/** Rough ETA text for the vanity grind progress indicator. */
function vanityEta(p: VanityProgress): string {
  if (p.attemptsPerSecond <= 0) return '…'
  const remaining =
    Math.max(0, estimateVanityMintAttempts(VANITY_SUFFIX) - p.attempts) /
    p.attemptsPerSecond
  if (remaining < 90) return `${Math.max(1, Math.ceil(remaining))}s left`
  return `~${(remaining / 60).toFixed(1)} min left`
}

const DRAFT_KEY = 'curv.launch-draft.v1'

interface LaunchDraft {
  mode?: 'quick' | 'pro'
  step?: 1 | 2 | 3
  quickTierId?: QuickTierId
  name: string
  symbol: string
  description: string
  twitter: string
  tokenType: TokenType
  underlying: string
  preset: PresetSel
  startPrice: string
  prices: string[]
  weights: string[]
  quoteSel: QuoteSel
  customMint: string
  customDecimals: string
  customSymbol: string
  baseDecimals: 6 | 9
  totalSupply: string
  startFeeBps: string
  endFeeBps: string
  feePeriods: string
  feeDuration: string
  dynamicFee: boolean
  migrationFeePct: string
  dammFeeBps: string
  dammDynamicFee: boolean
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 2 || v.length > 10) return null
  if (!v.every((x) => typeof x === 'string')) return null
  return v as string[]
}

export default function CreatePool() {
  const router = useRouter()
  const { publicKey, signTransaction, signMessage } = useWallet()
  const { setShowModal: setWalletModalVisible } = useUnifiedWalletContext()

  // ---- Token identity ----
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [twitter, setTwitter] = useState('')
  const [imageDataUri, setImageDataUri] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)

  // ---- Token type ----
  const [tokenType, setTokenType] = useState<TokenType>('Token')
  const [underlying, setUnderlying] = useState('')
  // Field errors only render after the user has blurred (touched) that
  // specific field, so a fresh load (or a restored draft) never opens
  // with red errors on untouched fields. On launch attempt all fields
  // are marked touched so every problem is visible at once.
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const markTouched = (key: string) =>
    setTouched((t) => (t[key] ? t : { ...t, [key]: true }))
  const touchAll = () =>
    setTouched({
      name: true,
      symbol: true,
      description: true,
      twitter: true,
      underlying: true,
      quoteMint: true,
      quoteDecimals: true,
      devBuy: true,
    })
  const anyTouched = (keys: string[]) => keys.some((k) => touched[k])

  // ---- Curve ----
  const [preset, setPreset] = useState<PresetSel>('exponential')
  const [startPrice, setStartPrice] = useState(() => formatPriceInput(PRO_INITIAL_START))
  const [prices, setPrices] = useState<string[]>(() =>
    presetCurve('exponential', PRO_INITIAL_START).prices.map(formatPriceInput)
  )
  const [weights, setWeights] = useState<string[]>(() =>
    new Array(presetCurve('exponential', PRO_INITIAL_START).prices.length - 1).fill('1')
  )

  // ---- Economics ----
  const [quoteSel, setQuoteSel] = useState<QuoteSel>('SOL')
  const [customMint, setCustomMint] = useState('')
  const [customDecimals, setCustomDecimals] = useState('6')
  const [customSymbol, setCustomSymbol] = useState('')
  /** Asset chosen from the verified directory (drives warnings + price hints). */
  const [pickedAsset, setPickedAsset] = useState<PickedQuoteAsset | null>(null)
  /** On-chain token-program inspection of the custom quote mint. */
  const [mintSupport, setMintSupport] = useState<QuoteMintProgram | null>(null)
  useEffect(() => {
    if (quoteSel !== 'custom') {
      setMintSupport(null)
      return
    }
    const mint = customMint.trim()
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      setMintSupport(null)
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const res = await inspectQuoteMint(getConnection(), mint)
        if (!cancelled) setMintSupport(res)
      } catch {
        if (!cancelled) setMintSupport(null)
      }
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [quoteSel, customMint])
  /** Live SOL USD price for scaling Quick defaults; falls back to 200. */
  const [solUsd, setSolUsd] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch('/api/quote-directory')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || !Array.isArray(d.assets)) return
        const sol = d.assets.find((a: { symbol?: string }) => a.symbol === 'SOL')
        const p = Number(sol?.usdPrice)
        if (Number.isFinite(p) && p > 0) setSolUsd(p)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  /** Wizard step: 1 = coin, 2 = pair and raise, 3 = economics and launch. */
  const [step, setStep] = useState<1 | 2 | 3>(1)
  /** Quick-launch graduation tier. $38K cruise is the default. Declared
   *  before quickCurve because the curve is built from the tier. */
  const [quickTierId, setQuickTierId] =
    useState<QuickTierId>(DEFAULT_QUICK_TIER_ID)
  /** USD price of the selected quote asset, for scaling Quick defaults. */
  const quoteUsdForDefault =
    quoteSel === 'SOL' ? (solUsd ?? 200) : quoteSel === 'USDC' ? 1 : (pickedAsset?.usdPrice ?? 1)
  /** Quick-launch curve, scaled so every pair starts near $5k valuation.
   *  The on-chain curve runs 1.5x past the tier's graduation price; the
   *  migration threshold is calibrated to the exact advertised cap. */
  const quickCurve = useMemo(
    () =>
      quickTierCurveDesign(
        quickDefaultStartPrice(quoteUsdForDefault),
        quickTierById(quickTierId)
      ),
    [quoteUsdForDefault, quickTierId]
  )
  /** Manual mint entry, kept for devnet test mints and unlisted assets. */
  const [manualQuote, setManualQuote] = useState(true)
  const [baseDecimals, setBaseDecimals] = useState<6 | 9>(6)
  const [totalSupply, setTotalSupply] = useState('1000000000')
  const [startFeeBps, setStartFeeBps] = useState('119')
  const [endFeeBps, setEndFeeBps] = useState('119')
  // ---- Fee schedule decay ----
  const [feePeriods, setFeePeriods] = useState('60')
  const [feeDuration, setFeeDuration] = useState('60')
  const [dynamicFee, setDynamicFee] = useState(true)
  // ---- Graduation & migration ----
  const [migrationFeePct, setMigrationFeePct] = useState('4')
  const [dammFeeBps, setDammFeeBps] = useState('120')
  const [dammDynamicFee, setDammDynamicFee] = useState(true)
  const [gradTarget, setGradTarget] = useState('')

  // ---- Launch ----
  const [metadataConfigured, setMetadataConfigured] = useState<boolean | null>(
    null
  )
  const [manualUri, setManualUri] = useState('')
  const [status, setStatus] = useState<LaunchStatus>('idle')
  const [mode, setMode] = useState<'quick' | 'pro'>('quick')
  const [splitRows, setSplitRows] = useState<
    Array<{ wallet: string; percent: string; handle: string }>
  >([])
  const [devBuy, setDevBuy] = useState('')
  const [buybackPct, setBuybackPct] = useState('0')
  const [traderRewardEnabled, setTraderRewardEnabled] = useState(false)
  const [traderRewardCount, setTraderRewardCount] = useState('3')
  const [traderRewardPct, setTraderRewardPct] = useState('')
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [txSig, setTxSig] = useState<string | null>(null)
  const [launchedPool, setLaunchedPool] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  // ---- Vanity mint (server pool handout at launch, local grind fallback) ----
  // The page opens with a LOCAL background grind only. A pre-ground
  // "...curv" keypair is claimed from the server pool at launch
  // confirmation, never on page open, so casual visits never burn pool
  // addresses. On any handout failure, 503 pool dry, 429, network, we use
  // the local grind (usually finished while the user designs the curve).
  const [vanityProgress, setVanityProgress] = useState<VanityProgress | null>(
    null
  )
  const [vanityReadyAddress, setVanityReadyAddress] = useState<string | null>(
    null
  )
  /** Where the ready keypair came from: server pool or local grind. */
  const [vanitySource, setVanitySource] = useState<'pool' | 'grind' | null>(
    null
  )
  const vanityCtrlRef = useRef<AbortController | null>(null)
  const vanityPromiseRef = useRef<Promise<VanityMintResult> | null>(null)
  const vanityKeypairRef = useRef<Keypair | null>(null)
  const vanityRunRef = useRef(0)

  function startLocalGrind(run: number) {
    const ctrl = new AbortController()
    vanityCtrlRef.current = ctrl
    const p = grindVanityMintParallel({
      suffix: VANITY_SUFFIX,
      signal: ctrl.signal,
      onProgress: (pr) => setVanityProgress(pr),
    })
    vanityPromiseRef.current = p
    p.then(
      (res) => {
        // Stale result from a superseded grind run, ignore it.
        if (vanityPromiseRef.current !== p || vanityRunRef.current !== run)
          return
        vanityKeypairRef.current = res.keypair
        setVanityReadyAddress(res.keypair.publicKey.toBase58())
        setVanitySource('grind')
        setVanityProgress(null)
      },
      () => {
        // Aborted or failed: launch falls back to a random mint.
        if (vanityPromiseRef.current !== p || vanityRunRef.current !== run)
          return
        setVanityProgress(null)
      }
    )
  }

  /** Local-only background grind. The server pool is claimed at launch
   *  confirmation, never here, so opening the wizard costs the pool
   *  nothing. */
  function startVanityGrind() {
    const run = vanityRunRef.current + 1
    vanityRunRef.current = run
    vanityCtrlRef.current?.abort()
    setVanityReadyAddress(null)
    setVanityProgress(null)
    setVanitySource(null)
    vanityKeypairRef.current = null
    startLocalGrind(run)
  }

  useEffect(() => {
    startVanityGrind()
    return () => {
      vanityRunRef.current += 1 // invalidate any in-flight grind run
      vanityCtrlRef.current?.abort()
      vanityCtrlRef.current = null
    }
    // Run once on mount: the grind belongs to the wizard session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    fetch('/api/metadata')
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((j) => setMetadataConfigured(j.configured === true))
      .catch(() => setMetadataConfigured(false))
  }, [])

  // ---- derived quote ----
  const quoteMint =
    quoteSel === 'SOL'
      ? SOL_MINT
      : quoteSel === 'USDC'
        ? USDC_MINT
        : customMint.trim()
  const quoteDecimals =
    quoteSel === 'SOL'
      ? 9
      : quoteSel === 'USDC'
        ? 6
        : parseInt(customDecimals, 10)
  const quoteSymbol =
    quoteSel === 'SOL'
      ? 'SOL'
      : quoteSel === 'USDC'
        ? 'USDC'
        : customSymbol.trim().toUpperCase()

  // Description as it will be stored: the stock reference ticker is recorded
  // as plain text when the Tokenized Stock type is picked. It is a label on
  // the token page, it does not move the curve.
  const fullDescription = useMemo(() => {
    const base = description.trim()
    const ref =
      tokenType === 'Tokenized Stock' && underlying.trim()
        ? ` Stock reference: ${underlying.trim()}.`
        : ''
    return (base + ref).trim()
  }, [description, tokenType, underlying])

  // ---- curve helpers ----
  function applyPreset(id: CurvePresetId, sp: string) {
    const start = parsePositiveFloat(sp)
    if (start === null) return
    const c = presetCurve(id, start)
    setPreset(id)
    setStartPrice(sp)
    setPrices(c.prices.map(String))
    setWeights(c.liquidityWeights.map(String))
  }

  function updatePrice(i: number, v: string) {
    setPreset('custom')
    setPrices((p) => p.map((x, j) => (j === i ? v : x)))
  }

  function updateWeight(i: number, v: string) {
    setPreset('custom')
    setWeights((w) => w.map((x, j) => (j === i ? v : x)))
  }

  function addPoint() {
    if (prices.length >= 10) return
    const last = parsePositiveFloat(prices[prices.length - 1]) ?? 0
    setPreset('custom')
    setPrices((p) => [...p, String(last * 1.5 || 1)])
    setWeights((w) => [...w, '1'])
  }

  function removePoint() {
    if (prices.length <= 2) return
    setPreset('custom')
    setPrices((p) => p.slice(0, -1))
    setWeights((w) => w.slice(0, -1))
  }

  const priceNums = useMemo(() => prices.map((p) => parseFloat(p)), [prices])

  // ---- local curve validation (authoritative check lives in launch.ts) ----
  const curveErrors = useMemo(() => {
    const errs: string[] = []
    if (prices.length < 2 || prices.length > 10)
      errs.push('Curve needs 2-10 price points')
    for (let i = 0; i < prices.length; i++) {
      const v = priceNums[i]
      if (!Number.isFinite(v) || v <= 0) {
        errs.push(`Price point ${i + 1} must be a positive number`)
        break
      }
      if (i > 0 && v <= priceNums[i - 1]) {
        errs.push('Price points must strictly increase toward migration')
        break
      }
    }
    if (weights.length !== prices.length - 1)
      errs.push('Liquidity weights must match the curve segments')
    if (
      weights.some((w) => {
        const v = parseFloat(w)
        return !Number.isFinite(v) || v <= 0
      })
    )
      errs.push('Liquidity weights must be positive numbers')
    return errs
  }, [prices, priceNums, weights])

  const tokenErrors = useMemo(() => {
    const errs: string[] = []
    if (!name.trim()) errs.push('Token name is required')
    else if (name.trim().length > 32)
      errs.push('Token name must be 32 characters or less')
    if (!/^[A-Za-z0-9]{1,10}$/.test(symbol.trim()))
      errs.push('Symbol must be 1-10 alphanumeric characters')
    if (tokenType === 'Tokenized Stock' && !underlying.trim())
      errs.push(
        'Underlying stock ticker is required for the Tokenized Stock type'
      )
    if (fullDescription.length > 500)
      errs.push('Description must be 500 characters or less')
    if (twitter.trim() && !normalizeTwitterUrl(twitter))
      errs.push('X handle must look like @handle or x.com/handle')
    return errs
  }, [name, symbol, tokenType, underlying, fullDescription, twitter])

  const quoteErrors = useMemo(() => {
    const errs: string[] = []
    if (quoteSel === 'custom') {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(customMint.trim()))
        errs.push('Custom quote mint is not a valid address')
      const d = parseInt(customDecimals, 10)
      if (!Number.isInteger(d) || d < 0 || d > 9)
        errs.push('Quote decimals must be 0-9')
      if (!/^[A-Za-z0-9]{1,10}$/.test(customSymbol.trim()))
        errs.push('Quote symbol must be 1-10 alphanumeric characters')
    }
    return errs
  }, [quoteSel, customMint, customDecimals, customSymbol])

  const econErrors = useMemo(() => {
    const errs: string[] = []
    const supply = parseFloat(totalSupply)
    if (!Number.isFinite(supply) || supply < 1_000 || supply > 1e15)
      errs.push('Total supply must be between 1,000 and 1,000,000,000,000,000')
    const sf = parseInt(startFeeBps, 10)
    const ef = parseInt(endFeeBps, 10)
    if (!Number.isInteger(sf) || sf < 25 || sf > 9900)
      errs.push('Starting fee must be 25-9900 bps')
    if (!Number.isInteger(ef) || ef < 25 || ef > 9900)
      errs.push('Ending fee must be 25-9900 bps')
    if (Number.isInteger(sf) && Number.isInteger(ef) && ef > sf)
      errs.push('Ending fee cannot exceed the starting fee')
    const fp = parseInt(feePeriods, 10)
    const fd = parseInt(feeDuration, 10)
    if (!Number.isInteger(fp) || fp < 1)
      errs.push('Fee decay periods must be a whole number of 1 or more')
    if (!Number.isInteger(fd) || fd < fp)
      errs.push(
        'Fee decay duration must be a whole number of slots, at least the number of periods'
      )
    const mf = parseInt(migrationFeePct, 10)
    if (!Number.isInteger(mf) || mf < 0 || mf > 99)
      errs.push('Migration fee must be a whole percent between 0 and 99')
    const df = parseInt(dammFeeBps, 10)
    if (!Number.isInteger(df) || df < 10 || df > 1000)
      errs.push('Post-graduation pool fee must be 10-1000 bps')
    return errs
  }, [
    totalSupply,
    startFeeBps,
    endFeeBps,
    feePeriods,
    feeDuration,
    migrationFeePct,
    dammFeeBps,
  ])

  function buildSpec(metadataUri: string): LaunchSpec {
    // Quick launch always builds on the proven defaults, no matter what a
    // Pro draft holds. The quote pair is the one setting quick mode lets
    // you change, so it follows the picker's state in both modes.
    const quick = mode === 'quick'
    return {
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(),
      description: fullDescription || undefined,
      metadataUri,
      quoteMint,
      quoteDecimals,
      quoteSymbol,
      baseDecimals: quick ? 9 : baseDecimals,
      totalSupply: quick ? 1_000_000_000 : parseFloat(totalSupply),
      curve: quick
        ? {
            prices: quickCurve.prices,
            liquidityWeights: quickCurve.liquidityWeights,
          }
        : {
            prices: priceNums,
            liquidityWeights: weights.map((w) => parseFloat(w)),
          },
      startingFeeBps: quick ? 119 : parseInt(startFeeBps, 10),
      endingFeeBps: quick ? 119 : parseInt(endFeeBps, 10),
      // The tier calibrates migrationQuoteThreshold to the exact
      // advertised cap while the curve keeps headroom past it.
      quickTierId: quick ? quickTierId : undefined,
      econ: quick
        ? {
            feeSchedulerPeriods: 60,
            feeSchedulerTotalDuration: 60,
            dynamicFeeEnabled: true,
            migrationFeePercent: 4,
            migratedPoolFeeBps: 120,
            migratedPoolDynamicFee: true,
          }
        : buildEcon(),
    }
  }

  function buildEcon(): LaunchEconOverrides {
    return {
      feeSchedulerPeriods: parseInt(feePeriods, 10),
      feeSchedulerTotalDuration: parseInt(feeDuration, 10),
      dynamicFeeEnabled: dynamicFee,
      migrationFeePercent: parseInt(migrationFeePct, 10),
      migratedPoolFeeBps: parseInt(dammFeeBps, 10),
      migratedPoolDynamicFee: dammDynamicFee,
    }
  }

  // Graduation threshold preview: real SDK math, shown only when the spec is valid.
  const graduationPreview = useMemo(() => {
    try {
      const spec = buildSpec('https://placeholder.invalid/metadata.json')
      return graduationThresholdQuote(spec)
    } catch {
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    quickCurve,
    quickTierId,
    name,
    symbol,
    quoteMint,
    quoteDecimals,
    quoteSymbol,
    baseDecimals,
    totalSupply,
    priceNums,
    weights,
    startFeeBps,
    endFeeBps,
    feePeriods,
    feeDuration,
    dynamicFee,
    migrationFeePct,
    dammFeeBps,
    dammDynamicFee,
  ])

  function fmtNum(v: number): string {
    return v.toLocaleString('en-US', { maximumFractionDigits: 4 })
  }

  // Fee disclosure: every number comes from the effective economics (the
  // same constants the on-chain config is built from) or the user's own
  // fee-schedule inputs, nothing invented.
  const feeRows = useMemo(
    () =>
      buildFeeDisclosureRows({
        startingFeeBps: mode === 'quick' ? 119 : parseInt(startFeeBps, 10) || 0,
        endingFeeBps: mode === 'quick' ? 119 : parseInt(endFeeBps, 10) || 0,
        quoteSymbol,
        econ: resolveEcon(
          buildSpec('https://placeholder.invalid/metadata.json')
        ),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      mode,
      quickCurve,
      startFeeBps,
      endFeeBps,
      quoteSymbol,
      feePeriods,
      feeDuration,
      dynamicFee,
      migrationFeePct,
      dammFeeBps,
      dammDynamicFee,
    ]
  )

  // Concrete consequences of the fee config in plain numbers: every fee
  // translated into what it means for the creator. Nothing invented, all
  // computed from the effective economics and the SDK graduation threshold.
  const feeConsequences = useMemo(
    () =>
      buildFeeConsequenceLines({
        startingFeeBps: mode === 'quick' ? 119 : parseInt(startFeeBps, 10) || 0,
        graduationThreshold: graduationPreview,
        quoteSymbol,
        econ: resolveEcon(
          buildSpec('https://placeholder.invalid/metadata.json')
        ),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      mode,
      quickCurve,
      startFeeBps,
      quoteSymbol,
      graduationPreview,
      feePeriods,
      feeDuration,
      dynamicFee,
      migrationFeePct,
      dammFeeBps,
      dammDynamicFee,
    ]
  )

  /** Rescale the curve so its graduation threshold matches the target. */
  // Creator share of bonding-curve volume, recomputed when the Pro-mode fee
  // schedule changes so the locked-economics paragraph never lies.
  const lockedCreatorSharePct = useMemo(() => {
    const startBps = mode === 'quick' ? 119 : parseInt(startFeeBps, 10) || 0
    return effectiveTradeFeeSplit(startBps, LAUNCH_FEE_CONFIG).creator
  }, [mode, startFeeBps])
  function applyGraduationTarget() {
    const target = parseFloat(gradTarget)
    if (!Number.isFinite(target) || target <= 0) {
      setNotice('Enter a positive graduation target first.')
      return
    }
    try {
      const spec = buildSpec('https://placeholder.invalid/metadata.json')
      const specErrors = validateLaunchSpec(spec)
      if (specErrors.length > 0) {
        setNotice('Fix the errors above before matching a graduation target.')
        return
      }
      const rescaled = scaleCurveToGraduationTarget(spec, target)
      setPrices(rescaled.curve.prices.map(String))
      setNotice(
        `Curve rescaled to graduate at ~${target.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${quoteSymbol}.`
      )
    } catch {
      setNotice('Could not match that graduation target.')
    }
  }

  // ---- image picker ----
  async function onImageFile(file: File | undefined) {
    setImageError(null)
    if (!file) return
    if (
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
        file.type
      )
    ) {
      setImageError('Image must be PNG, JPEG, WebP or GIF')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setImageError('Image must be under 2 MB')
      return
    }
    const dataUri = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.onerror = () => reject(new Error('Could not read image'))
      r.readAsDataURL(file)
    })
    setImageDataUri(dataUri)
  }

  // ---- draft (this browser only; the image is never stored) ----
  function saveDraft() {
    const draft: LaunchDraft = {
      mode,
      step,
      quickTierId,
      name,
      symbol,
      description,
      twitter,
      tokenType,
      underlying,
      preset,
      startPrice,
      prices,
      weights,
      quoteSel,
      customMint,
      customDecimals,
      customSymbol,
      baseDecimals,
      totalSupply,
      startFeeBps,
      endFeeBps,
      feePeriods,
      feeDuration,
      dynamicFee,
      migrationFeePct,
      dammFeeBps,
      dammDynamicFee,
    }
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
      setNotice('Draft saved in this browser.')
    } catch {
      setNotice('Could not save the draft in this browser.')
    }
  }

  // ?preset= deep link + draft restore, once on mount.
  const initRef = useRef(false)
  useEffect(() => {
    if (!router.isReady || initRef.current) return
    initRef.current = true
    const id = asCurvePresetId(router.query.preset)
    if (id) {
      // Same as clicking the preset: rebuild the curve from it.
      applyPreset(id, startPrice)
      return
    }
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (!raw) return
      const d = JSON.parse(raw) as Partial<LaunchDraft>
      if (d.mode === 'quick' || d.mode === 'pro') setMode(d.mode)
      if (d.step === 1 || d.step === 2 || d.step === 3) setStep(d.step)
      if (d.quickTierId === 'sprint' || d.quickTierId === 'cruise' || d.quickTierId === 'marathon')
        setQuickTierId(d.quickTierId)
      if (typeof d.name === 'string') setName(d.name)
      if (typeof d.symbol === 'string') setSymbol(d.symbol)
      if (typeof d.description === 'string') setDescription(d.description)
      if (typeof d.twitter === 'string') setTwitter(d.twitter)
      if (d.tokenType === 'Tokenized Stock') setTokenType(d.tokenType)
      else if (d.tokenType === 'Token') setTokenType(d.tokenType)
      // Legacy drafts stored the old "Memecoin" label.
      else if ((d.tokenType as string) === 'Memecoin') setTokenType('Token')
      if (typeof d.underlying === 'string') setUnderlying(d.underlying)
      if (typeof d.startPrice === 'string') setStartPrice(d.startPrice)
      const dp = asStringArray(d.prices)
      const dw = asStringArray(d.weights)
      if (dp && dw && dw.length === dp.length - 1) {
        setPrices(dp)
        setWeights(dw)
        setPreset('custom')
      } else if (d.preset === 'custom' || asCurvePresetId(d.preset)) {
        setPreset(d.preset)
      }
      if (
        d.quoteSel === 'SOL' ||
        d.quoteSel === 'USDC' ||
        d.quoteSel === 'custom'
      )
        setQuoteSel(d.quoteSel)
      if (typeof d.customMint === 'string') setCustomMint(d.customMint)
      if (typeof d.customDecimals === 'string')
        setCustomDecimals(d.customDecimals)
      if (typeof d.customSymbol === 'string') setCustomSymbol(d.customSymbol)
      if (d.baseDecimals === 6 || d.baseDecimals === 9)
        setBaseDecimals(d.baseDecimals)
      if (typeof d.totalSupply === 'string') setTotalSupply(d.totalSupply)
      if (typeof d.startFeeBps === 'string') setStartFeeBps(d.startFeeBps)
      if (typeof d.endFeeBps === 'string') setEndFeeBps(d.endFeeBps)
      if (typeof d.feePeriods === 'string') setFeePeriods(d.feePeriods)
      if (typeof d.feeDuration === 'string') setFeeDuration(d.feeDuration)
      if (typeof d.dynamicFee === 'boolean') setDynamicFee(d.dynamicFee)
      if (typeof d.migrationFeePct === 'string')
        setMigrationFeePct(d.migrationFeePct)
      if (typeof d.dammFeeBps === 'string') setDammFeeBps(d.dammFeeBps)
      if (typeof d.dammDynamicFee === 'boolean')
        setDammDynamicFee(d.dammDynamicFee)
      setNotice('Restored your saved draft.')
    } catch {
      /* a corrupt draft is simply ignored */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady])

  // ---- launch flow ----
  async function pollConfirmation(sig: string): Promise<void> {
    const conn = getConnection()
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const st = await conn.getSignatureStatus(sig, {
        searchTransactionHistory: true,
      })
      const s = st?.value
      if (s?.err) throw new Error('Transaction failed on-chain')
      if (
        s &&
        (s.confirmationStatus === 'confirmed' ||
          s.confirmationStatus === 'finalized')
      )
        return
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error(
      'Transaction was sent but confirmation timed out, check Solscan before retrying.'
    )
  }

  async function handleLaunch() {
    // Launch is the only gate: mark every field touched so all errors
    // become visible, then block if anything is invalid.
    touchAll()
    const errs = [...tokenErrors, ...quoteErrors, ...econErrors]
    if (metadataConfigured === false && !manualUri.trim()) {
      errs.push('Metadata URI is required')
    }
    if (errs.length > 0) {
      setLaunchError(
        `Fix ${errs.length} ${errs.length === 1 ? 'issue' : 'issues'} before launching: ${errs[0]}`
      )
      return
    }
    if (!publicKey) {
      setWalletModalVisible(true)
      return
    }
    setLaunchError(null)
    setTxSig(null)
    try {
      // 1. Metadata URI
      setStatus('uploading')
      let metadataUri: string
      let imageUrl: string | undefined
      if (metadataConfigured) {
        // Authorize the R2 upload with a fresh wallet signature so the
        // metadata endpoint cannot be used as anonymous free storage.
        if (!signMessage)
          throw new Error('Connected wallet cannot sign messages')
        const uploadTimestamp = Date.now()
        const uploadMessage = buildMetadataUploadMessage(
          publicKey.toBase58(),
          uploadTimestamp
        )
        let uploadSigBytes: Uint8Array
        try {
          uploadSigBytes = await withSignTimeout(
            signMessage(new TextEncoder().encode(uploadMessage))
          )
        } catch (e) {
          if (isSignTimeout(e)) throw new Error(signingTimeoutMessage())
          throw new Error('Wallet did not sign the metadata upload')
        }
        const res = await fetch('/api/metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            symbol: symbol.trim().toUpperCase(),
            description: fullDescription,
            image: imageDataUri,
            wallet: publicKey.toBase58(),
            timestamp: uploadTimestamp,
            signature: bs58.encode(uploadSigBytes),
          }),
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error || 'Metadata upload failed')
        }
        const mu = (await res.json()) as { uri: string; imageUrl?: string }
        metadataUri = mu.uri
        // Prefer the image URL straight from the upload response. Re-fetching
        // the metadata JSON from the browser is CORS blocked by the R2 public
        // bucket, which used to drop the card image silently.
        if (
          typeof mu.imageUrl === 'string' &&
          mu.imageUrl.startsWith('https://')
        )
          imageUrl = mu.imageUrl
      } else {
        metadataUri = manualUri.trim()
        if (!/^https:\/\/[^/]+\/.+/.test(metadataUri))
          throw new Error('Enter a valid https metadata JSON URI')
      }
      // Best-effort fallback: if the upload response did not carry an image
      // URL (e.g. the manual URI path), try reading it out of the metadata.
      // The R2 public bucket sends no CORS headers, so this fetch fails from
      // the browser and the card falls back to a letter avatar.
      if (!imageUrl) {
        try {
          const mj = await (await fetch(metadataUri)).json()
          if (
            mj &&
            typeof mj.image === 'string' &&
            mj.image.startsWith('https://')
          )
            imageUrl = mj.image
        } catch {
          /* card falls back to a letter avatar */
        }
      }

      // 2. Spec + authoritative validation
      const spec = buildSpec(metadataUri)
      const errors = validateLaunchSpec(spec)
      if (errors.length > 0) throw new Error(errors[0])

      // 2.6 Optional dev buy, validated against the graduation threshold.
      // Empty means no dev buy.
      const devBuyCheck = validateDevBuy(
        devBuy,
        quoteDecimals,
        graduationThresholdQuote(spec)
      )
      if (devBuyCheck.ok === false) throw new Error(devBuyCheck.error)
      const devBuyLamports = devBuyCheck.lamports

      // 2.5 Vanity mint: claim a pre-ground address from the server pool
      // ONLY at launch confirmation, never on page open, so casual visits
      // never burn pool addresses. Then the background grind (usually
      // finished while the user was designing). If neither is ready, wait
      // here (progress + skip shown below); on skip or failure use a
      // random mint. Launch is never blocked.
      let baseMintKeypair: Keypair
      setStatus('grinding')
      try {
        const handed = await fetchVanityHandout()
        if (handed) {
          // Pool keypair won: stop the local grind, it is no longer needed.
          vanityCtrlRef.current?.abort()
          vanityCtrlRef.current = null
          vanityKeypairRef.current = handed
          setVanityReadyAddress(handed.publicKey.toBase58())
          setVanitySource('pool')
          baseMintKeypair = handed
        } else {
          const vp = vanityPromiseRef.current
          baseMintKeypair = vp ? (await vp).keypair : Keypair.generate()
        }
      } catch {
        baseMintKeypair = Keypair.generate()
      } finally {
        setVanityProgress(null)
      }

      // 3. Build the real createConfigAndPool transaction (fresh config
      //    keypair + the vanity (or fallback) base-mint keypair,
      //    partial-signed inside the builder)
      setStatus('building')
      const built = await buildLaunchTransaction(spec, publicKey, {
        baseMintKeypair,
      })
      const poolAddr = built.poolAddress.toBase58()
      // The mint keypair is now committed to this launch, restart the
      // LOCAL grind in the background in case the user launches again.
      // This claims nothing from the server pool.
      startVanityGrind()

      // 4. User signs as fee payer in their wallet
      if (!signTransaction)
        throw new Error('Connected wallet cannot sign transactions')
      setStatus('signing')
      let signed
      try {
        signed = await withSignTimeout(signTransaction(built.transaction))
      } catch (e) {
        if (isSignTimeout(e)) throw new Error(signingTimeoutMessage())
        throw new Error(
          'Wallet signing was rejected, no transaction was sent.'
        )
      }

      // 5. Send the raw signed transaction
      setStatus('sending')
      const sig = await getConnection().sendRawTransaction(signed.serialize())
      setTxSig(sig)

      // 6. Confirm via REST status polling
      setStatus('confirming')
      await pollConfirmation(sig)

      // 6.5 Optional dev buy: a second transaction in the same signing
      // session, executed right after pool creation confirms. The
      // creator's wallet signs everything; the server never holds funds
      // or keys. If the buy fails the launch stops here so the trust
      // panel never discloses a buy that did not happen.
      if (devBuyLamports !== null) {
        setStatus('devbuy')
        const devTx = await buildDevBuyTransaction({
          poolAddress: poolAddr,
          owner: publicKey,
          amountRaw: new BN(String(devBuyLamports)),
        })
        let devSigned
        try {
          devSigned = await withSignTimeout(signTransaction(devTx))
        } catch (e) {
          if (isSignTimeout(e)) throw new Error(signingTimeoutMessage())
          throw new Error(
            `Dev buy signing was rejected. Your pool is live at ${poolAddr}, but no dev buy was executed.`
          )
        }
        const devSig = await getConnection().sendRawTransaction(
          devSigned.serialize()
        )
        setStatus('confirming')
        try {
          await pollConfirmation(devSig)
        } catch (e) {
          throw new Error(
            `Dev buy could not be confirmed: ${e instanceof Error ? e.message : 'unknown error'}. ` +
              `Your pool is live at ${poolAddr}. Check Solscan before retrying the buy manually.`
          )
        }
      }

      // 7. Register with a wallet-signed message (server verifies ed25519).
      //    Fee splits, when set, are validated to the canonical form first
      //    and bound into the signed message, so the terms the server
      //    stores are exactly the terms the creator signed.
      setStatus('registering')
      const timestamp = Date.now()
      let normalizedSplits: FeeSplitRecipient[] | undefined
      const filledSplitRows = splitRows.filter(
        (r) => r.wallet.trim() || r.percent.trim() || r.handle.trim()
      )
      if (filledSplitRows.length > 0) {
        try {
          normalizedSplits = validateFeeSplits(
            filledSplitRows.map((r) => ({
              wallet: r.wallet.trim(),
              bps: Math.round(Number(r.percent) * 100),
              handle: r.handle.trim(),
            })),
            publicKey.toBase58()
          )
        } catch (e) {
          throw new Error(
            `Fee splits are invalid: ${e instanceof Error ? e.message : 'check the form'}`
          )
        }
      }
      const buybackBps = Math.round(parseFloat(buybackPct || '0') * 100) || 0
      let traderReward: { count: number; bps: number } | undefined
      if (traderRewardPreview.error) {
        throw new Error(`Trader rewards are invalid: ${traderRewardPreview.error}`)
      }
      if (traderRewardEnabled && traderRewardPreview.bps > 0) {
        traderReward = {
          count: traderRewardPreview.count,
          bps: traderRewardPreview.bps,
        }
      }
      const message = buildRegistrationMessage(
        poolAddr,
        publicKey.toBase58(),
        timestamp,
        normalizedSplits,
        devBuyLamports,
        buybackBps || undefined,
        traderReward ?? undefined
      )
      if (!signMessage) throw new Error('Connected wallet cannot sign messages')
      let sigBytes: Uint8Array
      try {
        sigBytes = await withSignTimeout(
          signMessage(new TextEncoder().encode(message))
        )
      } catch (e) {
        if (isSignTimeout(e)) throw new Error(signingTimeoutMessage())
        throw new Error(
          'Wallet did not sign the registration message, the pool was created on-chain but is not registered.'
        )
      }
      const regRes = await fetch('/api/pools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poolAddress: poolAddr,
          configAddress: built.configKeypair.publicKey.toBase58(),
          baseMint: built.baseMintKeypair.publicKey.toBase58(),
          quoteMint,
          creator: publicKey.toBase58(),
          baseSymbol: symbol.trim().toUpperCase(),
          baseName: name.trim(),
          quoteSymbol,
          quoteDecimals,
          baseDecimals,
          description: fullDescription || undefined,
          imageUrl,
          twitter: normalizeTwitterUrl(twitter) ?? undefined,
          timestamp,
          signature: bs58.encode(sigBytes),
          launchedAt: timestamp,
          feeSplits: normalizedSplits ?? undefined,
          devBuyLamports: devBuyLamports ?? undefined,
          buybackBps: Math.round(parseFloat(buybackPct || '0') * 100) || 0,
          traderReward: traderReward ?? undefined,
        }),
      })
      if (!regRes.ok) {
        const j = await regRes.json().catch(() => ({}))
        throw new Error(
          `Pool was created on-chain but registration failed: ${j.error || regRes.status}. ` +
            `Your pool is live at ${poolAddr}, save this address.`
        )
      }

      setLaunchedPool(poolAddr)
      setStatus('done')
      router.push(`/token/${poolAddr}`)
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : 'Launch failed')
      setStatus('error')
    }
  }

  const busy = status !== 'idle' && status !== 'error' && status !== 'done'
  const solscanTx = txSig
    ? `https://solscan.io/tx/${txSig}${isDevnet() ? '?cluster=devnet' : ''}`
    : null
  const curveMultiple =
    priceNums.length >= 2 &&
    priceNums[0] > 0 &&
    priceNums.every((p) => Number.isFinite(p) && p > 0)
      ? priceNums[priceNums.length - 1] / priceNums[0]
      : null
  const isCustom = preset === 'custom'
  const presetName = isCustom
    ? 'Custom'
    : (CURVE_PRESETS.find((p) => p.id === preset)?.name ?? 'Custom')
  /** Live validation of the fee split form: mirrors the server rules. */
  const splitPreview = useMemo(() => {
    const filled = splitRows.filter((r) => r.wallet.trim() || r.percent.trim() || r.handle.trim())
    if (filled.length === 0) return { error: null as string | null, totalBps: 0 }
    try {
      const validated = validateFeeSplits(
        filled.map((r) => ({
          wallet: r.wallet.trim(),
          bps: Math.round(Number(r.percent) * 100),
          handle: r.handle.trim(),
        })),
        publicKey?.toBase58() ?? ''
      )
      return {
        error: null as string | null,
        totalBps: validated.reduce((sum, r) => sum + r.bps, 0),
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Invalid fee splits', totalBps: 0 }
    }
  }, [splitRows, publicKey])

  // Trader rewards preview: validated live against the server rules so the
  // form shows the error before the user ever signs.
  const traderRewardPreview = useMemo(() => {
    if (!traderRewardEnabled)
      return { error: null as string | null, bps: 0, count: 0 }
    const count = Number(traderRewardCount)
    const bps = Math.round(Number(traderRewardPct) * 100)
    if (!Number.isInteger(count) || count < 1 || count > 5) {
      return { error: 'Winners must be between 1 and 5', bps: 0, count: 0 }
    }
    if (!Number.isFinite(bps) || bps < 1 || bps > 9000) {
      return {
        error: 'Reward share must be between 0.01% and 90%',
        bps: 0,
        count: 0,
      }
    }
    if (splitPreview.totalBps + bps > 9000) {
      return {
        error:
          'Fee splits and trader rewards together can use at most 90% of the creator fee',
        bps: 0,
        count: 0,
      }
    }
    return { error: null as string | null, bps, count }
  }, [traderRewardEnabled, traderRewardCount, traderRewardPct, splitPreview.totalBps])

  // Dev buy preview: validated live against the graduation threshold so
  // the form shows the error before the user ever signs.
  const devBuyPreview = useMemo(() => {
    const res = validateDevBuy(devBuy, quoteDecimals, graduationPreview)
    if (res.ok === false) return { error: res.error, lamports: null as number | null }
    return { error: null as string | null, lamports: res.lamports }
  }, [devBuy, quoteDecimals, graduationPreview])

  const allErrors = [
    ...tokenErrors,
    ...curveErrors,
    ...quoteErrors,
    ...econErrors,
  ]
  // Quick mode runs on proven defaults, so only the token fields and the
  // quote pair choice can block it.
  const activeErrors =
    mode === 'quick' ? [...tokenErrors, ...quoteErrors] : allErrors
  /** Honest wallet impact: creation fee plus the rent exempt deposits
   *  Solana locks for the new pool accounts. Displayed as an approx. */
  const deployTotalSol =
    LAUNCH_FEE_CONFIG.poolCreationFeeSol +
    LAUNCH_FEE_CONFIG.estimatedLaunchRentSol
  const deployTotalLabel = `≈${deployTotalSol.toFixed(2)} SOL`

  /** The selected Quick graduation tier. */
  const quickTier = quickTierById(quickTierId)
  /** Known USD price of the quote asset, or null when it has none. Quotes
   *  without a price never get a fabricated USD valuation: the UI shows
   *  the quote-denominated threshold instead. */
  const quoteUsdPriced: number | null =
    quoteSel === 'SOL'
      ? solUsd
      : quoteSel === 'USDC'
        ? 1
        : (pickedAsset?.usdPrice ?? null)
  /** Curve prices and label for the review card and the chart preview. */
  const reviewCurvePrices =
    mode === 'quick'
      ? quickTierDisplayPrices(
          quickDefaultStartPrice(quoteUsdForDefault),
          quickTier
        )
      : priceNums
  const reviewCurveName =
    mode === 'quick'
      ? `Quick ${quickTier.headline} ${quickTier.name}`
      : presetName
  /** Per-step validation for the wizard. */

  function fmtUsd(v: number): string {
    return v.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    })
  }

  // Keep the wizard's scroll position at the top when the step changes.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [step])

  // ---- per-field errors (drive red invalid-field highlighting) ----
  const findErr = (errs: string[], pred: (e: string) => boolean) =>
    errs.find(pred)
  const nameErr = findErr(tokenErrors, (e) => e.includes('Token name'))
  const tokenSymbolErr = findErr(tokenErrors, (e) =>
    e.includes('Symbol must')
  )
  const underlyingErr = findErr(tokenErrors, (e) => e.includes('Underlying'))
  const descriptionErr = findErr(tokenErrors, (e) =>
    e.includes('Description')
  )
  const supplyErr = findErr(econErrors, (e) => e.includes('Total supply'))
  const startFeeErr = findErr(econErrors, (e) => e.includes('Starting fee'))
  const endFeeErr = findErr(econErrors, (e) => e.includes('Ending fee'))
  const feePeriodsErr = findErr(econErrors, (e) =>
    e.includes('Fee decay periods')
  )
  const feeDurationErr = findErr(econErrors, (e) =>
    e.includes('Fee decay duration')
  )
  const migrationFeeErr = findErr(econErrors, (e) =>
    e.includes('Migration fee')
  )
  const dammFeeErr = findErr(econErrors, (e) => e.includes('Post-graduation'))
  const priceErrAt = (i: number): string | undefined => {
    const v = priceNums[i]
    if (!Number.isFinite(v) || v <= 0)
      return `Price point ${i + 1} must be a positive number`
    if (i > 0 && v <= priceNums[i - 1])
      return 'Price points must strictly increase toward migration'
    return undefined
  }
  const weightErrAt = (i: number): string | undefined => {
    const v = parseFloat(weights[i])
    if (!Number.isFinite(v) || v <= 0)
      return 'Liquidity weights must be positive numbers'
    return undefined
  }
  const manualUriErr =
    metadataConfigured === false &&
    manualUri.trim() &&
    !/^https:\/\/[^/]+\/.+/.test(manualUri.trim())
      ? 'Enter a valid https metadata JSON URI'
      : undefined

  /** Fill the custom quote fields from a verified directory asset. */
  function handleAssetSelect(a: PickedQuoteAsset) {
    setCustomMint(a.mint)
    if (a.decimals != null) setCustomDecimals(String(a.decimals))
    setCustomSymbol(
      a.symbol
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 10)
    )
    setPickedAsset(a)
    setManualQuote(false)
  }

  /** The quote-pair picker, shared by Quick launch and Pro designer. */
  function renderQuotePicker() {
    const mintErr = quoteErrors.find((e) => e.toLowerCase().includes('mint'))
    const decimalsErr = quoteErrors.find((e) =>
      e.toLowerCase().includes('decimals')
    )
    const symbolErr = quoteErrors.find((e) =>
      e.toLowerCase().includes('symbol')
    )
    return (
      <>
        <div className="sc-quote-options">
          {(
            [
              { id: 'SOL', label: 'SOL', sub: 'Native', icon: '/tokens/sol.png', glyph: '' },
              {
                id: 'USDC',
                label: 'USDC',
                sub: isDevnet() ? 'Devnet stablecoin' : 'Stablecoin',
                icon: '/tokens/usdc.png',
                glyph: '',
              },
              {
                id: 'custom',
                label: 'Custom',
                sub: 'Any SPL mint',
                icon: '',
                glyph: '⌁',
              },
            ] as const
          ).map((q) => (
            <button
              key={q.id}
              type="button"
              onClick={() => setQuoteSel(q.id)}
              aria-pressed={quoteSel === q.id}
              className={quoteSel === q.id ? 'selected' : ''}
            >
              {q.icon ? (
                <img
                  src={q.icon}
                  alt=""
                  width={25}
                  height={25}
                  className="sc-type-icon-img"
                />
              ) : (
                <span className="sc-type-icon">{q.glyph}</span>
              )}
              <span className="sc-quote-option-text">
                <strong>{q.label}</strong>
                <small>{q.sub}</small>
              </span>
            </button>
          ))}
        </div>
        {quoteSel === 'custom' && (
          <>
            <QuoteAssetPicker
              onSelect={handleAssetSelect}
              selectedMint={customMint}
            />
            <button
              type="button"
              onClick={() => setManualQuote((v) => !v)}
              aria-expanded={manualQuote}
              className="mb-3 text-sm text-neutral-400 underline decoration-dotted underline-offset-4 hover:text-neutral-200"
            >
              {manualQuote ? 'Hide manual entry' : 'Enter a mint manually'}
            </button>
            {manualQuote && (
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="md:col-span-2">
                  <Field label="Quote mint address" error={mintErr}>
                    <input
                      placeholder="SPL mint address"
                      value={customMint}
                      onChange={(e) => {
                        setCustomMint(e.target.value)
                        setPickedAsset(null)
                      }}
                    />
                  </Field>
                </div>
                <Field label="Decimals" error={decimalsErr}>
                  <input
                    inputMode="numeric"
                    value={customDecimals}
                    onChange={(e) =>
                      setCustomDecimals(e.target.value.replace(/[^0-9]/g, ''))
                    }
                  />
                </Field>
                <Field label="Symbol" error={symbolErr}>
                  <input
                    placeholder="e.g. AAPLx"
                    value={customSymbol}
                    maxLength={10}
                    onChange={(e) =>
                      setCustomSymbol(
                        e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
                      )
                    }
                  />
                </Field>
              </div>
            )}
          </>
        )}
        {quoteSel !== 'custom' && (
          <p className="mt-2 font-mono text-xs text-neutral-500">
            {shorten(quoteMint)}
          </p>
        )}
        {quoteSel === 'custom' && mintSupport?.kind === 'token-2022' && (
          <div
            role={mintSupport.transferHook ? 'alert' : 'note'}
            className={
              mintSupport.transferHook
                ? 'sc-form-error mt-3'
                : 'mt-3 text-xs text-neutral-400'
            }
          >
            {mintSupport.transferHook ? (
              <>
                This mint enforces a transfer hook, which Curv does not support
                as a quote pair yet. Launching with it will fail on-chain.
              </>
            ) : mintSupport.hookCheckFailed ? (
              <>
                Token-2022 quote detected, but its extensions could not be
                verified. Transfer-hook mints are not supported as a quote
                pair; confirm on devnet before launching.
              </>
            ) : (
              <>
                Token-2022 quote detected. Supported for launch and trading.
                Transfer-hook mints are not supported.
              </>
            )}
          </div>
        )}
        <ErrorList errors={quoteErrors} />
      </>
    )
  }

  return (
    <Page>
      <Head>
        <title>Launch a Token, Curv</title>
        <meta
          name="description"
          content="Design your own bonding curve and launch a token on Meteora DBC."
        />
      </Head>

      <main className="sc-launch-builder">
        <section className="sc-launch-page-heading">
          <h1>
            Launch a New <em>Token</em>
          </h1>
          <p>
            Deploy a fair launch bonding curve. No presale, no team allocation.
          </p>
        </section>

        {/* Network banner, never hardcode mainnet */}
        <div
          className={cn(
            'rounded-lg border p-3 text-sm',
            isDevnet()
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
              : 'border-rose-500/50 bg-rose-500/10 text-rose-200'
          )}
          style={{ margin: '18px 0 0' }}
        >
          {isDevnet() ? (
            <>
              You are launching on <strong>devnet</strong> ({SOLANA_NETWORK}).
              No real funds are involved; tokens and prices are play money.
            </>
          ) : (
            <>
              You are launching on <strong>MAINNET</strong>. This is real money
             , review every parameter before signing.
            </>
          )}
        </div>
        {/* ---- Wizard steps ---- */}
        <div className="sc-wizard-steps" role="tablist" aria-label="Launch steps">
          {(
            [
              { n: 1, label: 'Coin', sub: 'Name, ticker, image' },
              { n: 2, label: 'Pair and raise', sub: 'Quote pair, graduation' },
              { n: 3, label: 'Economics and launch', sub: 'Fees, review, sign' },
            ] as const
          ).map((s) => (
            <button
              key={s.n}
              type="button"
              role="tab"
              aria-selected={step === s.n}
              onClick={() => setStep(s.n)}
              className={cn(
                'sc-wizard-step',
                step === s.n && 'sc-wizard-step-active'
              )}
            >
              <span className="sc-wizard-step-num">{s.n}</span>
              <span className="sc-wizard-step-text">
                <strong>{s.label}</strong>
                <small>{s.sub}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="sc-launch-builder-grid">
          <form
            className="sc-launch-builder-form"
            onSubmit={(e) => e.preventDefault()}
          >
            {step === 1 && (
              <div>
            {/* ---- Token Identity ---- */}
            <section className="sc-builder-section">
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">◈</span>
                <div>
                  <h2>Token Identity</h2>
                  <p>Basic details that define your token</p>
                </div>
              </div>
              <div className="sc-builder-identity-row">
                <div>
                  <label
                    className={
                      imageError
                        ? 'sc-builder-image sc-field-invalid'
                        : 'sc-builder-image'
                    }
                  >
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={(e) => onImageFile(e.target.files?.[0])}
                      aria-label="Upload token image"
                    />
                    {imageDataUri ? (
                      <img src={imageDataUri} alt="Token image preview" />
                    ) : (
                      <>
                        <span>▧</span>
                        <small>Upload image</small>
                      </>
                    )}
                  </label>
                  {imageDataUri && (
                    <button
                      type="button"
                      onClick={() => setImageDataUri(null)}
                      className="mt-1 text-xs text-neutral-500 underline hover:text-neutral-300"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <Field label="Token Name" error={touched.name ? nameErr : undefined}>
                  <input
                    value={name}
                    maxLength={32}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => markTouched('name')}
                    placeholder="e.g. Curve Coin"
                  />
                </Field>
                <Field label="Ticker / Symbol" error={touched.symbol ? tokenSymbolErr : undefined}>
                  <div className="sc-builder-input-prefix">
                    <b>$</b>
                    <input
                      value={symbol}
                      maxLength={10}
                      onChange={(e) =>
                        setSymbol(
                          e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
                        )
                      }
                      onBlur={() => markTouched('symbol')}
                      placeholder="CURV"
                    />
                  </div>
                </Field>
              </div>
              <Field
                label="Description"
                error={touched.description ? descriptionErr : undefined}
                className="sc-builder-description"
              >
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={() => markTouched('description')}
                  maxLength={500}
                  placeholder="Tell traders what this token is about…"
                  rows={3}
                />
              </Field>
              <Field
                label="X (Twitter)"
                hint="Optional. Shown as an X icon next to the coin address."
                error={touched.twitter && twitter.trim() && !normalizeTwitterUrl(twitter) ? 'X handle must look like @handle or x.com/handle' : undefined}
              >
                <input
                  value={twitter}
                  onChange={(e) => setTwitter(e.target.value)}
                  onBlur={() => markTouched('twitter')}
                  maxLength={60}
                  placeholder="@handle or x.com/handle"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <p className="mt-2 text-xs text-neutral-500">
                Artwork is optional. PNG, JPEG, WebP or GIF, max 2 MB. Uploaded
                only when you launch.
              </p>
              {imageError && <p className="sc-form-error">{imageError}</p>}
              <ErrorList errors={anyTouched(['name', 'symbol', 'description', 'twitter', 'underlying']) ? tokenErrors : []} />
            </section>

            {/* ---- Type ---- */}
            <section className="sc-builder-section">
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">◫</span>
                <div>
                  <h2>Type</h2>
                  <p>Choose what your curve represents</p>
                </div>
              </div>
              <div className="sc-token-type-options">
                {(['Token', 'Tokenized Stock'] as const).map((type) => (
                  <button
                    type="button"
                    key={type}
                    aria-pressed={tokenType === type}
                    className={tokenType === type ? 'selected' : ''}
                    onClick={() => {
                      setTokenType(type)
                      markTouched('underlying')
                    }}
                  >
                    <span className="sc-type-icon">
                      {type === 'Token' ? '◈' : '⌁'}
                    </span>
                    <strong>{type}</strong>
                    <small>
                      {type === 'Token'
                        ? 'Pure bonding curve token. Fair launch, community driven.'
                        : 'Tag your token with a real world stock ticker as a reference.'}
                    </small>
                  </button>
                ))}
              </div>
              {tokenType === 'Tokenized Stock' && (
                <Field
                  label="Underlying Ticker"
                  hint="Shown as a reference on your token page. It does not move your curve."
                  error={touched.underlying ? underlyingErr : undefined}
                  className="sc-underlying-field"
                >
                  <input
                    value={underlying}
                    maxLength={6}
                    onChange={(e) =>
                      setUnderlying(
                        e.target.value.toUpperCase().replace(/[^A-Z]/g, '')
                      )
                    }
                    onBlur={() => markTouched('underlying')}
                    placeholder="E.G. AAPL, TSLA, NVDA"
                  />
                </Field>
              )}
            </section>
              </div>
            )}
            {step === 2 && (
              <>
        <div
          className="sc-launch-mode-toggle"
          role="tablist"
          aria-label="Launch mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'quick'}
            className={cn(
              'sc-launch-mode-tab',
              mode === 'quick' && 'sc-launch-mode-tab-active'
            )}
            onClick={() => setMode('quick')}
          >
            <strong>Quick launch</strong>
            <span>Name, ticker, image. Done.</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'pro'}
            className={cn(
              'sc-launch-mode-tab',
              mode === 'pro' && 'sc-launch-mode-tab-active'
            )}
            onClick={() => setMode('pro')}
          >
            <strong>Pro designer</strong>
            <span>Full control of curve, fees, graduation.</span>
          </button>
        </div>

            {/* ---- Quick: graduation target ---- */}
            {mode === 'quick' && (
              <section className="sc-builder-section" aria-labelledby="sc-tier-heading">
                <div className="sc-builder-section-head">
                  <span className="sc-section-glyph">✦</span>
                  <div>
                    <h2 id="sc-tier-heading">Graduation target</h2>
                    <p>
                      Every coin starts near a $5k market cap. Slide to set
                      where yours graduates to DAMM v2.
                    </p>
                  </div>
                </div>
                <div
                  className="sc-tier-segmented"
                  role="radiogroup"
                  aria-label="Graduation target"
                >
                  {QUICK_TIERS.map((t) => {
                    const selected = quickTierId === t.id
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setQuickTierId(t.id)}
                        className={cn(
                          'sc-tier-segment',
                          selected && 'sc-tier-segment-selected'
                        )}
                      >
                        <strong>
                          {quoteUsdPriced !== null
                            ? fmtUsd(t.capUsd)
                            : `${t.endMultiple}×`}
                        </strong>
                        <small>{t.name}</small>
                      </button>
                    )
                  })}
                </div>
                <p className="sc-tier-segment-blurb">
                  {quickTier.blurb} · graduates at{' '}
                  {quoteUsdPriced !== null
                    ? `${fmtUsd(quickTier.capUsd)} market cap`
                    : `${quickTier.endMultiple}× the starting price`}
                </p>
                <div className="sc-tier-graduation">
                  {graduationPreview !== null ? (
                    <p className="text-neutral-100">
                      <strong className="text-primary">
                        {quickTier.headline} {quickTier.name}
                      </strong>{' '}
                      graduates to <strong>DAMM v2</strong> at{' '}
                      <strong>
                        ~
                        {graduationPreview.toLocaleString('en-US', {
                          maximumFractionDigits: 4,
                        })}{' '}
                        {quoteSymbol}
                      </strong>{' '}
                      in quote reserves
                      {quoteUsdPriced !== null && (
                        <>
                          {' '}· exactly{' '}
                          <strong>{fmtUsd(quickTier.capUsd)}</strong> market
                          cap
                        </>
                      )}
                      .
                    </p>
                  ) : (
                    <p className="text-neutral-500">
                      Fix the errors above to preview graduation.
                    </p>
                  )}
                  <p className="mt-1 text-xs text-neutral-500">
                    The curve keeps running past graduation, so buys near the
                    cap always have room. No dust zone.
                  </p>
                </div>
              </section>
            )}
            {/* ---- Quick: pair ---- */}
            {mode === 'quick' && (
              <section className="sc-builder-section">
                <div className="sc-builder-section-head">
                  <span className="sc-section-glyph">◈</span>
                  <div>
                    <h2>Pair</h2>
                    <p>
                      What your token trades against. Any SPL token works.
                    </p>
                  </div>
                </div>
                <div className="mb-5">
                  <p className="mb-2 text-sm font-medium text-neutral-300">
                    Pair with
                  </p>
                  {renderQuotePicker()}
                </div>
                <ul className="sc-quick-defaults">
                  <li>
                    <strong>1B</strong> token supply · paired with{' '}
                    <strong>{quoteSymbol}</strong>
                  </li>
                  <li>
                    <strong>Exponential</strong> bonding curve · starts
                    near{' '}
                    <strong>
                      {quoteUsdPriced !== null ? '$5k' : `a fixed ${quoteSymbol} price`}
                    </strong>{' '}
                    market cap, graduates at exactly{' '}
                    <strong>
                      {quoteUsdPriced !== null
                        ? fmtUsd(quickTier.capUsd)
                        : `${quickTier.endMultiple}× the starting price`}
                    </strong>
                  </li>
                  <li>
                    Trading fee <strong>1.19%</strong> flat while bonding
                  </li>
                  <li>
                    <strong>Automatic graduation</strong> to DAMM v2 when the
                    curve fills · liquidity locked forever
                  </li>
                  <li>
                    You keep <strong>~0.3%</strong> of every trade,{' '}
                    <strong>2%</strong> of the liquidity at graduation, and{' '}
                    <strong>80%</strong> of the graduated pool&apos;s fees.
                    Your rate never drops as your coin grows. Other launchpads
                    cut the creator&apos;s share at higher market caps. Ours
                    stays flat forever, so the bigger your coin gets, the more
                    you keep compared to anywhere else.
                  </li>
                  <li>
                    <strong>0.01 SOL</strong> pool creation fee. Solana also
                    locks about <strong>0.03 SOL</strong> as refundable
                    deposits for the new onchain accounts, so launching costs
                    about <strong>0.04 SOL</strong> in total, plus tiny
                    network fees.
                  </li>
                </ul>
              </section>
            )}
            {/* ---- Pair (pro mode only): any quote token ---- */}
            {mode === 'pro' && (
            <section className="sc-builder-section">
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">◈</span>
                <div>
                  <h2>Pair</h2>
                  <p>What your token trades against. Any SPL token works.</p>
                </div>
              </div>
                <div>
                  <p className="mb-2 text-sm font-medium text-neutral-300">
                    Quote token
                  </p>
                  {renderQuotePicker()}
                </div>
            </section>
            )}
            {/* ---- Bonding Curve Settings (pro mode only) ---- */}
            {mode === 'pro' && (
              <section className="sc-builder-section sc-curve-settings">
                <div className="sc-builder-section-head">
                  <span className="sc-section-glyph">⌁</span>
                  <div>
                    <h2>Bonding Curve Settings</h2>
                    <p>Define the price trajectory of your curve</p>
                  </div>
                </div>
                <div className="sc-curve-mode-switch">
                  <button
                    type="button"
                    className={!isCustom ? 'selected' : ''}
                    onClick={() =>
                      applyPreset(
                        preset === 'custom' ? 'exponential' : preset,
                        startPrice
                      )
                    }
                  >
                    Use a Preset
                  </button>
                  <button
                    type="button"
                    className={isCustom ? 'selected' : ''}
                    onClick={() => setPreset('custom')}
                  >
                    Custom Curve
                  </button>
                </div>
                {!isCustom && (
                  <label className="sc-builder-field sc-preset-select">
                    <span>Curve Preset</span>
                    <select
                      value={preset}
                      onChange={(e) =>
                        applyPreset(e.target.value as CurvePresetId, startPrice)
                      }
                    >
                      {CURVE_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      {CURVE_PRESETS.find((p) => p.id === preset)?.blurb}
                    </small>
                  </label>
                )}
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field
                    label={`Starting price (${quoteSymbol} per token)`}
                    hint="Preset multipliers apply from here"
                  >
                    <input
                      inputMode="decimal"
                      value={startPrice}
                      onChange={(e) => {
                        setStartPrice(e.target.value)
                        if (preset !== 'custom')
                          applyPreset(preset, e.target.value)
                      }}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: 'Points', value: String(prices.length) },
                      {
                        label: 'Start',
                        value: `${Number.isFinite(priceNums[0]) ? fmtNum(priceNums[0]) : ','} ${quoteSymbol}`,
                      },
                      {
                        label: 'End',
                        value: `${
                          priceNums.length &&
                          Number.isFinite(priceNums[priceNums.length - 1])
                            ? fmtNum(priceNums[priceNums.length - 1])
                            : ','
                        } ${quoteSymbol}`,
                      },
                      {
                        label: 'Multiple',
                        value:
                          curveMultiple !== null
                            ? `${curveMultiple.toFixed(2)}×`
                            : ',',
                      },
                    ].map((s) => (
                      <div
                        key={s.label}
                        className="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5"
                      >
                        <p className="text-xs text-neutral-500">{s.label}</p>
                        <p className="mt-0.5 text-sm font-semibold text-neutral-100">
                          {s.value}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {isCustom && (
                  <>
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-sm font-medium text-neutral-300">
                          Price points
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={removePoint}
                            disabled={prices.length <= 2}
                            className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-900 disabled:opacity-40"
                          >
                            − Remove
                          </button>
                          <button
                            type="button"
                            onClick={addPoint}
                            disabled={prices.length >= 10}
                            className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-900 disabled:opacity-40"
                          >
                            + Add
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
                        {prices.map((p, i) => (
                          <Field key={i} label={`P${i + 1}`} error={priceErrAt(i)}>
                            <input
                              inputMode="decimal"
                              value={p}
                              onChange={(e) => updatePrice(i, e.target.value)}
                            />
                          </Field>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="mb-2 text-sm font-medium text-neutral-300">
                        Liquidity weights per segment
                      </p>
                      <p className="mb-2 text-xs text-neutral-500">
                        Higher weight concentrates more supply in that segment.
                        Defaults to 1.
                      </p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
                        {weights.map((w, i) => (
                          <Field
                            key={i}
                            label={`P${i + 1}→P${i + 2}`}
                            error={weightErrAt(i)}
                          >
                            <input
                              inputMode="decimal"
                              value={w}
                              onChange={(e) => updateWeight(i, e.target.value)}
                            />
                          </Field>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                <ErrorList errors={curveErrors} />
              </section>
            )}

            {/* ---- Graduation preview (pro mode only, step 2) ---- */}
            {mode === 'pro' && (
              <section className="sc-builder-section">
                <div className="sc-builder-section-head">
                  <span className="sc-section-glyph">▲</span>
                  <div>
                    <h2>Graduation preview</h2>
                    <p>
                      Where your curve hands off to DAMM v2
                    </p>
                  </div>
                </div>
                <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-4">
                  <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
                    Graduation threshold
                  </p>
                  {graduationPreview !== null ? (
                    <p className="text-neutral-100">
                      Graduates to{' '}
                      <strong className="text-primary">DAMM v2</strong> at{' '}
                      <strong>
                        ~
                        {graduationPreview.toLocaleString('en-US', {
                          maximumFractionDigits: 4,
                        })}{' '}
                        {quoteSymbol}
                      </strong>{' '}
                      in quote reserves.
                    </p>
                  ) : (
                    <p className="text-neutral-500">
                      Fix the errors above to compute the graduation threshold.
                    </p>
                  )}
                  <p className="mt-1 text-xs text-neutral-500">
                    Computed from your curve with the DBC SDK, not an estimate.
                  </p>
                  <div className="mt-3">
                    <p className="mb-2 text-sm font-medium text-neutral-300">
                      Graduation target ({quoteSymbol})
                    </p>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                      <input
                        inputMode="decimal"
                        placeholder="e.g. 85"
                        value={gradTarget}
                        onChange={(e) =>
                          setGradTarget(e.target.value.replace(/[^0-9.]/g, ''))
                        }
                        className="h-12 flex-1 rounded-2xl border border-neutral-800 bg-neutral-900/70 px-4 text-[15px] text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={applyGraduationTarget}
                        className="sc-button sc-button-secondary shrink-0"
                      >
                        Match curve to target
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-neutral-500">
                      Optional. Rescales the curve so it graduates at this level.
                    </p>
                  </div>
                </div>
              </section>
            )}
              </>
            )}
            {step === 3 && (
              <>
            {/* ---- Economics (pro mode only) ---- */}
            {mode === 'pro' && (
              <section className="sc-builder-section">
                <div className="sc-builder-section-head">
                  <span className="sc-section-glyph">◎</span>
                  <div>
                    <h2>Economics</h2>
                    <p>Supply and the fee schedule</p>
                  </div>
                </div>


                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <p className="mb-2 text-sm font-medium text-neutral-300">
                      Base token decimals
                    </p>
                    <div className="flex gap-2">
                      {([6, 9] as const).map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setBaseDecimals(d)}
                          aria-pressed={baseDecimals === d}
                          className={cn(
                            'flex-1 rounded-lg border p-3 text-sm font-semibold transition-colors',
                            baseDecimals === d
                              ? 'border-primary/60 bg-primary/10 text-primary'
                              : 'border-neutral-800 bg-neutral-950 text-neutral-300 hover:border-neutral-600'
                          )}
                        >
                          {d} decimals
                        </button>
                      ))}
                    </div>
                  </div>
                  <Field
                    label="Total supply (tokens)"
                    hint="1,000 to 1,000,000,000,000,000"
                    error={supplyErr}
                  >
                    <input
                      inputMode="numeric"
                      value={totalSupply}
                      onChange={(e) =>
                        setTotalSupply(e.target.value.replace(/[^0-9]/g, ''))
                      }
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="sc-builder-range">
                      <span>
                        Starting fee{' '}
                        <b>
                          {((parseInt(startFeeBps, 10) || 0) / 100).toFixed(2)}%
                        </b>
                      </span>
                      <input
                        type="range"
                        min={25}
                        max={9900}
                        step={10}
                        value={parseInt(startFeeBps, 10) || 0}
                        onChange={(e) => setStartFeeBps(e.target.value)}
                      />
                    </label>
                    <div className="mt-2">
                      <Field
                        label="Starting fee (basis points)"
                        hint="Fee at launch, decays exponentially"
                        error={startFeeErr}
                      >
                        <input
                          inputMode="numeric"
                          value={startFeeBps}
                          onChange={(e) =>
                            setStartFeeBps(
                              e.target.value.replace(/[^0-9]/g, '')
                            )
                          }
                        />
                      </Field>
                    </div>
                  </div>
                  <div>
                    <label className="sc-builder-range">
                      <span>
                        Ending fee{' '}
                        <b>
                          {((parseInt(endFeeBps, 10) || 0) / 100).toFixed(2)}%
                        </b>
                      </span>
                      <input
                        type="range"
                        min={25}
                        max={9900}
                        step={10}
                        value={parseInt(endFeeBps, 10) || 0}
                        onChange={(e) => setEndFeeBps(e.target.value)}
                      />
                    </label>
                    <div className="mt-2">
                      <Field
                        label="Ending fee (basis points)"
                        hint="Fee floor once the schedule decays"
                        error={endFeeErr}
                      >
                        <input
                          inputMode="numeric"
                          value={endFeeBps}
                          onChange={(e) =>
                            setEndFeeBps(e.target.value.replace(/[^0-9]/g, ''))
                          }
                        />
                      </Field>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field
                    label="Fee decay periods"
                    hint="Steps the fee decays over. 1 or more."
                    error={feePeriodsErr}
                  >
                    <input
                      inputMode="numeric"
                      value={feePeriods}
                      onChange={(e) =>
                        setFeePeriods(e.target.value.replace(/[^0-9]/g, ''))
                      }
                    />
                  </Field>
                  <Field
                    label="Fee decay duration (slots)"
                    hint="Total decay time, at least the periods above. About 0.4s per slot."
                    error={feeDurationErr}
                  >
                    <input
                      inputMode="numeric"
                      value={feeDuration}
                      onChange={(e) =>
                        setFeeDuration(e.target.value.replace(/[^0-9]/g, ''))
                      }
                    />
                  </Field>
                </div>
                <div className="mt-4">
                  <Toggle
                    label="Dynamic fee"
                    hint="An extra fee kicks in on volatile swaps, on top of the schedule."
                    checked={dynamicFee}
                    onChange={setDynamicFee}
                  />
                </div>

                <ErrorList errors={econErrors} />
              </section>
            )}

            {/* ---- Migration economics (pro mode only) ---- */}
            {mode === 'pro' && (
              <section className="sc-builder-section">
                <div className="sc-builder-section-head">
                  <span className="sc-section-glyph">▲</span>
                  <div>
                    <h2>Migration economics</h2>
                    <p>What graduation costs, and what you keep</p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field
                    label="Migration fee (%)"
                    hint="Taken from the migrating liquidity at graduation. 0-99."
                    error={migrationFeeErr}
                  >
                    <input
                      inputMode="numeric"
                      value={migrationFeePct}
                      onChange={(e) =>
                        setMigrationFeePct(
                          e.target.value.replace(/[^0-9]/g, '')
                        )
                      }
                    />
                  </Field>
                  <Field
                    label="Post-graduation pool fee (bps)"
                    hint="Base fee on the DAMM v2 pool after graduation. 10-1000."
                    error={dammFeeErr}
                  >
                    <input
                      inputMode="numeric"
                      value={dammFeeBps}
                      onChange={(e) =>
                        setDammFeeBps(e.target.value.replace(/[^0-9]/g, ''))
                      }
                    />
                  </Field>
                </div>
                <div className="mt-4">
                  <Toggle
                    label="DAMM v2 dynamic fee"
                    hint="Keep the dynamic fee on the post-graduation pool."
                    checked={dammDynamicFee}
                    onChange={setDammDynamicFee}
                  />
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  Locked: you keep ~{lockedCreatorSharePct.toFixed(2)}% of every
                  bonding-curve trade and 50% of the migration fee. Launching
                  costs 0.01 SOL plus about 0.03 SOL in rent-exempt account
                  funding, plus Solana network fees.
                </p>
              </section>
            )}
            {/* ---- Fee splits: share creator fees with collaborators ---- */}
            <section
              className="sc-builder-section"
              aria-labelledby="sc-fee-splits-heading"
            >
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">◈</span>
                <div>
                  <h2 id="sc-fee-splits-heading">Fee splits</h2>
                  <p>
                    Share your 0.3% creator trading fees with collaborators.
                    Fixed at launch and public forever, so everyone can see
                    the deal before they buy.
                  </p>
                </div>
              </div>
              <div className="sc-x-claim-callout">
                <span className="sc-x-claim-badge">X</span>
                <p>
                  <strong>Add a wallet to lock a share to it.</strong> Paste the
                  recipient&apos;s Solana address and only that wallet can ever claim
                  it. With just an X handle, the recipient posts a public tweet
                  containing their claim code to prove the handle is theirs,
                  then binds a wallet. Unclaimed shares stay with you.
                </p>
              </div>
              {splitRows.map((row, i) => (
                <div key={i} className="sc-split-form-row">
                  <Field label="Recipient wallet" className="sc-split-wallet-field">
                    <input
                      value={row.wallet}
                      onChange={(e) =>
                        setSplitRows((rs) =>
                          rs.map((r, j) => (j === i ? { ...r, wallet: e.target.value } : r))
                        )
                      }
                      placeholder="Solana address, locks this share to that wallet"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label="Share %">
                    <input
                      inputMode="decimal"
                      value={row.percent}
                      onChange={(e) =>
                        setSplitRows((rs) =>
                          rs.map((r, j) =>
                            j === i
                              ? { ...r, percent: e.target.value.replace(/[^0-9.]/g, '') }
                              : r
                          )
                        )
                      }
                      placeholder="10"
                      autoComplete="off"
                    />
                  </Field>
                  <Field label="X handle (optional)">
                    <input
                      value={row.handle}
                      onChange={(e) =>
                        setSplitRows((rs) =>
                          rs.map((r, j) => (j === i ? { ...r, handle: e.target.value } : r))
                        )
                      }
                      placeholder="name"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                  <button
                    type="button"
                    className="sc-split-remove"
                    aria-label="Remove recipient"
                    onClick={() => setSplitRows((rs) => rs.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
              {splitRows.length < 10 && (
                <button
                  type="button"
                  className="sc-button sc-button-secondary"
                  onClick={() =>
                    setSplitRows((rs) => [...rs, { wallet: '', percent: '', handle: '' }])
                  }
                >
                  Add recipient
                </button>
              )}
              <p className="sc-split-summary">
                {splitPreview.error ? (
                  <span className="sc-form-error">{splitPreview.error}</span>
                ) : splitRows.length === 0 ? (
                  'No splits set. You keep the full creator fee.'
                ) : (
                  <>
                    You assign{' '}
                    <strong>{(splitPreview.totalBps / 100).toFixed(2)}%</strong> to
                    collaborators and keep{' '}
                    <strong>{((10000 - splitPreview.totalBps) / 100).toFixed(2)}%</strong>.
                    Recipients can share at most 90% in total.
                  </>
                )}
              </p>
            </section>

            {/* ---- Trader rewards: pay your top net buyers ---- */}
            <section
              className="sc-builder-section"
              aria-labelledby="sc-trader-rewards-heading"
            >
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">🏆</span>
                <div>
                  <h2 id="sc-trader-rewards-heading">Trader rewards</h2>
                  <p>
                    Reserve a share of your creator fees for your biggest
                    supporters. The top net buyers at graduation split the
                    reward automatically in the normal claim flow. Locked at
                    launch and public forever.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setTraderRewardEnabled((v) => !v)}
                  aria-pressed={traderRewardEnabled}
                  className={cn(
                    'rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors',
                    traderRewardEnabled
                      ? 'border-[#32f27b]/60 bg-[#32f27b]/10 text-[#32f27b]'
                      : 'border-neutral-800 bg-neutral-950 text-neutral-300 hover:border-neutral-600'
                  )}
                >
                  {traderRewardEnabled ? 'On' : 'Off'}
                </button>
                {traderRewardEnabled && (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-neutral-400">Winners</span>
                      <div className="flex gap-1.5">
                        {(['1', '2', '3', '4', '5'] as const).map((v) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setTraderRewardCount(v)}
                            aria-pressed={traderRewardCount === v}
                            aria-label={`${v} winners`}
                            className={cn(
                              'h-9 w-9 rounded-lg border text-sm font-semibold transition-colors',
                              traderRewardCount === v
                                ? 'border-[#32f27b]/60 bg-[#32f27b]/10 text-[#32f27b]'
                                : 'border-neutral-800 bg-neutral-950 text-neutral-300 hover:border-neutral-600'
                            )}
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <label htmlFor="trader-reward-pct" className="text-sm text-neutral-400 shrink-0">
                        Share
                      </label>
                      <input
                        id="trader-reward-pct"
                        inputMode="decimal"
                        value={traderRewardPct}
                        onChange={(e) => {
                          const v = e.target.value.replace(/[^0-9.]/g, '');
                          const n = parseFloat(v);
                          if (v === '' || (Number.isFinite(n) && n >= 0 && n <= 90)) {
                            setTraderRewardPct(v);
                          }
                        }}
                        placeholder="5"
                        className="w-20 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm font-semibold text-neutral-100 outline-none focus:border-[#32f27b]/50"
                      />
                      <span className="text-sm text-neutral-500">% of creator fees</span>
                    </div>
                  </>
                )}
              </div>
              <p className="sc-split-summary">
                {traderRewardPreview.error ? (
                  <span className="sc-form-error">{traderRewardPreview.error}</span>
                ) : !traderRewardEnabled ? (
                  'Trader rewards are off.'
                ) : traderRewardPreview.bps > 0 ? (
                  <>
                    Top <strong>{traderRewardPreview.count}</strong> net{' '}
                    {traderRewardPreview.count === 1 ? 'buyer' : 'buyers'} split{' '}
                    <strong>{(traderRewardPreview.bps / 100).toFixed(2)}%</strong>{' '}
                    of creator fees at graduation.
                  </>
                ) : (
                  'Set a reward share to enable trader rewards.'
                )}
              </p>
            </section>

            {/* ---- Buyback and burn: creator commits a slice of fees ---- */}
            <section
              className="sc-builder-section"
              aria-labelledby="sc-buyback-heading"
            >
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">♻</span>
                <div>
                  <h2 id="sc-buyback-heading">Buyback and burn</h2>
                  <p>
                    Commit a share of your creator fees to automatically buy
                    back and burn the token. Locked at launch and public
                    forever.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {(['0', '10', '25', '50', '100'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setBuybackPct(v)}
                    aria-pressed={buybackPct === v}
                    className={cn(
                      'rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors',
                      buybackPct === v
                        ? 'border-[#32f27b]/60 bg-[#32f27b]/10 text-[#32f27b]'
                        : 'border-neutral-800 bg-neutral-950 text-neutral-300 hover:border-neutral-600'
                    )}
                  >
                    {v === '0' ? 'Off' : `${v}%`}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-3">
                <label htmlFor="buyback-custom" className="text-sm text-neutral-400 shrink-0">
                  Custom
                </label>
                <input
                  id="buyback-custom"
                  inputMode="decimal"
                  value={buybackPct}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^0-9.]/g, '');
                    const n = parseFloat(v);
                    if (v === '' || (Number.isFinite(n) && n >= 0 && n <= 100)) {
                      setBuybackPct(v);
                    }
                  }}
                  placeholder="98"
                  className="w-24 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm font-semibold text-neutral-100 outline-none focus:border-[#32f27b]/50"
                />
                <span className="text-sm text-neutral-500">% of your fee share</span>
              </div>
              <p className="sc-split-summary">
                {buybackPct === '0' ? (
                  'Buyback is off. You keep your full creator fee share.'
                ) : (
                  <>
                    <strong>{buybackPct}%</strong> of your creator fee share
                    automatically buys back and burns the token. Every trade
                    makes the remaining supply scarcer.
                  </>
                )}
              </p>
            </section>

            {/* ---- Dev buy: the creator's own opening buy, public from block one ---- */}
            <section className="sc-builder-section">
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">✦</span>
                <div>
                  <h2>Dev buy</h2>
                  <p>
                    Buy your own token the moment the pool opens. It is
                    executed in the launch flow and shown publicly from
                    block one.
                  </p>
                </div>
              </div>
              <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
                <Field
                  label={`Dev buy (${quoteSymbol})`}
                  hint="Optional. Runs as a buy right after your pool is created, in the same signing session. A dev buy you can see is trust."
                  error={devBuyPreview.error ?? undefined}
                >
                  <div className="flex items-center gap-3">
                    <input
                      inputMode="decimal"
                      value={devBuy}
                      onChange={(e) =>
                        setDevBuy(e.target.value.replace(/[^0-9.]/g, ''))
                      }
                      placeholder="0.5"
                      autoComplete="off"
                      className="text-lg font-semibold"
                    />
                    <span className="shrink-0 text-sm font-medium text-neutral-400">
                      {quoteSymbol}
                    </span>
                  </div>
                </Field>
                {devBuyPreview.lamports !== null && !devBuyPreview.error && (
                  <p className="mt-3 text-sm text-neutral-300">
                    You will buy{' '}
                    <strong className="text-primary">
                      {devBuy.trim()} {quoteSymbol}
                    </strong>{' '}
                    worth of your token at launch, visible to everyone on
                    the trust panel.
                  </p>
                )}
                {devBuy.trim() === '' && (
                  <p className="mt-3 text-xs text-neutral-500">
                    Leave empty for no dev buy. You can always buy from the
                    public curve after launch.
                  </p>
                )}
              </div>
            </section>

            {/* ---- Review ---- */}
            <section className="sc-builder-section">
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">✓</span>
                <div>
                  <h2>Review</h2>
                  <p>
                    Check everything once. Your wallet stays disconnected until
                    you launch.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
                <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-4">
                  <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
                    Token
                  </p>
                  <div className="flex items-center gap-3">
                    {imageDataUri && (
                      <img
                        src={imageDataUri}
                        alt=""
                        className="h-10 w-10 rounded-lg object-cover"
                      />
                    )}
                    <div>
                      <p className="font-semibold text-neutral-100">
                        {name || ','}
                      </p>
                      <p className="text-neutral-400">${symbol || ','}</p>
                    </div>
                  </div>
                  {fullDescription && (
                    <p className="mt-2 text-neutral-400">{fullDescription}</p>
                  )}
                  <p className="mt-2 text-xs text-neutral-500">
                    Type: {tokenType}
                    {tokenType === 'Tokenized Stock' &&
                      underlying.trim() &&
                      ` · ${underlying.trim()}`}
                  </p>
                </div>
                <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-4">
                  <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
                    Curve
                  </p>
                  <p className="text-neutral-200">
                    {mode === 'quick'
                      ? `${reviewCurveName} · graduates at ${quoteUsdPriced !== null ? fmtUsd(quickTier.capUsd) : `${quickTier.endMultiple}× start`}`
                      : `${reviewCurveName} · ${reviewCurvePrices.length} points`}
                  </p>
                  <p className="mt-1 text-neutral-400">
                    {Number.isFinite(reviewCurvePrices[0]) ? fmtNum(reviewCurvePrices[0]) : ','}{' '}
                    →{' '}
                    {reviewCurvePrices.length &&
                    Number.isFinite(reviewCurvePrices[reviewCurvePrices.length - 1])
                      ? fmtNum(reviewCurvePrices[reviewCurvePrices.length - 1])
                      : ','}{' '}
                    {quoteSymbol}
                    {curveMultiple !== null && (
                      <span className="ml-1 font-semibold text-primary">
                        {curveMultiple.toFixed(2)}×
                      </span>
                    )}
                  </p>
                </div>
                <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-4">
                  <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
                    Economics
                  </p>
                  <p className="text-neutral-200">
                    {parseFloat(totalSupply || '0').toLocaleString('en-US')}{' '}
                    supply · {baseDecimals} decimals
                  </p>
                  <p className="mt-1 text-neutral-400">
                    Quote: {quoteSymbol} ({shorten(quoteMint)})
                  </p>
                  <p className="mt-1 text-neutral-400">
                    {(() => {
                      const start = (parseInt(startFeeBps, 10) || 0) / 100;
                      const end = (parseInt(endFeeBps, 10) || 0) / 100;
                      const flat = start === end;
                      return (
                        <>
                          Fees: {flat ? `${start.toFixed(2)}% flat` : `${start.toFixed(2)}% → ${end.toFixed(2)}% over ${feePeriods || '?'} periods`}
                          {dynamicFee ? ' + dynamic' : ''}
                        </>
                      );
                    })()}
                  </p>
                  <p className="mt-1 text-neutral-400">
                    Migration fee: {migrationFeePct || ','}% · DAMM v2:{' '}
                    {((parseInt(dammFeeBps, 10) || 0) / 100).toFixed(2)}%
                    {dammDynamicFee ? ' + dynamic' : ''}
                  </p>
                </div>
                <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
                  <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
                    Graduation
                  </p>
                  {graduationPreview !== null ? (
                    <p className="text-neutral-100">
                      Graduates to{' '}
                      <strong className="text-primary">DAMM v2</strong> at{' '}
                      <strong>
                        ~
                        {graduationPreview.toLocaleString('en-US', {
                          maximumFractionDigits: 4,
                        })}{' '}
                        {quoteSymbol}
                      </strong>{' '}
                      in quote reserves.
                    </p>
                  ) : (
                    <p className="text-neutral-500">
                      Fix the errors above to preview the graduation threshold.
                    </p>
                  )}
                  <p className="mt-1 text-xs text-neutral-500">
                    Computed from your curve with the DBC SDK, not an estimate.
                  </p>
                </div>
                {devBuyPreview.lamports !== null && !devBuyPreview.error && (
                  <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
                    <div className="flex items-center gap-2">
                      <span className="sc-section-glyph" aria-hidden="true">
                        ✦
                      </span>
                      <p className="text-xs uppercase tracking-wide text-neutral-500">
                        Dev buy
                      </p>
                    </div>
                    <p className="mt-2 text-neutral-100">
                      You buy{' '}
                      <strong className="text-primary">
                        {devBuy.trim()} {quoteSymbol}
                      </strong>{' '}
                      of ${symbol || ','} in the launch flow.
                    </p>
                    <p className="mt-1 text-xs text-neutral-500">
                      Signed by your wallet right after pool creation, shown
                      publicly from block one.
                    </p>
                  </div>
                )}
              </div>

              {metadataConfigured === false && (
                <div className="mt-4">
                  <Field
                    label="Metadata JSON URI"
                    hint="Metadata hosting is not configured on this server. Paste a public https URL to your token metadata JSON."
                    error={manualUriErr}
                  >
                    <input
                      placeholder="https://…/metadata.json"
                      value={manualUri}
                      onChange={(e) => setManualUri(e.target.value)}
                    />
                  </Field>
                </div>
              )}

              <ErrorList errors={activeErrors} />
            </section>

            {/* ---- Wallet gate: the entire form is completable without a wallet.
                Connection happens only here, at the final step, and only
                to sign the launch transaction + the registration message. ---- */}
            <section
              className="sc-builder-section sc-wallet-gate"
              aria-labelledby="sc-wallet-gate-heading"
            >
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">◎</span>
                <div>
                  <h2 id="sc-wallet-gate-heading">Connect wallet to launch</h2>
                  <p>Only needed for the final signature</p>
                </div>
              </div>
              {!publicKey ? (
                <>
                  <p className="text-sm leading-relaxed text-neutral-300">
                    Everything above is complete without a wallet. Connecting
                    signs nothing by itself. Only two signatures happen, both at
                    the final launch step.
                  </p>
                  <button
                    type="button"
                    onClick={() => setWalletModalVisible(true)}
                    className="sc-button sc-button-primary mt-3"
                  >
                    Connect wallet
                  </button>
                </>
              ) : (
                <p className="text-sm text-neutral-300">
                  Connected. Signing as{' '}
                  <span className="font-mono text-neutral-100">
                    {shorten(publicKey.toBase58())}
                  </span>
                </p>
              )}

              {status !== 'idle' && status !== 'error' && (
                <div className="mt-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
                  <p className="flex items-center gap-2 text-sm font-medium text-primary">
                    <CurvyLoader size={24} />
                    {STATUS_LABEL[status as keyof typeof STATUS_LABEL]}
                  </p>
                  {status === 'grinding' && (
                    <div className="mt-3 text-xs text-neutral-400">
                      {vanityProgress &&
                      vanityProgress.attemptsPerSecond > 0 ? (
                        <p className="font-mono">
                          {vanityProgress.attempts.toLocaleString('en-US')}{' '}
                          attempts ·{' '}
                          {Math.round(
                            vanityProgress.attemptsPerSecond
                          ).toLocaleString('en-US')}
                          /s · {vanityEta(vanityProgress)}
                        </p>
                      ) : (
                        <p>Starting grind…</p>
                      )}
                      <button
                        type="button"
                        onClick={() => vanityCtrlRef.current?.abort()}
                        className="mt-2 underline hover:text-neutral-200"
                      >
                        Skip, launch with a random address instead
                      </button>
                    </div>
                  )}
                  {txSig && (
                    <a
                      href={solscanTx!}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block font-mono text-xs text-neutral-400 underline hover:text-neutral-200"
                    >
                      View transaction on Solscan ↗
                    </a>
                  )}
                </div>
              )}

              {status === 'error' && launchError && (
                <div className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
                  {launchError}
                </div>
              )}

              {launchedPool && (
                <div className="mt-4 rounded-lg border border-primary/40 bg-primary/5 p-4 text-sm">
                  <p className="font-semibold text-primary">Pool launched!</p>
                  <Link
                    href={`/token/${launchedPool}`}
                    className="text-neutral-200 underline"
                  >
                    View your pool →
                  </Link>
                </div>
              )}
            </section>
            <div className="sc-launch-submit-bar">
              <div>
                <span>EST. DEPLOY COST</span>
                <strong
                  title={`Includes the ${feeRows.length > 0 ? feeRows[0].value : '0.01 SOL'} creation fee plus about ${LAUNCH_FEE_CONFIG.estimatedLaunchRentSol} SOL in refundable Solana account deposits. Network fees on top.`}
                >
                  {deployTotalLabel} + network fees
                </strong>
              </div>
              <div className="sc-launch-submit-actions">
                <button
                  className="sc-button sc-button-secondary"
                  type="button"
                  onClick={saveDraft}
                >
                  Save as Draft
                </button>
                <button
                  className="sc-button sc-button-primary"
                  type="button"
                  onClick={handleLaunch}
                  disabled={busy}
                >
                  ↗ Launch Token
                </button>
              </div>
              {notice && (
                <span className="sc-launch-notice" role="status">
                  {notice}
                </span>
              )}
            </div>              </>
            )}
            {/* ---- Wizard nav ---- */}
            <div className="sc-wizard-nav">
              {step > 1 ? (
                <button
                  type="button"
                  className="sc-button sc-button-secondary"
                  onClick={() => setStep(((step - 1) as 1 | 2 | 3))}
                >
                  ← Back
                </button>
              ) : (
                <span />
              )}
              {step < 3 ? (
                <div className="sc-wizard-continue">
                  <button
                    type="button"
                    className="sc-button sc-button-primary"
                    onClick={() => setStep(((step + 1) as 1 | 2 | 3))}
                  >
                    Continue →
                  </button>
                </div>
              ) : (
                <span />
              )}
            </div>
          </form>

          <aside className="sc-live-preview-column">
            <section className="sc-live-preview">
              <div className="sc-live-preview-head">
                <h2>Live Preview</h2>
                <span>Discover feed</span>
              </div>
              <article className="sc-preview-token-card">
                <div className="sc-preview-token-head">
                  <span className="sc-preview-token-mark">
                    {imageDataUri ? (
                      <img src={imageDataUri} alt="" />
                    ) : (
                      symbol.trim().slice(0, 1).toUpperCase() || '?'
                    )}
                  </span>
                  <div>
                    <strong>{name.trim() || 'Your Token'}</strong>
                    <span>${symbol.trim().toUpperCase() || 'TICKER'}</span>
                  </div>
                  <span className="sc-preview-stock-badge">
                    {tokenType === 'Tokenized Stock'
                      ? underlying.trim()
                        ? `Stocks · ${underlying.trim()}`
                        : 'Stocks'
                      : 'Token'}
                  </span>
                </div>
                <div className="sc-preview-card-stats">
                  <span>
                    Mcap<strong>$0</strong>
                  </span>
                  <span>
                    24h<strong>-</strong>
                  </span>
                </div>
                <div className="sc-progress">
                  <span style={{ width: '0%' }} />
                </div>
                <div className="sc-preview-not-launched">
                  <i /> Not launched yet
                </div>
              </article>
            </section>

            <section className="sc-builder-chart-card">
              <div className="sc-builder-chart-title">
                <h2>Curve Preview</h2>
                <span>{reviewCurveName}</span>
              </div>
              <div className="mt-3">
                <CurveChart prices={reviewCurvePrices} quoteSymbol={quoteSymbol} />
              </div>
            </section>

            <div className="sc-curve-explainer">
              <span>ⓘ</span>
              <p>
                Your curve determines the price trajectory as buyers purchase
                supply. Steeper curves reward early buyers more.
              </p>
            </div>

            <section
              className="sc-fees-disclosure"
              aria-labelledby="sc-fees-heading"
            >
              <div className="sc-live-preview-head">
                <h2 id="sc-fees-heading">Fees</h2>
                <span>From your config</span>
              </div>
              <div className="sc-fee-cost-line">
                <span>Cost to launch</span>
                <strong>0.01 SOL + network fees</strong>
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                0.01 SOL pool creation fee. About 0.03 SOL in refundable
                Solana rent deposits is also locked for the new pool accounts.
              </p>
              <dl className="sc-fee-rows">
                {feeRows.map((r) => (
                  <div key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>
                      <strong>{r.value}</strong>
                      <span>{r.hint}</span>
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="sc-fee-consequences">
                <p className="sc-fee-consequences-title">
                  What this means for you
                </p>
                <ul>
                  {feeConsequences.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            </section>
          </aside>
        </div>
      </main>
    </Page>
  )
}
