/**
 * The network policy of a visualize HTML page, in one place. On the desktop
 * the main process enforces it on the window's session (`lease-guard.ts`,
 * `host-page-observer.ts`); a paired remote device has no such session, so its
 * frame enforces the same policy with a CSP built from the constants here.
 * While a tab has not allowed network, a page may reach only its own files:
 * http(s) and ws(s) addresses are refused and reported as `blocked-network`.
 */

/** The schemes of the outside network. Everything else (data:, blob:…) is not network. */
export const OUTSIDE_NETWORK_SCHEMES = ['http', 'https', 'ws', 'wss'] as const;

/** `webRequest` URL patterns matching exactly the outside network. */
export const OUTSIDE_NETWORK_URL_PATTERNS: string[] = OUTSIDE_NETWORK_SCHEMES.map((scheme) => `${scheme}://*/*`);

export function isOutsideNetworkUrl(url: URL): boolean {
  return (OUTSIDE_NETWORK_SCHEMES as readonly string[]).includes(url.protocol.slice(0, -1));
}

/** The `blocked-network` problem text: the refused host and what asked for it
 *  (an Electron `resourceType`: script, image, xhr…). */
export function blockedNetworkMessage(host: string, resourceType: string): string {
  return `${host} (${resourceType})`;
}

/** A CSP that allows everything but the outside network: no http(s)/ws(s)
 *  source in any fetch directive (default-src covers them all), while inline
 *  script and style, eval, `data:` and `blob:` keep working as on the desktop. */
export const BLOCKED_NETWORK_CSP = "default-src data: blob: 'unsafe-inline' 'unsafe-eval'";

/** The Electron resource type of a request the CSP refused, from the violated
 *  directive (`securitypolicyviolation.effectiveDirective`) and the address. */
export function blockedResourceType(directive: string, url: URL): string {
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return 'webSocket';
  const kind = directive.split('-')[0];
  switch (kind) {
    case 'script':
      return 'script';
    case 'img':
      return 'image';
    case 'style':
      return 'stylesheet';
    case 'font':
      return 'font';
    case 'media':
      return 'media';
    case 'frame':
      return 'subFrame';
    case 'connect':
      return 'xhr';
    default:
      return 'other';
  }
}
