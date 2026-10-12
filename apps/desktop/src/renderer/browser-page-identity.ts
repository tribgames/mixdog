/** Renderer view of what the in-app browser saw of a page (title, site icon,
 *  thumbnail). Each address is asked for once, then again only when the
 *  browser reports a change on its site. Nothing here touches the network. */
import { useCallback, useSyncExternalStore } from 'react';
import type { DesktopBrowserPageIdentity } from '../shared/contract';

const ENTRY_LIMIT = 300;

interface Entry {
  identity: DesktopBrowserPageIdentity | null;
  listeners: Set<() => void>;
  requested: boolean;
  generation: number;
}

const entries = new Map<string, Entry>();
let unsubscribeChanges: (() => void) | null = null;

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function request(url: string, entry: Entry): void {
  const read = typeof window === 'undefined' ? undefined : window.mixdogDesktop?.browserPageIdentity;
  if (!read) return;
  entry.requested = true;
  const generation = ++entry.generation;
  read(url).then(
    (identity) => {
      if (generation !== entry.generation) return;
      entry.identity = identity ?? null;
      for (const listener of entry.listeners) listener();
    },
    () => undefined
  );
}

function watchChanges(): void {
  if (unsubscribeChanges || typeof window === 'undefined') return;
  const subscribe = window.mixdogDesktop?.onBrowserPageIdentityChanged;
  if (!subscribe) return;
  unsubscribeChanges = subscribe((origin) => {
    for (const [url, entry] of entries) {
      if (originOf(url) !== origin) continue;
      if (entry.listeners.size) request(url, entry);
      else entry.requested = false;
    }
  });
}

function entryFor(url: string): Entry {
  let entry = entries.get(url);
  if (!entry) {
    entry = { identity: null, listeners: new Set(), requested: false, generation: 0 };
    entries.set(url, entry);
    for (const [key, old] of entries) {
      if (entries.size <= ENTRY_LIMIT) break;
      if (!old.listeners.size) entries.delete(key);
    }
  }
  return entry;
}

function subscribe(url: string, listener: () => void): () => void {
  if (!url) return () => undefined;
  const entry = entryFor(url);
  entry.listeners.add(listener);
  watchChanges();
  if (!entry.requested) request(url, entry);
  return () => entry.listeners.delete(listener);
}

/** What the in-app browser recorded for `url`; null until (and unless) known. */
export function useBrowserPageIdentity(url: string | undefined): DesktopBrowserPageIdentity | null {
  const key = url && originOf(url) ? url : '';
  const watch = useCallback((listener: () => void) => subscribe(key, listener), [key]);
  const snapshot = () => (key ? (entries.get(key)?.identity ?? null) : null);
  return useSyncExternalStore(watch, snapshot, snapshot);
}

/** The icon of `url`'s site, when the in-app browser has shown that site. */
export function useBrowserSiteFavicon(url: string | undefined): string | undefined {
  const origin = url ? originOf(url) : null;
  return useBrowserPageIdentity(origin ? `${origin}/` : undefined)?.favicon;
}

/** Test seam: forget every cached answer and the change subscription. */
export function resetBrowserPageIdentityCache(): void {
  unsubscribeChanges?.();
  unsubscribeChanges = null;
  entries.clear();
}
