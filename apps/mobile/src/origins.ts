// Which origins may load in the app's WebView and talk to the native bridge:
// the bundled pairing screen and the relay origins of paired hosts — nothing
// else. The same rules live in android `OriginPolicy.java` and ios
// `MixdogOriginPolicy.swift`; test-vectors/origin-policy.json pins all three.
import type { HostBook } from './hosts.ts';

/** The bundled pairing screen: Android serves it at https://localhost
 *  (capacitor `androidScheme`), iOS at capacitor://localhost. */
export const BUNDLED_ORIGINS: readonly string[] = ['https://localhost', 'capacitor://localhost'];
export const MAX_ORIGINS = 32;

const ORIGIN = /^([a-z][a-z0-9+.-]*):\/\/(\[[0-9a-f:]+\]|[^/?#:@[\]\s]+)(?::(\d+))?(?:[/?#]|$)/iu;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_PORTS: Record<string, string> = { 'https:': '443', 'http:': '80' };

/** `scheme://host[:port]` (lower-case, default port dropped) of a URL, or null
 *  when it is not an http(s) / bundled-app URL or carries credentials. */
export function originOf(url: unknown): string | null {
  const match = ORIGIN.exec(String(url ?? '').trim());
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  if (scheme === 'capacitor') return host === 'localhost' && !match[3] ? 'capacitor://localhost' : null;
  if (scheme !== 'https' && scheme !== 'http') return null;
  const port = match[3] && match[3] !== DEFAULT_PORTS[`${scheme}:`] ? `:${Number(match[3])}` : '';
  return `${scheme}://${host}${port}`;
}

/** A remote origin the app may ever load: https, or http on a loopback host. */
export function isRemoteOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  const parsed = ORIGIN.exec(origin);
  if (!parsed) return false;
  const scheme = parsed[1].toLowerCase();
  if (scheme === 'https') return true;
  return scheme === 'http' && LOOPBACK_HOSTS.has(parsed[2].toLowerCase());
}

/** Clean list of remote origins (deduplicated, bounded). */
export function sanitizeOrigins(list: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    const origin = originOf(item);
    if (isRemoteOrigin(origin) && !BUNDLED_ORIGINS.includes(origin) && !out.includes(origin)) out.push(origin);
    if (out.length >= MAX_ORIGINS) break;
  }
  return out;
}

export function isAllowedUrl(url: unknown, saved: readonly string[]): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  return BUNDLED_ORIGINS.includes(origin) || saved.includes(origin);
}

export function originsOfBook(book: HostBook): string[] {
  return sanitizeOrigins(book.hosts.map((host) => host.url));
}
