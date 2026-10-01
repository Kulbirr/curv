/**
 * Normalize an X (Twitter) handle or profile URL to a canonical
 * https://x.com/<handle> link. Returns null for empty input or for input
 * that is not a plausible handle (X handles are 1-15 word characters).
 * Shared by the launch form (client) and the registration validator
 * (server) so both sides agree on the stored shape.
 */
export function normalizeTwitterUrl(raw: string): string | null {
  let t = raw.trim();
  if (t.length === 0) return null;
  if (t.length > 200) return null;
  t = t
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?(x\.com|twitter\.com)\//i, '')
    .replace(/^@/, '')
    .split('/')[0]
    .split('?')[0]
    .trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(t)) return null;
  return `https://x.com/${t}`;
}
