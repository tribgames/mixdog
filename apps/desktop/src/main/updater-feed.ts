export function normalizeUpdaterDevFeed(value: unknown): string | null {
  const input = String(value ?? '').trim();
  if (!input) return null;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const loopback = url.hostname === '127.0.0.1'
    || url.hostname === '::1'
    || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback || url.username || url.password) return null;
  return url.toString();
}
