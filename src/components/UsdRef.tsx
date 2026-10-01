/**
 * Tiny "ref" marker shown next to USD figures on devnet.
 *
 * Devnet tokens are play money, but their USD conversions use the live
 * mainnet SOL price as a reference (same mint address). The marker keeps
 * that honest: the number is a reference conversion, not real value.
 */
export function UsdRef({
  reference,
  hasUsd,
}: {
  /** True when the USD figure is a reference (devnet). */
  reference: boolean | undefined;
  /** True when a USD figure is actually being displayed. */
  hasUsd: boolean;
}) {
  if (!reference || !hasUsd) return null;
  return (
    <span
      className="sc-usd-ref"
      title="Reference value: devnet tokens have no real value, converted here at the live mainnet SOL price."
    >
      ref
    </span>
  );
}
