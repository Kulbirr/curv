import { useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import bs58 from 'bs58';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import Page from '@/components/ui/Page/Page';
import { CurveChart } from '../components/Launch/CurveChart';
import { ErrorList, Field, Toggle } from '../components/Launch/ui';
import {
  CURVE_PRESETS,
  presetCurve,
  asCurvePresetId,
  type CurvePresetId,
} from '@/lib/presets';
import {
  buildCurveParams,
  buildLaunchTransaction,
  graduationThresholdQuote,
  resolveEcon,
  scaleCurveToGraduationTarget,
  validateLaunchSpec,
  type LaunchEconOverrides,
  type LaunchSpec,
} from '@/lib/launch';
import { getConnection, isDevnet, SOLANA_NETWORK } from '@/lib/solana';
import { getUsdcMint } from '@/lib/quote-assets';
import { cn } from '@/lib/utils';
import { Keypair } from '@solana/web3.js';
import {
  VANITY_SUFFIX,
  estimateVanityMintAttempts,
  grindVanityMintParallel,
  type VanityMintResult,
  type VanityProgress,
} from '@/lib/vanity-mint';
import { fetchVanityHandout } from '@/lib/vanity-handout';
import { buildFeeDisclosureRows } from '@/lib/launch-fees';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** Network-aware USDC: devnet USDC on devnet, mainnet USDC on mainnet. */
const USDC_MINT = getUsdcMint(SOLANA_NETWORK);

type QuoteSel = 'SOL' | 'USDC' | 'custom';
type PresetSel = CurvePresetId | 'custom';
type TokenType = 'Memecoin' | 'Tokenized Stock';
type LaunchStatus =
  | 'idle'
  | 'uploading'
  | 'grinding'
  | 'building'
  | 'signing'
  | 'sending'
  | 'confirming'
  | 'registering'
  | 'done'
  | 'error';

const STATUS_LABEL: Record<Exclude<LaunchStatus, 'idle' | 'done' | 'error'>, string> = {
  uploading: 'Uploading metadata…',
  grinding: 'Preparing your vanity mint address…',
  building: 'Building launch transaction…',
  signing: 'Waiting for wallet signature…',
  sending: 'Sending transaction…',
  confirming: 'Confirming on-chain…',
  registering: 'Registering pool…',
};

/**
 * Must stay byte-identical to buildRegistrationMessage() in
 * src/lib/signatures.ts (the server verifies against that format).
 * Not imported here because that module pulls in Node's crypto.
 */
function buildRegistrationMessageClient(poolAddress: string, creator: string, timestamp: number): string {
  return [
    'StockCurve pool registration',
    `pool: ${poolAddress}`,
    `creator: ${creator}`,
    `timestamp: ${timestamp}`,
  ].join('\n');
}

function parsePositiveFloat(s: string): number | null {
  const v = parseFloat(s);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

/** Rough ETA text for the vanity grind progress indicator. */
function vanityEta(p: VanityProgress): string {
  if (p.attemptsPerSecond <= 0) return '…';
  const remaining =
    Math.max(0, estimateVanityMintAttempts(VANITY_SUFFIX) - p.attempts) / p.attemptsPerSecond;
  if (remaining < 90) return `${Math.max(1, Math.ceil(remaining))}s left`;
  return `~${(remaining / 60).toFixed(1)} min left`;
}

const DRAFT_KEY = 'curv.launch-draft.v1';

interface LaunchDraft {
  name: string;
  symbol: string;
  description: string;
  tokenType: TokenType;
  underlying: string;
  preset: PresetSel;
  startPrice: string;
  prices: string[];
  weights: string[];
  quoteSel: QuoteSel;
  customMint: string;
  customDecimals: string;
  customSymbol: string;
  baseDecimals: 6 | 9;
  totalSupply: string;
  startFeeBps: string;
  endFeeBps: string;
  feePeriods: string;
  feeDuration: string;
  dynamicFee: boolean;
  migrationFeePct: string;
  dammFeeBps: string;
  dammDynamicFee: boolean;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 2 || v.length > 10) return null;
  if (!v.every((x) => typeof x === 'string')) return null;
  return v as string[];
}

export default function CreatePool() {
  const router = useRouter();
  const { publicKey, signTransaction, signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();

  // ---- Token identity ----
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [imageDataUri, setImageDataUri] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  // ---- Token type ----
  const [tokenType, setTokenType] = useState<TokenType>('Memecoin');
  const [underlying, setUnderlying] = useState('');

  // ---- Curve ----
  const [preset, setPreset] = useState<PresetSel>('exponential');
  const [startPrice, setStartPrice] = useState('0.0001');
  const [prices, setPrices] = useState<string[]>(() => presetCurve('exponential', 0.0001).prices.map(String));
  const [weights, setWeights] = useState<string[]>(() =>
    new Array(presetCurve('exponential', 0.0001).prices.length - 1).fill('1'),
  );

  // ---- Economics ----
  const [quoteSel, setQuoteSel] = useState<QuoteSel>('SOL');
  const [customMint, setCustomMint] = useState('');
  const [customDecimals, setCustomDecimals] = useState('6');
  const [customSymbol, setCustomSymbol] = useState('');
  const [baseDecimals, setBaseDecimals] = useState<6 | 9>(6);
  const [totalSupply, setTotalSupply] = useState('1000000000');
  const [startFeeBps, setStartFeeBps] = useState('500');
  const [endFeeBps, setEndFeeBps] = useState('100');
  // ---- Fee schedule decay ----
  const [feePeriods, setFeePeriods] = useState('60');
  const [feeDuration, setFeeDuration] = useState('60');
  const [dynamicFee, setDynamicFee] = useState(true);
  // ---- Graduation & migration ----
  const [migrationFeePct, setMigrationFeePct] = useState('10');
  const [dammFeeBps, setDammFeeBps] = useState('120');
  const [dammDynamicFee, setDammDynamicFee] = useState(true);
  const [gradTarget, setGradTarget] = useState('');

  // ---- Launch ----
  const [metadataConfigured, setMetadataConfigured] = useState<boolean | null>(null);
  const [manualUri, setManualUri] = useState('');
  const [status, setStatus] = useState<LaunchStatus>('idle');
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [launchedPool, setLaunchedPool] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  // ---- Vanity mint (instant pool handout, local grind fallback) ----
  // At wizard start we first try POST /api/vanity-mint for a pre-ground
  // "...curv" keypair (the grinder keeps the pool topped up, so this is
  // instant). On any failure — 503 pool dry, 429, network — we fall back
  // to the local background grind that starts when the wizard opens and
  // usually finishes while the user designs the curve.
  const [vanityProgress, setVanityProgress] = useState<VanityProgress | null>(null);
  const [vanityReadyAddress, setVanityReadyAddress] = useState<string | null>(null);
  /** Where the ready keypair came from: server pool or local grind. */
  const [vanitySource, setVanitySource] = useState<'pool' | 'grind' | null>(null);
  const vanityCtrlRef = useRef<AbortController | null>(null);
  const vanityPromiseRef = useRef<Promise<VanityMintResult> | null>(null);
  const vanityHandoutPromiseRef = useRef<Promise<Keypair | null> | null>(null);
  const vanityKeypairRef = useRef<Keypair | null>(null);
  const vanityRunRef = useRef(0);

  function startLocalGrind(run: number) {
    const ctrl = new AbortController();
    vanityCtrlRef.current = ctrl;
    const p = grindVanityMintParallel({
      suffix: VANITY_SUFFIX,
      signal: ctrl.signal,
      onProgress: (pr) => setVanityProgress(pr),
    });
    vanityPromiseRef.current = p;
    p.then(
      (res) => {
        // Stale result from a superseded grind run — ignore it.
        if (vanityPromiseRef.current !== p || vanityRunRef.current !== run) return;
        vanityKeypairRef.current = res.keypair;
        setVanityReadyAddress(res.keypair.publicKey.toBase58());
        setVanitySource('grind');
        setVanityProgress(null);
      },
      () => {
        // Aborted or failed: launch falls back to a random mint.
        if (vanityPromiseRef.current !== p || vanityRunRef.current !== run) return;
        setVanityProgress(null);
      },
    );
  }

  async function startVanityGrind() {
    const run = vanityRunRef.current + 1;
    vanityRunRef.current = run;
    vanityCtrlRef.current?.abort();
    setVanityReadyAddress(null);
    setVanityProgress(null);
    setVanitySource(null);
    vanityKeypairRef.current = null;
    // Instant path first: claim a pre-ground keypair from the server pool.
    const handoutPromise = fetchVanityHandout();
    vanityHandoutPromiseRef.current = handoutPromise;
    const handed = await handoutPromise;
    if (vanityRunRef.current !== run) return; // superseded
    if (handed) {
      vanityKeypairRef.current = handed;
      setVanityReadyAddress(handed.publicKey.toBase58());
      setVanitySource('pool');
      return;
    }
    // Fallback: grind locally in the background.
    startLocalGrind(run);
  }

  useEffect(() => {
    startVanityGrind();
    return () => {
      vanityRunRef.current += 1; // invalidate any in-flight handout fetch
      vanityCtrlRef.current?.abort();
      vanityCtrlRef.current = null;
    };
    // Run once on mount: the grind belongs to the wizard session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch('/api/metadata')
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((j) => setMetadataConfigured(j.configured === true))
      .catch(() => setMetadataConfigured(false));
  }, []);

  // ---- derived quote ----
  const quoteMint = quoteSel === 'SOL' ? SOL_MINT : quoteSel === 'USDC' ? USDC_MINT : customMint.trim();
  const quoteDecimals =
    quoteSel === 'SOL' ? 9 : quoteSel === 'USDC' ? 6 : parseInt(customDecimals, 10);
  const quoteSymbol =
    quoteSel === 'SOL' ? 'SOL' : quoteSel === 'USDC' ? 'USDC' : customSymbol.trim().toUpperCase();

  // Description as it will be stored: the stock reference ticker is recorded
  // as plain text when the Tokenized Stock type is picked. It is a label on
  // the token page — it does not move the curve.
  const fullDescription = useMemo(() => {
    const base = description.trim();
    const ref =
      tokenType === 'Tokenized Stock' && underlying.trim()
        ? ` Stock reference: ${underlying.trim()}.`
        : '';
    return (base + ref).trim();
  }, [description, tokenType, underlying]);

  // ---- curve helpers ----
  function applyPreset(id: CurvePresetId, sp: string) {
    const start = parsePositiveFloat(sp);
    if (start === null) return;
    const c = presetCurve(id, start);
    setPreset(id);
    setStartPrice(sp);
    setPrices(c.prices.map(String));
    setWeights(c.liquidityWeights.map(String));
  }

  function updatePrice(i: number, v: string) {
    setPreset('custom');
    setPrices((p) => p.map((x, j) => (j === i ? v : x)));
  }

  function updateWeight(i: number, v: string) {
    setPreset('custom');
    setWeights((w) => w.map((x, j) => (j === i ? v : x)));
  }

  function addPoint() {
    if (prices.length >= 10) return;
    const last = parsePositiveFloat(prices[prices.length - 1]) ?? 0;
    setPreset('custom');
    setPrices((p) => [...p, String(last * 1.5 || 1)]);
    setWeights((w) => [...w, '1']);
  }

  function removePoint() {
    if (prices.length <= 2) return;
    setPreset('custom');
    setPrices((p) => p.slice(0, -1));
    setWeights((w) => w.slice(0, -1));
  }

  const priceNums = useMemo(() => prices.map((p) => parseFloat(p)), [prices]);

  // ---- local curve validation (authoritative check lives in launch.ts) ----
  const curveErrors = useMemo(() => {
    const errs: string[] = [];
    if (prices.length < 2 || prices.length > 10) errs.push('Curve needs 2-10 price points');
    for (let i = 0; i < prices.length; i++) {
      const v = priceNums[i];
      if (!Number.isFinite(v) || v <= 0) {
        errs.push(`Price point ${i + 1} must be a positive number`);
        break;
      }
      if (i > 0 && v <= priceNums[i - 1]) {
        errs.push('Price points must strictly increase toward migration');
        break;
      }
    }
    if (weights.length !== prices.length - 1) errs.push('Liquidity weights must match the curve segments');
    if (weights.some((w) => { const v = parseFloat(w); return !Number.isFinite(v) || v <= 0; }))
      errs.push('Liquidity weights must be positive numbers');
    return errs;
  }, [prices, priceNums, weights]);

  const tokenErrors = useMemo(() => {
    const errs: string[] = [];
    if (!name.trim()) errs.push('Token name is required');
    else if (name.trim().length > 32) errs.push('Token name must be 32 characters or less');
    if (!/^[A-Za-z0-9]{1,10}$/.test(symbol.trim()))
      errs.push('Symbol must be 1-10 alphanumeric characters');
    if (tokenType === 'Tokenized Stock' && !underlying.trim())
      errs.push('Underlying stock ticker is required for the Tokenized Stock type');
    if (fullDescription.length > 500) errs.push('Description must be 500 characters or less');
    return errs;
  }, [name, symbol, tokenType, underlying, fullDescription]);

  const econErrors = useMemo(() => {
    const errs: string[] = [];
    if (quoteSel === 'custom') {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(customMint.trim()))
        errs.push('Custom quote mint is not a valid address');
      const d = parseInt(customDecimals, 10);
      if (!Number.isInteger(d) || d < 0 || d > 9) errs.push('Quote decimals must be 0-9');
      if (!/^[A-Za-z0-9]{1,10}$/.test(customSymbol.trim()))
        errs.push('Quote symbol must be 1-10 alphanumeric characters');
    }
    const supply = parseFloat(totalSupply);
    if (!Number.isFinite(supply) || supply < 1_000 || supply > 1e15)
      errs.push('Total supply must be between 1,000 and 1,000,000,000,000,000');
    const sf = parseInt(startFeeBps, 10);
    const ef = parseInt(endFeeBps, 10);
    if (!Number.isInteger(sf) || sf < 0 || sf > 10000) errs.push('Starting fee must be 0-10000 bps');
    if (!Number.isInteger(ef) || ef < 0 || ef > 10000) errs.push('Ending fee must be 0-10000 bps');
    if (Number.isInteger(sf) && Number.isInteger(ef) && ef > sf)
      errs.push('Ending fee cannot exceed the starting fee');
    const fp = parseInt(feePeriods, 10);
    const fd = parseInt(feeDuration, 10);
    if (!Number.isInteger(fp) || fp < 1)
      errs.push('Fee decay periods must be a whole number of 1 or more');
    if (!Number.isInteger(fd) || fd < fp)
      errs.push('Fee decay duration must be a whole number of slots, at least the number of periods');
    const mf = parseInt(migrationFeePct, 10);
    if (!Number.isInteger(mf) || mf < 0 || mf > 99)
      errs.push('Migration fee must be a whole percent between 0 and 99');
    const df = parseInt(dammFeeBps, 10);
    if (!Number.isInteger(df) || df < 10 || df > 1000)
      errs.push('Post-graduation pool fee must be 10-1000 bps');
    return errs;
  }, [quoteSel, customMint, customDecimals, customSymbol, totalSupply, startFeeBps, endFeeBps,
      feePeriods, feeDuration, migrationFeePct, dammFeeBps]);

  function buildSpec(metadataUri: string): LaunchSpec {
    return {
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(),
      description: fullDescription || undefined,
      metadataUri,
      quoteMint,
      quoteDecimals,
      quoteSymbol,
      baseDecimals,
      totalSupply: parseFloat(totalSupply),
      curve: {
        prices: priceNums,
        liquidityWeights: weights.map((w) => parseFloat(w)),
      },
      startingFeeBps: parseInt(startFeeBps, 10),
      endingFeeBps: parseInt(endFeeBps, 10),
      econ: buildEcon(),
    };
  }

  function buildEcon(): LaunchEconOverrides {
    return {
      feeSchedulerPeriods: parseInt(feePeriods, 10),
      feeSchedulerTotalDuration: parseInt(feeDuration, 10),
      dynamicFeeEnabled: dynamicFee,
      migrationFeePercent: parseInt(migrationFeePct, 10),
      migratedPoolFeeBps: parseInt(dammFeeBps, 10),
      migratedPoolDynamicFee: dammDynamicFee,
    };
  }

  // Graduation threshold preview: real SDK math, shown only when the spec is valid.
  const graduationPreview = useMemo(() => {
    try {
      const spec = buildSpec('https://placeholder.invalid/metadata.json');
      return graduationThresholdQuote(spec);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    name, symbol, quoteMint, quoteDecimals, quoteSymbol, baseDecimals, totalSupply,
    priceNums, weights, startFeeBps, endFeeBps,
    feePeriods, feeDuration, dynamicFee, migrationFeePct, dammFeeBps, dammDynamicFee,
  ]);

  function fmtNum(v: number): string {
    return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }

  // Fee disclosure: every number comes from the effective economics (the
  // same constants the on-chain config is built from) or the user's own
  // fee-schedule inputs — nothing invented.
  const feeRows = useMemo(
    () =>
      buildFeeDisclosureRows({
        startingFeeBps: parseInt(startFeeBps, 10) || 0,
        endingFeeBps: parseInt(endFeeBps, 10) || 0,
        quoteSymbol,
        econ: resolveEcon(buildSpec('https://placeholder.invalid/metadata.json')),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startFeeBps, endFeeBps, quoteSymbol, feePeriods, feeDuration, dynamicFee,
     migrationFeePct, dammFeeBps, dammDynamicFee],
  );

  /** Rescale the curve so its graduation threshold matches the target. */
  function applyGraduationTarget() {
    const target = parseFloat(gradTarget);
    if (!Number.isFinite(target) || target <= 0) {
      setNotice('Enter a positive graduation target first.');
      return;
    }
    try {
      const spec = buildSpec('https://placeholder.invalid/metadata.json');
      const specErrors = validateLaunchSpec(spec);
      if (specErrors.length > 0) {
        setNotice('Fix the errors above before matching a graduation target.');
        return;
      }
      const rescaled = scaleCurveToGraduationTarget(spec, target);
      setPrices(rescaled.curve.prices.map(String));
      setNotice(
        `Curve rescaled to graduate at ~${target.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${quoteSymbol}.`,
      );
    } catch {
      setNotice('Could not match that graduation target.');
    }
  }

  // ---- image picker ----
  async function onImageFile(file: File | undefined) {
    setImageError(null);
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      setImageError('Image must be PNG, JPEG, WebP or GIF');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setImageError('Image must be under 2 MB');
      return;
    }
    const dataUri = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error('Could not read image'));
      r.readAsDataURL(file);
    });
    setImageDataUri(dataUri);
  }

  // ---- draft (this browser only; the image is never stored) ----
  function saveDraft() {
    const draft: LaunchDraft = {
      name, symbol, description, tokenType, underlying,
      preset, startPrice, prices, weights,
      quoteSel, customMint, customDecimals, customSymbol,
      baseDecimals, totalSupply, startFeeBps, endFeeBps,
      feePeriods, feeDuration, dynamicFee,
      migrationFeePct, dammFeeBps, dammDynamicFee,
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      setNotice('Draft saved in this browser.');
    } catch {
      setNotice('Could not save the draft in this browser.');
    }
  }

  // ?preset= deep link + draft restore, once on mount.
  const initRef = useRef(false);
  useEffect(() => {
    if (!router.isReady || initRef.current) return;
    initRef.current = true;
    const id = asCurvePresetId(router.query.preset);
    if (id) {
      // Same as clicking the preset: rebuild the curve from it.
      applyPreset(id, startPrice);
      return;
    }
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as Partial<LaunchDraft>;
      if (typeof d.name === 'string') setName(d.name);
      if (typeof d.symbol === 'string') setSymbol(d.symbol);
      if (typeof d.description === 'string') setDescription(d.description);
      if (d.tokenType === 'Memecoin' || d.tokenType === 'Tokenized Stock') setTokenType(d.tokenType);
      if (typeof d.underlying === 'string') setUnderlying(d.underlying);
      if (typeof d.startPrice === 'string') setStartPrice(d.startPrice);
      const dp = asStringArray(d.prices);
      const dw = asStringArray(d.weights);
      if (dp && dw && dw.length === dp.length - 1) {
        setPrices(dp);
        setWeights(dw);
        setPreset('custom');
      } else if (d.preset === 'custom' || asCurvePresetId(d.preset)) {
        setPreset(d.preset);
      }
      if (d.quoteSel === 'SOL' || d.quoteSel === 'USDC' || d.quoteSel === 'custom') setQuoteSel(d.quoteSel);
      if (typeof d.customMint === 'string') setCustomMint(d.customMint);
      if (typeof d.customDecimals === 'string') setCustomDecimals(d.customDecimals);
      if (typeof d.customSymbol === 'string') setCustomSymbol(d.customSymbol);
      if (d.baseDecimals === 6 || d.baseDecimals === 9) setBaseDecimals(d.baseDecimals);
      if (typeof d.totalSupply === 'string') setTotalSupply(d.totalSupply);
      if (typeof d.startFeeBps === 'string') setStartFeeBps(d.startFeeBps);
      if (typeof d.endFeeBps === 'string') setEndFeeBps(d.endFeeBps);
      if (typeof d.feePeriods === 'string') setFeePeriods(d.feePeriods);
      if (typeof d.feeDuration === 'string') setFeeDuration(d.feeDuration);
      if (typeof d.dynamicFee === 'boolean') setDynamicFee(d.dynamicFee);
      if (typeof d.migrationFeePct === 'string') setMigrationFeePct(d.migrationFeePct);
      if (typeof d.dammFeeBps === 'string') setDammFeeBps(d.dammFeeBps);
      if (typeof d.dammDynamicFee === 'boolean') setDammDynamicFee(d.dammDynamicFee);
      setNotice('Restored your saved draft.');
    } catch {
      /* a corrupt draft is simply ignored */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  // ---- launch flow ----
  async function pollConfirmation(sig: string): Promise<void> {
    const conn = getConnection();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
      const s = st?.value;
      if (s?.err) throw new Error('Transaction failed on-chain');
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Transaction was sent but confirmation timed out — check Solscan before retrying.');
  }

  async function handleLaunch() {
    if (!publicKey) {
      setShowModal(true);
      return;
    }
    setLaunchError(null);
    setTxSig(null);
    try {
      // 1. Metadata URI
      setStatus('uploading');
      let metadataUri: string;
      let imageUrl: string | undefined;
      if (metadataConfigured) {
        const res = await fetch('/api/metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            symbol: symbol.trim().toUpperCase(),
            description: fullDescription,
            image: imageDataUri,
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || 'Metadata upload failed');
        }
        metadataUri = (await res.json()).uri as string;
      } else {
        metadataUri = manualUri.trim();
        if (!/^https:\/\/[^/]+\/.+/.test(metadataUri))
          throw new Error('Enter a valid https metadata JSON URI');
      }
      // Best-effort: pull the image URL out of the metadata for the registry card.
      try {
        const mj = await (await fetch(metadataUri)).json();
        if (mj && typeof mj.image === 'string' && mj.image.startsWith('https://')) imageUrl = mj.image;
      } catch {
        /* card falls back to a letter avatar */
      }

      // 2. Spec + authoritative validation
      const spec = buildSpec(metadataUri);
      const errors = validateLaunchSpec(spec);
      if (errors.length > 0) throw new Error(errors[0]);

      // 2.5 Vanity mint: prefer the instant pool handout, then the
      // background grind (usually finished while the user was designing).
      // If neither is ready, wait here (progress + skip shown below); on
      // skip or failure use a random mint. Launch is never blocked.
      let baseMintKeypair: Keypair;
      if (vanityKeypairRef.current) {
        baseMintKeypair = vanityKeypairRef.current;
      } else {
        setStatus('grinding');
        try {
          const handed = await vanityHandoutPromiseRef.current;
          if (handed) {
            vanityKeypairRef.current = handed;
            baseMintKeypair = handed;
          } else {
            const vp = vanityPromiseRef.current;
            baseMintKeypair = vp ? (await vp).keypair : Keypair.generate();
          }
        } catch {
          baseMintKeypair = Keypair.generate();
        } finally {
          setVanityProgress(null);
        }
      }

      // 3. Build the real createConfigAndPool transaction (fresh config
      //    keypair + the vanity (or fallback) base-mint keypair,
      //    partial-signed inside the builder)
      setStatus('building');
      const built = await buildLaunchTransaction(spec, publicKey, { baseMintKeypair });
      const poolAddr = built.poolAddress.toBase58();
      // The mint keypair is now committed to this launch — grind a fresh
      // one in the background in case the user launches again.
      startVanityGrind();

      // 4. User signs as fee payer in their wallet
      if (!signTransaction) throw new Error('Connected wallet cannot sign transactions');
      setStatus('signing');
      let signed;
      try {
        signed = await signTransaction(built.transaction);
      } catch {
        throw new Error('Wallet signing was rejected — no transaction was sent.');
      }

      // 5. Send the raw signed transaction
      setStatus('sending');
      const sig = await getConnection().sendRawTransaction(signed.serialize());
      setTxSig(sig);

      // 6. Confirm via REST status polling
      setStatus('confirming');
      await pollConfirmation(sig);

      // 7. Register with a wallet-signed message (server verifies ed25519)
      setStatus('registering');
      const timestamp = Date.now();
      const message = buildRegistrationMessageClient(poolAddr, publicKey.toBase58(), timestamp);
      if (!signMessage) throw new Error('Connected wallet cannot sign messages');
      const sigBytes = await signMessage(new TextEncoder().encode(message));
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
          timestamp,
          signature: bs58.encode(sigBytes),
          launchedAt: timestamp,
        }),
      });
      if (!regRes.ok) {
        const j = await regRes.json().catch(() => ({}));
        throw new Error(
          `Pool was created on-chain but registration failed: ${j.error || regRes.status}. ` +
            `Your pool is live at ${poolAddr} — save this address.`,
        );
      }

      setLaunchedPool(poolAddr);
      setStatus('done');
      router.push(`/token/${poolAddr}`);
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : 'Launch failed');
      setStatus('error');
    }
  }

  const busy = status !== 'idle' && status !== 'error' && status !== 'done';
  const solscanTx = txSig
    ? `https://solscan.io/tx/${txSig}${isDevnet() ? '?cluster=devnet' : ''}`
    : null;
  const curveMultiple =
    priceNums.length >= 2 && priceNums[0] > 0 && priceNums.every((p) => Number.isFinite(p) && p > 0)
      ? priceNums[priceNums.length - 1] / priceNums[0]
      : null;
  const isCustom = preset === 'custom';
  const presetName = isCustom
    ? 'Custom'
    : CURVE_PRESETS.find((p) => p.id === preset)?.name ?? 'Custom';
  const allErrors = [...tokenErrors, ...curveErrors, ...econErrors];
  const deployCost = feeRows.length > 0 ? feeRows[0].value : '0 SOL';

  return (
    <Page>
      <Head>
        <title>Launch a Token — Curv</title>
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
          <p>Deploy a fair launch bonding curve. No presale, no team allocation.</p>
        </section>

        {/* Network banner — never hardcode mainnet */}
        <div
          className={cn(
            'rounded-lg border p-3 text-sm',
            isDevnet()
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
              : 'border-rose-500/50 bg-rose-500/10 text-rose-200',
          )}
          style={{ margin: '18px 0 0' }}
        >
          {isDevnet() ? (
            <>
              You are launching on <strong>devnet</strong> ({SOLANA_NETWORK}). No real funds are
              involved; tokens and prices are play money.
            </>
          ) : (
            <>
              You are launching on <strong>MAINNET</strong>. This is real money — review every
              parameter before signing.
            </>
          )}
        </div>

        <div className="sc-launch-builder-grid">
          <form className="sc-launch-builder-form" onSubmit={(e) => e.preventDefault()}>
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
                  <label className="sc-builder-image">
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
                <label className="sc-builder-field">
                  <span>Token Name</span>
                  <input
                    value={name}
                    maxLength={32}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Curve Coin"
                  />
                </label>
                <label className="sc-builder-field">
                  <span>Ticker / Symbol</span>
                  <div className="sc-builder-input-prefix">
                    <b>$</b>
                    <input
                      value={symbol}
                      maxLength={10}
                      onChange={(e) =>
                        setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                      }
                      placeholder="CURV"
                    />
                  </div>
                </label>
              </div>
              <label className="sc-builder-field sc-builder-description">
                <span>Description</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                  placeholder="Tell traders what this token is about…"
                  rows={3}
                />
              </label>
              <p className="mt-2 text-xs text-neutral-500">
                Artwork is optional. PNG, JPEG, WebP or GIF, max 2 MB. Uploaded only when you
                launch.
              </p>
              {imageError && <p className="sc-form-error">{imageError}</p>}
              <ErrorList errors={tokenErrors} />
            </section>

            {/* ---- Token Type ---- */}
            <section className="sc-builder-section">
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">◫</span>
                <div>
                  <h2>Token Type</h2>
                  <p>Choose what your curve represents</p>
                </div>
              </div>
              <div className="sc-token-type-options">
                {(['Memecoin', 'Tokenized Stock'] as const).map((type) => (
                  <button
                    type="button"
                    key={type}
                    aria-pressed={tokenType === type}
                    className={tokenType === type ? 'selected' : ''}
                    onClick={() => setTokenType(type)}
                  >
                    <span className="sc-type-icon">{type === 'Memecoin' ? '◈' : '⌁'}</span>
                    <strong>{type}</strong>
                    <small>
                      {type === 'Memecoin'
                        ? 'Pure bonding curve token. Fair launch, community driven.'
                        : 'Tag your token with a real world stock ticker as a reference.'}
                    </small>
                  </button>
                ))}
              </div>
              {tokenType === 'Tokenized Stock' && (
                <label className="sc-builder-field sc-underlying-field">
                  <span>Underlying Ticker</span>
                  <input
                    value={underlying}
                    maxLength={6}
                    onChange={(e) =>
                      setUnderlying(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))
                    }
                    placeholder="E.G. AAPL, TSLA, NVDA"
                  />
                  <small>Shown as a reference on your token page. It does not move your curve.</small>
                </label>
              )}
            </section>

            {/* ---- Bonding Curve Settings ---- */}
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
                  onClick={() => applyPreset(preset === 'custom' ? 'exponential' : preset, startPrice)}
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
                    onChange={(e) => applyPreset(e.target.value as CurvePresetId, startPrice)}
                  >
                    {CURVE_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <small>{CURVE_PRESETS.find((p) => p.id === preset)?.blurb}</small>
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
                      setStartPrice(e.target.value);
                      if (preset !== 'custom') applyPreset(preset, e.target.value);
                    }}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'Points', value: String(prices.length) },
                    {
                      label: 'Start',
                      value: `${Number.isFinite(priceNums[0]) ? fmtNum(priceNums[0]) : '—'} ${quoteSymbol}`,
                    },
                    {
                      label: 'End',
                      value: `${
                        priceNums.length && Number.isFinite(priceNums[priceNums.length - 1])
                          ? fmtNum(priceNums[priceNums.length - 1])
                          : '—'
                      } ${quoteSymbol}`,
                    },
                    {
                      label: 'Multiple',
                      value: curveMultiple !== null ? `${curveMultiple.toFixed(2)}×` : '—',
                    },
                  ].map((s) => (
                    <div key={s.label} className="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5">
                      <p className="text-xs text-neutral-500">{s.label}</p>
                      <p className="mt-0.5 text-sm font-semibold text-neutral-100">{s.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              {isCustom && (
                <>
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-sm font-medium text-neutral-300">Price points</p>
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
                        <Field key={i} label={`P${i + 1}`}>
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
                      Higher weight concentrates more supply in that segment. Defaults to 1.
                    </p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
                      {weights.map((w, i) => (
                        <Field key={i} label={`P${i + 1}→P${i + 2}`}>
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

            {/* ---- Economics ---- */}
            <section className="sc-builder-section">
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">◎</span>
                <div>
                  <h2>Economics</h2>
                  <p>Quote pair, supply and the fee schedule</p>
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium text-neutral-300">Quote token</p>
                <div
                  className="sc-token-type-options"
                  style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
                >
                  {(
                    [
                      { id: 'SOL', label: 'SOL', sub: 'Native', glyph: '◎' },
                      { id: 'USDC', label: 'USDC', sub: isDevnet() ? 'Devnet stablecoin' : 'Stablecoin', glyph: '$' },
                      { id: 'custom', label: 'Custom', sub: 'Any SPL mint', glyph: '⌁' },
                    ] as const
                  ).map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => setQuoteSel(q.id)}
                      aria-pressed={quoteSel === q.id}
                      className={quoteSel === q.id ? 'selected' : ''}
                    >
                      <span className="sc-type-icon">{q.glyph}</span>
                      <strong>{q.label}</strong>
                      <small>{q.sub}</small>
                    </button>
                  ))}
                </div>
                {quoteSel === 'custom' && (
                  <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div className="md:col-span-2">
                      <Field label="Quote mint address">
                        <input
                          placeholder="SPL mint address"
                          value={customMint}
                          onChange={(e) => setCustomMint(e.target.value)}
                        />
                      </Field>
                    </div>
                    <Field label="Decimals">
                      <input
                        inputMode="numeric"
                        value={customDecimals}
                        onChange={(e) => setCustomDecimals(e.target.value.replace(/[^0-9]/g, ''))}
                      />
                    </Field>
                    <Field label="Symbol">
                      <input
                        placeholder="e.g. AAPLx"
                        value={customSymbol}
                        maxLength={10}
                        onChange={(e) =>
                          setCustomSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                        }
                      />
                    </Field>
                  </div>
                )}
                {quoteSel !== 'custom' && (
                  <p className="mt-2 font-mono text-xs text-neutral-500">{shorten(quoteMint)}</p>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <p className="mb-2 text-sm font-medium text-neutral-300">Base token decimals</p>
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
                            : 'border-neutral-800 bg-neutral-950 text-neutral-300 hover:border-neutral-600',
                        )}
                      >
                        {d} decimals
                      </button>
                    ))}
                  </div>
                </div>
                <Field label="Total supply (tokens)" hint="1,000 – 1,000,000,000,000,000">
                  <input
                    inputMode="numeric"
                    value={totalSupply}
                    onChange={(e) => setTotalSupply(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="sc-builder-range">
                    <span>
                      Starting fee <b>{((parseInt(startFeeBps, 10) || 0) / 100).toFixed(2)}%</b>
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
                    <Field label="Starting fee (basis points)" hint="Fee at launch, decays exponentially">
                      <input
                        inputMode="numeric"
                        value={startFeeBps}
                        onChange={(e) => setStartFeeBps(e.target.value.replace(/[^0-9]/g, ''))}
                      />
                    </Field>
                  </div>
                </div>
                <div>
                  <label className="sc-builder-range">
                    <span>
                      Ending fee <b>{((parseInt(endFeeBps, 10) || 0) / 100).toFixed(2)}%</b>
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
                    <Field label="Ending fee (basis points)" hint="Fee floor once the schedule decays">
                      <input
                        inputMode="numeric"
                        value={endFeeBps}
                        onChange={(e) => setEndFeeBps(e.target.value.replace(/[^0-9]/g, ''))}
                      />
                    </Field>
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field
                  label="Fee decay periods"
                  hint="Steps the fee decays over. 1 or more."
                >
                  <input
                    inputMode="numeric"
                    value={feePeriods}
                    onChange={(e) => setFeePeriods(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                </Field>
                <Field
                  label="Fee decay duration (slots)"
                  hint="Total decay time, at least the periods above. About 0.4s per slot."
                >
                  <input
                    inputMode="numeric"
                    value={feeDuration}
                    onChange={(e) => setFeeDuration(e.target.value.replace(/[^0-9]/g, ''))}
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

            {/* ---- Graduation & migration ---- */}
            <section className="sc-builder-section">
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">▲</span>
                <div>
                  <h2>Graduation and migration</h2>
                  <p>When the pool leaves the bonding curve, and what it costs</p>
                </div>
              </div>
              <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-4">
                <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
                  Graduation threshold
                </p>
                {graduationPreview !== null ? (
                  <p className="text-neutral-100">
                    Graduates to <strong className="text-primary">DAMM v2</strong> at{' '}
                    <strong>
                      ~{graduationPreview.toLocaleString('en-US', { maximumFractionDigits: 4 })}{' '}
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
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto] md:items-end">
                  <Field
                    label={`Graduation target (${quoteSymbol})`}
                    hint="Optional. Rescales the curve so it graduates at this level."
                  >
                    <input
                      inputMode="decimal"
                      placeholder="e.g. 85"
                      value={gradTarget}
                      onChange={(e) => setGradTarget(e.target.value.replace(/[^0-9.]/g, ''))}
                    />
                  </Field>
                  <button
                    type="button"
                    onClick={applyGraduationTarget}
                    className="sc-button sc-button-secondary"
                  >
                    Match curve to target
                  </button>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field
                  label="Migration fee (%)"
                  hint="Taken from the migrating liquidity at graduation. 0-99."
                >
                  <input
                    inputMode="numeric"
                    value={migrationFeePct}
                    onChange={(e) => setMigrationFeePct(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                </Field>
                <Field
                  label="Post-graduation pool fee (bps)"
                  hint="Base fee on the DAMM v2 pool after graduation. 10-1000."
                >
                  <input
                    inputMode="numeric"
                    value={dammFeeBps}
                    onChange={(e) => setDammFeeBps(e.target.value.replace(/[^0-9]/g, ''))}
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
                Locked: you keep 0.3% of every bonding-curve trade and 50% of the
                migration fee. Launching costs no pool creation fee, only Solana
                network fees.
              </p>
            </section>

            {/* ---- Review ---- */}
            <section className="sc-builder-section">
              <div className="sc-builder-section-head">
                <span className="sc-section-glyph">✓</span>
                <div>
                  <h2>Review</h2>
                  <p>Check everything once. Your wallet stays disconnected until you launch.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
                <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-4">
                  <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Token</p>
                  <div className="flex items-center gap-3">
                    {imageDataUri && (
                      <img src={imageDataUri} alt="" className="h-10 w-10 rounded-lg object-cover" />
                    )}
                    <div>
                      <p className="font-semibold text-neutral-100">{name || '—'}</p>
                      <p className="text-neutral-400">${symbol || '—'}</p>
                    </div>
                  </div>
                  {fullDescription && <p className="mt-2 text-neutral-400">{fullDescription}</p>}
                  <p className="mt-2 text-xs text-neutral-500">
                    Type: {tokenType}
                    {tokenType === 'Tokenized Stock' && underlying.trim() && ` · ${underlying.trim()}`}
                  </p>
                </div>
                <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-4">
                  <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Curve</p>
                  <p className="text-neutral-200">
                    {presetName} · {prices.length} points
                  </p>
                  <p className="mt-1 text-neutral-400">
                    {Number.isFinite(priceNums[0]) ? fmtNum(priceNums[0]) : '—'} →{' '}
                    {priceNums.length && Number.isFinite(priceNums[priceNums.length - 1])
                      ? fmtNum(priceNums[priceNums.length - 1])
                      : '—'}{' '}
                    {quoteSymbol}
                    {curveMultiple !== null && (
                      <span className="ml-1 font-semibold text-primary">
                        {curveMultiple.toFixed(2)}×
                      </span>
                    )}
                  </p>
                </div>
                <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-4">
                  <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Economics</p>
                  <p className="text-neutral-200">
                    {parseFloat(totalSupply || '0').toLocaleString('en-US')} supply · {baseDecimals}{' '}
                    decimals
                  </p>
                  <p className="mt-1 text-neutral-400">
                    Quote: {quoteSymbol} ({shorten(quoteMint)})
                  </p>
                  <p className="mt-1 text-neutral-400">
                    Fees: {((parseInt(startFeeBps, 10) || 0) / 100).toFixed(2)}% →{' '}
                    {((parseInt(endFeeBps, 10) || 0) / 100).toFixed(2)}% over{' '}
                    {feePeriods || '—'} periods{dynamicFee ? ' + dynamic' : ''}
                  </p>
                  <p className="mt-1 text-neutral-400">
                    Migration fee: {migrationFeePct || '—'}% · DAMM v2:{' '}
                    {((parseInt(dammFeeBps, 10) || 0) / 100).toFixed(2)}%
                    {dammDynamicFee ? ' + dynamic' : ''}
                  </p>
                </div>
                <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
                  <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Graduation</p>
                  {graduationPreview !== null ? (
                    <p className="text-neutral-100">
                      Graduates to <strong className="text-primary">DAMM v2</strong> at{' '}
                      <strong>
                        ~{graduationPreview.toLocaleString('en-US', { maximumFractionDigits: 4 })}{' '}
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
              </div>

              {metadataConfigured === false && (
                <div className="mt-4">
                  <Field
                    label="Metadata JSON URI"
                    hint="Metadata hosting is not configured on this server. Paste a public https URL to your token metadata JSON."
                  >
                    <input
                      placeholder="https://…/metadata.json"
                      value={manualUri}
                      onChange={(e) => setManualUri(e.target.value)}
                    />
                  </Field>
                </div>
              )}

              <ErrorList errors={allErrors} />
            </section>

            {/* ---- Wallet gate: the entire form is completable without a wallet.
                Connection happens only here, at the final step, and only
                to sign the launch transaction + the registration message. ---- */}
            <section className="sc-builder-section sc-wallet-gate" aria-labelledby="sc-wallet-gate-heading">
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
                    Everything above is complete without a wallet. Connecting signs nothing by
                    itself. Only two signatures happen, both at the final launch step.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowModal(true)}
                    className="sc-button sc-button-primary mt-3"
                  >
                    Connect wallet
                  </button>
                </>
              ) : (
                <p className="text-sm text-neutral-300">
                  Connected. Signing as{' '}
                  <span className="font-mono text-neutral-100">{shorten(publicKey.toBase58())}</span>
                </p>
              )}

              {status !== 'idle' && status !== 'error' && (
                <div className="mt-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
                  <p className="flex items-center gap-2 text-sm font-medium text-primary">
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    {STATUS_LABEL[status as keyof typeof STATUS_LABEL]}
                  </p>
                  {status === 'grinding' && (
                    <div className="mt-3 text-xs text-neutral-400">
                      {vanityProgress && vanityProgress.attemptsPerSecond > 0 ? (
                        <p className="font-mono">
                          {vanityProgress.attempts.toLocaleString('en-US')} attempts ·{' '}
                          {Math.round(vanityProgress.attemptsPerSecond).toLocaleString('en-US')}/s ·{' '}
                          {vanityEta(vanityProgress)}
                        </p>
                      ) : (
                        <p>Starting grind…</p>
                      )}
                      <button
                        type="button"
                        onClick={() => vanityCtrlRef.current?.abort()}
                        className="mt-2 underline hover:text-neutral-200"
                      >
                        Skip — launch with a random address instead
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
                  <Link href={`/token/${launchedPool}`} className="text-neutral-200 underline">
                    View your pool →
                  </Link>
                </div>
              )}
            </section>

            <div className="sc-launch-submit-bar">
              <div>
                <span>EST. DEPLOY COST</span>
                <strong>{deployCost} + network fees</strong>
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
                  disabled={
                    busy ||
                    allErrors.length > 0 ||
                    (metadataConfigured === false && !manualUri.trim())
                  }
                >
                  ↗ Launch Token
                </button>
              </div>
              {notice && (
                <span className="sc-launch-notice" role="status">
                  {notice}
                </span>
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
                      ? `Stocks · ${underlying.trim() || '—'}`
                      : 'Memecoin'}
                  </span>
                </div>
                <div className="sc-preview-card-stats">
                  <span>
                    Mcap<strong>$0</strong>
                  </span>
                  <span>
                    24h<strong>—</strong>
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

            <section className="sc-fees-disclosure" aria-labelledby="sc-fees-heading">
              <div className="sc-live-preview-head">
                <h2 id="sc-fees-heading">Fees</h2>
                <span>From your config</span>
              </div>
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
            </section>

            <section className="sc-builder-section sc-mint-address" aria-labelledby="sc-mint-heading">
              <div className="sc-live-preview-head">
                <h2 id="sc-mint-heading">Mint address</h2>
                <span>
                  {vanityReadyAddress ? (vanitySource === 'pool' ? 'Pre-ground' : 'Ready') : 'Reserving'}
                </span>
              </div>
              {vanityReadyAddress ? (
                <p className="mt-3 font-mono text-sm text-neutral-100">
                  {shorten(vanityReadyAddress)}{' '}
                  <span className="text-primary">ends in &ldquo;{VANITY_SUFFIX}&rdquo; ✓</span>
                </p>
              ) : (
                <p className="mt-3 text-sm text-neutral-400">
                  Reserving your vanity address…
                  {vanityProgress && vanityProgress.attemptsPerSecond > 0 && (
                    <span className="mt-1 block font-mono text-xs">
                      {vanityProgress.attempts.toLocaleString('en-US')} attempts ·{' '}
                      {Math.round(vanityProgress.attemptsPerSecond).toLocaleString('en-US')}/s ·{' '}
                      {vanityEta(vanityProgress)}
                    </span>
                  )}
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                Your coin&rsquo;s address ends in &ldquo;{VANITY_SUFFIX}&rdquo;
                {vanitySource === 'pool'
                  ? ' — claimed instantly from the pre-ground pool.'
                  : ' — ground locally, never leaves your browser.'}
              </p>
            </section>

            <section className="sc-builder-chart-card">
              <div className="sc-builder-chart-title">
                <h2>Curve Preview</h2>
                <span>{presetName}</span>
              </div>
              <div className="mt-3">
                <CurveChart prices={priceNums} quoteSymbol={quoteSymbol} />
              </div>
            </section>

            <div className="sc-curve-explainer">
              <span>ⓘ</span>
              <p>
                Your curve determines the price trajectory as buyers purchase supply. Steeper
                curves reward early buyers more.
              </p>
            </div>
          </aside>
        </div>
      </main>
    </Page>
  );
}
