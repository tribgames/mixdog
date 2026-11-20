import type { RendererCacheName } from '../shared/renderer-cache';

/** One of the window's large caches as the main process keeps it (shared/renderer-cache.ts), read and written like a
 *  storage of that one value: the key asked for is the cache's old Local Storage key. A value an earlier version left
 *  there moves to the main process the first time it is read. `null` where there is no main process (the phone and
 *  browser surfaces): the caller keeps its own storage there. */
export function profileCacheStorage(name: RendererCacheName): Pick<Storage, 'getItem' | 'setItem'> | null {
  const api = typeof window === 'undefined' ? undefined : window.mixdogDesktop;
  const read = api?.readRendererCache;
  const write = api?.writeRendererCache;
  if (!read || !write) return null;
  return {
    getItem(key) {
      const text = read(name);
      if (text !== null) return text;
      const earlier = takeFromLocalStorage(key);
      if (earlier !== null) write(name, earlier);
      return earlier;
    },
    setItem: (_key, value) => write(name, value),
  };
}

function takeFromLocalStorage(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    if (value !== null) window.localStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}
