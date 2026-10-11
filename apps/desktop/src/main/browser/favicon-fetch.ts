/** The network half of reading a site icon: only the icon address the page
 *  itself declared, loaded the way the page would load it (its session's
 *  cookies and cache, the page as referrer), on any http(s) origin. Every
 *  redirect hop is checked before it is followed, the body is streamed under
 *  a byte cap and the whole read runs under one timeout. Electron-free so the
 *  limits can be tested directly. */

export const FAVICON_MAX_BYTES = 128 * 1024;
export const FAVICON_TIMEOUT_MS = 5000;
const FAVICON_MAX_REDIRECTS = 3;

type FaviconFetch = (url: string, init: RequestInit) => Promise<Response>;

/** scheme+host+port of an http(s) URL; null for anything else. */
export function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Whether a declared icon address may be loaded at all: http(s) only. */
export function isHttpUrl(url: string): boolean {
  return httpOrigin(url) !== null;
}

/** Text that really is SVG markup (not HTML or an error page labelled SVG). */
export function looksLikeSvg(text: string): boolean {
  return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text);
}

/** Bytes and content type of the icon the page at `pageUrl` declared at
 *  `url`, or null when either is not http(s), a redirect leaves http(s) or
 *  exceeds the hop limit, or the body is too large, fails or times out. */
export async function fetchDeclaredFavicon(
  fetch: FaviconFetch,
  url: string,
  pageUrl: string,
  limits: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<{ bytes: Buffer; type: string } | null> {
  if (!isHttpUrl(pageUrl) || !isHttpUrl(url)) return null;
  const maxBytes = limits.maxBytes ?? FAVICON_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs ?? FAVICON_TIMEOUT_MS);
  try {
    let target = url;
    for (let hop = 0; ; hop++) {
      const response = await fetch(target, {
        cache: 'force-cache',
        credentials: 'include',
        redirect: 'manual',
        referrer: pageUrl,
        signal: controller.signal,
      });
      // Hops are followed here so each one is checked; a response that moved
      // on its own was not.
      if (response.type === 'opaqueredirect' || response.redirected) return null;
      if (response.url && !isHttpUrl(response.url)) return null;
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        let next = '';
        try {
          next = location ? new URL(location, target).href : '';
        } catch {
          return null;
        }
        if (!next || !isHttpUrl(next) || hop >= FAVICON_MAX_REDIRECTS) return null;
        target = next;
        continue;
      }
      if (!response.ok || !response.body) return null;
      if (Number(response.headers.get('content-length') || 0) > maxBytes) return null;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
      if (!total) return null;
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      return { bytes: Buffer.concat(chunks), type };
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // Every exit releases the request: a rejected response's body is never left open.
    controller.abort();
  }
}
