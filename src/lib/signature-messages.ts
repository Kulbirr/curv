/**
 * Domain-separated wallet-signed message builders.
 *
 * Pure functions with no Node imports, so both the browser bundle and the
 * server can import them. The server verifies these with ed25519 in
 * src/lib/signatures.ts; the browser builds the identical strings before
 * calling wallet.signMessage(). Keeping both sides in one module means the
 * formats cannot drift apart.
 */

import type { FeeSplitRecipient } from './fee-split-terms';

/** Wallet-signed backend writes expire after 5 minutes to prevent replays. */
export const SIGNATURE_TTL_MS = 5 * 60 * 1000;

/**
 * Canonical fee split terms for the signature: wallets sorted, no
 * handles' @, handles included (they are part of the public record).
 * Empty when there are no splits, so registrations without splits keep
 * the exact historical message format.
 */
export function canonicalFeeSplitsTerms(recipients: FeeSplitRecipient[] | undefined): string {
  if (!recipients || recipients.length === 0) return '';
  const rendered = recipients.map((r) => {
    // Platform prefix binds the handle's platform into the signature.
    // No prefix means X (all rows predate platforms).
    const platform = r.platform && r.platform !== 'x' ? `${r.platform}:` : '';
    return r.wallet
      ? `${r.wallet}:${r.bps}${r.handle ? `:${platform}${r.handle}` : ''}`
      : `@${platform}${r.handle}:${r.bps}`;
  });
  return rendered.sort().join(',');
}

export function buildRegistrationMessage(
  poolAddress: string,
  creator: string,
  timestamp: number,
  feeSplits?: FeeSplitRecipient[],
  devBuyLamports?: number | null,
  buybackBps?: number | null,
  bountyBps?: number | null,
  traderReward?: { count: number; bps: number } | null,
): string {
  const lines = [
    'StockCurve pool registration',
    `pool: ${poolAddress}`,
    `creator: ${creator}`,
    `timestamp: ${timestamp}`,
  ];
  const terms = canonicalFeeSplitsTerms(feeSplits);
  if (terms) lines.push(`fee splits: ${terms}`);
  // The dev buy the creator disclosed. Bound into the signature so the
  // server stores exactly what the creator committed, and the trust
  // panel can show it from block one.
  if (devBuyLamports) lines.push(`dev buy: ${devBuyLamports} lamports`);
  // The buyback and burn commitment. Bound into the signature so it is
  // immutable and publicly verifiable from launch.
  if (buybackBps) lines.push(`buyback: ${buybackBps} bps`);
  // The bounty funding commitment. Bound into the signature so it is
  // immutable and publicly verifiable from launch.
  if (bountyBps) lines.push(`bounty: ${bountyBps} bps`);
  // The trader rewards commitment: top N net buyers split bps of the
  // creator fee, winners decided at graduation. Bound into the
  // signature so the rule is immutable and publicly verifiable.
  if (traderReward && traderReward.bps > 0) {
    lines.push(`trader rewards: top ${traderReward.count} net buyers split ${traderReward.bps} bps`);
  }
  return lines.join('\n');
}

/**
 * Creator-signed bounty actions (create, finalize, cancel). The message
 * names the pool, the action, and a timestamp, so the signature proves
 * the pool creator authorized this exact action and cannot be replayed
 * for another one.
 */
export function buildBountyActionMessage(
  poolAddress: string,
  action: 'create' | 'finalize' | 'cancel',
  bountyId: number | null,
  timestamp: number,
): string {
  return [
    'Curv bounty action',
    `pool: ${poolAddress}`,
    `action: ${action}`,
    `bounty: ${bountyId === null ? 'new' : bountyId}`,
    `timestamp: ${timestamp}`,
  ].join('\n');
}

/**
 * Binds a metadata/R2 upload to the wallet that is about to launch the
 * token, so anonymous clients cannot use Curv's bucket as free storage.
 * Signed during the launch flow, before the on-chain transaction.
 */
export function buildMetadataUploadMessage(wallet: string, timestamp: number): string {
  return ['Curv metadata upload', `wallet: ${wallet}`, `timestamp: ${timestamp}`].join(
    '\n',
  );
}

export function isFreshTimestamp(timestamp: number): boolean {
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) <= SIGNATURE_TTL_MS;
}

/**
 * Message a collaborator signs to bind their wallet to one fee split
 * entry. Domain-separated, names the pool, the entry index, the wallet
 * and a fresh timestamp so a binding signature cannot be replayed
 * against another pool, entry or wallet.
 */
export function buildRecipientBindingMessage(
  poolAddress: string,
  entryIndex: number,
  wallet: string,
  timestamp: number,
): string {
  return [
    'Curv recipient binding',
    `pool: ${poolAddress}`,
    `entry: ${entryIndex}`,
    `wallet: ${wallet}`,
    `timestamp: ${timestamp}`,
    'Binding is permanent: the first valid signature wins.',
  ].join('\n');
}
