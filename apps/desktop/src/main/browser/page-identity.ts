/** What the in-app browser already knows about the pages it showed — title,
 *  site icon and a small screenshot — so transcript links and cards can name
 *  a page the way its tab did. Fed only by the browser's own guests; never by
 *  an outside favicon or preview service. Bounded and in memory: it lives for
 *  the app session. */
import type { WebContents } from 'electron';
import type { DesktopBrowserPageIdentity } from '../../shared/contract';
import { isHttpUrl } from './favicon-fetch';

const PAGE_LIMIT = 300;
const ORIGIN_LIMIT = 300;
const THUMBNAIL_LIMIT = 80;
const TITLE_MAX_CHARS = 300;
/** A finished load settles its late paint before the thumbnail is taken. */
const CAPTURE_DELAY_MS = 700;

/** Page key: an http(s) URL without its fragment; null for anything else. */
export function pageIdentityKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

/** A link and the page it loaded often differ only by a trailing slash. */
function keyVariants(key: string): string[] {
  if (new URL(key).search) return [key];
  return [key, key.endsWith('/') ? key.slice(0, -1) : `${key}/`];
}

function boundedMap<V>(limit: number) {
  const map = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key: string, value: V): void {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value as string);
    },
  };
}

export interface BrowserPageIdentityPatch {
  title?: string;
  favicon?: string;
  thumbnail?: string;
}

export function createBrowserPageIdentityStore(options: { onChange?(origin: string): void } = {}) {
  const pages = boundedMap<{ title?: string; favicon?: string }>(PAGE_LIMIT);
  const originFavicons = boundedMap<string>(ORIGIN_LIMIT);
  const thumbnails = boundedMap<string>(THUMBNAIL_LIMIT);

  function update(url: string, patch: BrowserPageIdentityPatch): void {
    const key = pageIdentityKey(url);
    if (!key) return;
    const origin = new URL(key).origin;
    const page = { ...pages.get(key) };
    if (patch.title) page.title = patch.title;
    if (patch.favicon) {
      page.favicon = patch.favicon;
      originFavicons.set(origin, patch.favicon);
    }
    if (patch.title || patch.favicon) pages.set(key, page);
    if (patch.thumbnail) thumbnails.set(key, patch.thumbnail);
    options.onChange?.(origin);
  }

  /** The page's own facts, else the icon of its site; null when the browser
   *  never showed anything there. */
  function lookup(url: string): DesktopBrowserPageIdentity | null {
    const key = pageIdentityKey(url);
    if (!key) return null;
    let page: { title?: string; favicon?: string } | undefined;
    let thumbnail: string | undefined;
    for (const variant of keyVariants(key)) {
      page ??= pages.get(variant);
      thumbnail ??= thumbnails.get(variant);
    }
    const favicon = page?.favicon ?? originFavicons.get(new URL(key).origin);
    if (!page?.title && !favicon && !thumbnail) return null;
    return {
      url,
      ...(page?.title ? { title: page.title } : {}),
      ...(favicon ? { favicon } : {}),
      ...(thumbnail ? { thumbnail } : {}),
    };
  }

  return { update, lookup };
}

export type BrowserPageIdentityStore = ReturnType<typeof createBrowserPageIdentityStore>;

/** Feed `store` from one guest: its title and favicon as the page reports
 *  them, and a thumbnail once a load has stopped. A redirected load is filed
 *  under the address that was asked for as well as the one that answered. */
export function trackBrowserPageIdentity(
  guest: WebContents,
  store: BrowserPageIdentityStore,
  read: {
    /** `url` is an icon address `pageUrl` declared; it is loaded as that
     *  page's subresource. */
    favicon(url: string, pageUrl: string): Promise<string | null>;
    thumbnail(guest: WebContents): Promise<string | null>;
  }
): void {
  let requested = '';
  let faviconGeneration = 0;
  let captureTimer: ReturnType<typeof setTimeout> | null = null;
  const pageUrls = () => {
    const current = guest.getURL();
    return requested && requested !== current ? [current, requested] : [current];
  };
  const record = (urls: string[], patch: BrowserPageIdentityPatch) => {
    for (const url of urls) store.update(url, patch);
  };
  guest.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    requested = details.url;
    faviconGeneration++;
  });
  guest.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) requested = '';
  });
  guest.on('page-title-updated', (_event, title) => {
    const value = String(title || '')
      .trim()
      .slice(0, TITLE_MAX_CHARS);
    if (value) record(pageUrls(), { title: value });
  });
  guest.on('page-favicon-updated', (_event, favicons) => {
    // Only an address the page itself declared, on any http(s) origin (a CDN
    // included); anything else keeps the globe.
    const pageUrl = guest.getURL();
    const source = favicons.find((url) => /^data:image\//i.test(url) || isHttpUrl(url));
    if (!source) return;
    const urls = pageUrls();
    const generation = ++faviconGeneration;
    void read.favicon(source, pageUrl).then(
      (favicon) => {
        if (favicon && generation === faviconGeneration) record(urls, { favicon });
      },
      () => undefined
    );
  });
  guest.on('did-stop-loading', () => {
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = setTimeout(() => {
      captureTimer = null;
      if (guest.isDestroyed() || guest.isLoadingMainFrame()) return;
      const urls = pageUrls();
      if (!pageIdentityKey(urls[0])) return;
      void read.thumbnail(guest).then(
        (thumbnail) => {
          if (thumbnail && !guest.isDestroyed() && guest.getURL() === urls[0]) record(urls, { thumbnail });
        },
        () => undefined
      );
    }, CAPTURE_DELAY_MS);
    captureTimer.unref?.();
  });
  guest.once('destroyed', () => {
    if (captureTimer) clearTimeout(captureTimer);
  });
}
