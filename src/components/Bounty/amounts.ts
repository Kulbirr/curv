/** Format a raw integer amount into UI units. Never shows raw units. */
export function formatRawAmount(raw: string | null | undefined, decimals: number, symbol: string): string {
  if (!raw) return `0 ${symbol}`;
  try {
    const big = BigInt(raw);
    const neg = big < BigInt(0);
    const abs = neg ? -big : big;
    const div = BigInt(10) ** BigInt(decimals);
    const whole = abs / div;
    const frac = abs % div;
    let fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    if (fracStr.length > 4) fracStr = fracStr.slice(0, 4);
    const ui = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
    return `${neg ? '-' : ''}${ui} ${symbol}`;
  } catch {
    return `0 ${symbol}`;
  }
}

/** Parse a UI-unit decimal string into raw integer units. */
export function parseUiAmount(ui: string, decimals: number): string | null {
  const t = String(ui || '').trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  try {
    return (BigInt(w) * BigInt(10) ** BigInt(decimals) + BigInt(frac || '0')).toString();
  } catch {
    return null;
  }
}
