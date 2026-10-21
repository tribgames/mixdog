import { useSyncExternalStore } from 'react';

/** Bots the user hid from the Sessions sidebar's 봇 list (device-local). The bot
 *  keeps running and stays on the 봇 page; only the sidebar row is hidden. */
const STORAGE_KEY = 'mixdog.sidebarHiddenBots';
const EMPTY: ReadonlySet<string> = new Set();

let cache: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

const host = (): Window & typeof globalThis => (globalThis.window ?? globalThis) as Window & typeof globalThis;

function readStored(): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(host().localStorage?.getItem(STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return EMPTY;
  }
}

export function sidebarHiddenBots(): ReadonlySet<string> {
  cache ??= readStored();
  return cache;
}

/** The last write failed: the cached set holds changes storage does not. */
let unsaved = false;

/** The base of the next change: storage, unless it refused the last write —
 *  then the cached set, which alone holds the user's latest choices. */
function currentStored(): Set<string> {
  return new Set(unsaved ? sidebarHiddenBots() : readStored());
}

export function setBotHiddenInSidebar(agentId: string, hidden: boolean): void {
  // Start from what is stored now, so another window's write is kept.
  const next = currentStored();
  if (hidden) next.add(agentId);
  else next.delete(agentId);
  cache = next;
  try {
    const storage = host().localStorage;
    if (!storage) throw new Error('no storage');
    storage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    unsaved = false;
  } catch {
    // Storage is best-effort; the cached set still applies and is the base of the next change.
    unsaved = true;
  }
  for (const listener of listeners) listener();
}

/** Take another same-origin window's version of the list. */
function refreshFromStorage(): boolean {
  const next = currentStored();
  const current = sidebarHiddenBots();
  if (next.size === current.size && [...next].every((id) => current.has(id))) return false;
  cache = next;
  return true;
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  refreshFromStorage();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    host().addEventListener?.('storage', onStorage);
    // Changes made while nobody listened were missed.
    refreshFromStorage();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) host().removeEventListener?.('storage', onStorage);
  };
}

export function useSidebarHiddenBots(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, sidebarHiddenBots, () => EMPTY);
}

/** Test seam: forget the in-memory cache so storage is re-read. */
export function resetSidebarHiddenBotsCache(): void {
  cache = null;
  unsaved = false;
}
