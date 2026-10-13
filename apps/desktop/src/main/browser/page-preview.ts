/** A page card's fallback when the browser holds no screenshot of its page
 *  (recorded before a restart was saved, or never painted): the page's own
 *  markup, read once through the browser session the way the page would
 *  load (its cookies and HTTP cache first). Only the head is read; the image
 *  is the one the page declares for link previews. Requests are deferred,
 *  deduplicated per page and run two at a time. Electron-free so the limits
 *  can be tested directly. */
import type { DesktopBrowserPageIdentity } from '../../shared/contract';
import { isHttpUrl } from './favicon-fetch';
import { pageIdentityKey, TITLE_MAX_CHARS, type BrowserPageIdentityPatch } from './page-identity';

const HEAD_MAX_BYTES = 256 * 1024;
const PREVIEW_TIMEOUT_MS = 5000;
/** A page that just loaded files its own screenshot within about a second. */
const PREVIEW_DELAY_MS = 2000;
const PREVIEW_CONCURRENCY = 2;
const ATTEMPT_LIMIT = 500;
export const PREVIEW_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

type PreviewFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PagePreviewMarkup {
  /** The address that answered, after redirects. */
  url: string;
  title?: string;
  /** Link-preview image (og:image / twitter:image), absolute http(s). */
  image?: string;
  /** First declared icon: absolute http(s) or a data:image URL. */
  icon?: string;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, dec, hex, name) => {
    if (dec || hex) {
      try {
        return String.fromCodePoint(Number.parseInt(dec ?? hex, dec ? 10 : 16));
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? match;
  });
}

function tagAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

function absoluteHttpUrl(value: string, base: string): string | undefined {
  try {
    const url = new URL(value.trim(), base).href;
    return isHttpUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Title, preview image and icon a page's head declares. */
export function parsePreviewMarkup(html: string, baseUrl: string): Omit<PagePreviewMarkup, 'url'> {
  const meta = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = tagAttributes(tag);
    const name = (attributes.get('property') || attributes.get('name') || '').toLowerCase();
    const content = attributes.get('content')?.trim();
    if (name && content && !meta.has(name)) meta.set(name, content);
  }
  let icon: string | undefined;
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = tagAttributes(tag);
    if (!(attributes.get('rel') || '').toLowerCase().split(/\s+/).includes('icon')) continue;
    const href = attributes.get('href')?.trim();
    if (!href) continue;
    icon = /^data:image\//i.test(href) ? href : absoluteHttpUrl(href, baseUrl);
    if (icon) break;
  }
  const imageSource = ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src']
    .map((name) => meta.get(name))
    .find(Boolean);
  const image = imageSource ? absoluteHttpUrl(imageSource, baseUrl) : undefined;
  const titleTag = /<title\b[^>]*>([^<]*)<\/title\s*>/i.exec(html)?.[1] ?? '';
  const title = (
    decodeEntities(titleTag).replace(/\s+/g, ' ').trim() ||
    meta.get('og:title') ||
    meta.get('twitter:title') ||
    ''
  ).slice(0, TITLE_MAX_CHARS);
  return { ...(title ? { title } : {}), ...(image ? { image } : {}), ...(icon ? { icon } : {}) };
}

/** The head of the HTML page at `url`, parsed; null when it is not an
 *  http(s) HTML page that answered in time. Reading stops at the end of the
 *  head or a byte cap, whichever comes first. */
export async function fetchPagePreviewMarkup(
  fetch: PreviewFetch,
  url: string,
  limits: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<PagePreviewMarkup | null> {
  if (!isHttpUrl(url)) return null;
  const maxBytes = limits.maxBytes ?? HEAD_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs ?? PREVIEW_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: 'force-cache',
      credentials: 'include',
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    });
    const answered = response.url || url;
    if (!response.ok || !response.body || !isHttpUrl(answered)) return null;
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('html')) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, maxBytes - total);
      total += chunk.byteLength;
      html += decoder.decode(chunk, { stream: true });
      // Nothing past the head is parsed, even when it arrived in the same chunk.
      const end = html.search(/<\/head\s*>|<body[\s>]/i);
      if (end >= 0) {
        html = html.slice(0, end);
        break;
      }
      if (total >= maxBytes) break;
    }
    return { url: answered, ...parsePreviewMarkup(html, answered) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // Every exit releases the request, including a body left unread.
    controller.abort();
  }
}

/** Previews for page cards: each page at most once per app session (up to
 *  a fixed number of pages), only after `ready` (the saved identities are
 *  back) and a short delay, and only while the page still has no screenshot.
 *  A finished preview fills only what is still missing then, so facts the
 *  browser recorded meanwhile win. */
export function createBrowserPagePreviews(host: {
  ready?: Promise<unknown>;
  lookup(url: string): DesktopBrowserPageIdentity | null;
  read(url: string): Promise<BrowserPageIdentityPatch | null>;
  record(url: string, patch: BrowserPageIdentityPatch): void;
  delayMs?: number;
}) {
  const has = (url: string) => Boolean(host.lookup(url)?.thumbnail);
  const record = (url: string, patch: BrowserPageIdentityPatch) => {
    const known = host.lookup(url);
    if (known?.thumbnail) return;
    const missing: BrowserPageIdentityPatch = {
      ...(patch.thumbnail ? { thumbnail: patch.thumbnail } : {}),
      ...(patch.title && !known?.title ? { title: patch.title } : {}),
      ...(patch.favicon && !known?.favicon ? { favicon: patch.favicon } : {}),
    };
    if (Object.keys(missing).length) host.record(url, missing);
  };
  const attempted = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const queue: string[] = [];
  let active = 0;
  let disposed = false;

  function pump(): void {
    while (!disposed && active < PREVIEW_CONCURRENCY && queue.length) {
      const url = queue.shift()!;
      if (has(url)) continue;
      active++;
      void host
        .read(url)
        .then(
          (patch) => {
            if (patch && !disposed) record(url, patch);
          },
          () => undefined
        )
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  function request(url: string): void {
    const key = pageIdentityKey(url);
    // At the limit no new page is admitted: a forgotten one would be read again.
    if (disposed || !key || attempted.has(key) || attempted.size >= ATTEMPT_LIMIT || has(url)) return;
    attempted.add(key);
    const timer = setTimeout(() => {
      timers.delete(timer);
      void Promise.resolve(host.ready)
        .catch(() => undefined)
        .then(() => {
          queue.push(url);
          pump();
        });
    }, host.delayMs ?? PREVIEW_DELAY_MS);
    timer.unref?.();
    timers.add(timer);
  }

  function dispose(): void {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    queue.length = 0;
  }

  return { request, dispose };
}
