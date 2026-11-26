import type { WebContents } from 'electron';
import type { DesktopBrowserPageIdentity } from '../../shared/contract';
import { isHttpUrl } from './favicon-fetch';

const PAGE_LIMIT = 300;
const ORIGIN_LIMIT = 300;
const THUMBNAIL_LIMIT = 80;
export const TITLE_MAX_CHARS = 300;
/** Restored data URLs above these sizes are not ours and are dropped. */
const FAVICON_MAX_CHARS = 64 * 1024;
const THUMBNAIL_MAX_CHARS = 256 * 1024;
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

function boundedMap<V>(limit: number, onEvict?: (value: V) => void) {
  const map = new Map<string, V>();
  const evictOverflow = (): void => {
    while (map.size > limit) {
      const oldestKey = map.keys().next().value as string;
      const evicted = map.get(oldestKey);
      map.delete(oldestKey);
      if (evicted !== undefined) onEvict?.(evicted);
    }
  };
  return {
    has: (key: string) => map.has(key),
    /** Oldest first, so replaying them restores the recency order. */
    entries: () => [...map],
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
      evictOverflow();
    },
    deleteIf(key: string, expected: V): boolean {
      if (map.get(key) !== expected) return false;
      map.delete(key);
      return true;
    },
    /** Older entries placed beneath the live ones: a live key keeps its
     *  value, and over the limit the older entries go first. */
    seed(older: [string, V][]): void {
      const live = [...map];
      map.clear();
      for (const [key, value] of older) map.set(key, value);
      for (const [key, value] of live) {
        map.delete(key);
        map.set(key, value);
      }
      evictOverflow();
    },
  };
}

export interface BrowserPageThumbnailStorage {
  /** Persist a data URL to disk and return the compact URL kept in memory. */
  put(key: string, dataUrl: string): string | null;
  /** Validate a restored disk thumbnail URL. */
  accept?(thumbnailUrl: string): boolean;
  /** Remove an evicted thumbnail file from disk. */
  remove?(thumbnailUrl: string): void;
}

interface PageFacts {
  title?: string;
  favicon?: string;
}

export interface BrowserPageIdentityPatch {
  title?: string;
  favicon?: string;
  thumbnail?: string;
}

export interface BrowserPageIdentitySnapshot {
  pages: [string, PageFacts][];
  origins: [string, string][];
  thumbnails: [string, string][];
}

const snapshotList = (value: unknown): unknown[][] =>
  Array.isArray(value) ? value.filter((entry): entry is unknown[] => Array.isArray(entry)) : [];
const snapshotText = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value && value.length <= max ? value : undefined;
const snapshotImage = (value: unknown, max: number): string | undefined => {
  const text = snapshotText(value, max);
  return text && /^data:image\//i.test(text) ? text : undefined;
};

export function createBrowserPageIdentityStore(
  options: { onChange?(origin: string): void; onMigrated?(): void; thumbnails?: BrowserPageThumbnailStorage } = {}
) {
  const thumbStorage = options.thumbnails;
  const pages = boundedMap<PageFacts>(PAGE_LIMIT);
  const originFavicons = boundedMap<string>(ORIGIN_LIMIT);
  const thumbnails = boundedMap<string>(THUMBNAIL_LIMIT, (evicted) => {
    // Only remove from disk when evicted (not when replaced by another version of the same file).
    thumbStorage?.remove?.(evicted);
  });

  function storeThumbnail(key: string, value: string): void {
    if (!thumbStorage) {
      thumbnails.set(key, value);
      return;
    }
    const stored = thumbStorage.put(key, value);
    if (!stored) return;
    const previous = thumbnails.get(key);
    thumbnails.set(key, stored);
    if (previous && previous.split('?', 1)[0] !== stored.split('?', 1)[0]) {
      thumbStorage.remove?.(previous);
    }
  }

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
    if (patch.thumbnail) storeThumbnail(key, patch.thumbnail);
    options.onChange?.(origin);
  }

  /** The page's own facts, else the icon of its site; null when the browser
   *  never showed anything there. */
  function lookup(url: string): DesktopBrowserPageIdentity | null {
    const key = pageIdentityKey(url);
    if (!key) return null;
    let page: PageFacts | undefined;
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

  function snapshot(): BrowserPageIdentitySnapshot {
    return { pages: pages.entries(), origins: originFavicons.entries(), thumbnails: thumbnails.entries() };
  }

  /** Put a saved snapshot back under what this session already recorded;
   *  anything malformed is skipped. Returns the origins it filled, without
   *  reporting them as changes. */
  function restore(saved: unknown): string[] {
    const data = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
    const filled = new Set<string>();
    const savedPages: [string, PageFacts][] = [];
    for (const [url, value] of snapshotList(data.pages)) {
      const key = typeof url === 'string' ? pageIdentityKey(url) : null;
      if (!key || key !== url || pages.has(key)) continue;
      const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
      const title = snapshotText(record.title, TITLE_MAX_CHARS);
      const favicon = snapshotImage(record.favicon, FAVICON_MAX_CHARS);
      if (!title && !favicon) continue;
      savedPages.push([key, { ...(title ? { title } : {}), ...(favicon ? { favicon } : {}) }]);
      filled.add(new URL(key).origin);
    }
    const savedOrigins: [string, string][] = [];
    for (const [origin, value] of snapshotList(data.origins)) {
      const key = typeof origin === 'string' ? pageIdentityKey(origin) : null;
      const favicon = snapshotImage(value, FAVICON_MAX_CHARS);
      if (!key || new URL(key).origin !== origin || !favicon || originFavicons.has(origin)) continue;
      savedOrigins.push([origin, favicon]);
      filled.add(origin);
    }
    const savedThumbnails: [string, string][] = [];
    let migrated = false;
    for (const [url, value] of snapshotList(data.thumbnails)) {
      const key = typeof url === 'string' ? pageIdentityKey(url) : null;
      if (!key || key !== url || thumbnails.has(key)) continue;
      let thumbnail: string | undefined;
      if (thumbStorage) {
        if (typeof value === 'string' && thumbStorage.accept?.(value)) {
          thumbnail = thumbStorage.put(key, value) ?? undefined;
        } else {
          const legacyData = snapshotImage(value, THUMBNAIL_MAX_CHARS);
          if (legacyData) {
            thumbnail = thumbStorage.put(key, legacyData) ?? undefined;
            if (thumbnail) migrated = true;
          }
        }
      } else {
        thumbnail = snapshotImage(value, THUMBNAIL_MAX_CHARS);
      }
      if (!thumbnail) continue;
      savedThumbnails.push([key, thumbnail]);
      filled.add(new URL(key).origin);
    }
    pages.seed(savedPages);
    originFavicons.seed(savedOrigins);
    thumbnails.seed(savedThumbnails);
    if (migrated) options.onMigrated?.();
    return [...filled];
  }

  function dropThumbnail(key: string, expectedUrl: string): void {
    const normalized = pageIdentityKey(key);
    if (!normalized) return;
    if (!thumbnails.deleteIf(normalized, expectedUrl)) return;
    options.onChange?.(new URL(normalized).origin);
  }

  return { update, lookup, snapshot, restore, dropThumbnail };
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
