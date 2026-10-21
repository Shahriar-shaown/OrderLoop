/**
 * A tracking link from a courier, or undefined. Only absolute https:// links without embedded credentials are kept: the value is
 * stored and shown to staff as a clickable link, so `javascript:`, `data:`, `http:` (readable and alterable on the path) and
 * `https://user:pass@host` (a classic disguise) are dropped, never repaired.
 */
export function httpsLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > 2000) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname)
      return undefined;
    return text;
  } catch {
    return undefined;
  }
}
