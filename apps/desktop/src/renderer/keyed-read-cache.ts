// A per-key cache of host reads that a list paints from in its first frame
// and revalidates behind: a warm-up (prefetch) and the mounted list share one
// read in flight, and an older answer never replaces a newer one.

type Entry<T> = {
  value: T | undefined;
  /** The read in flight, shared by everyone who asks meanwhile. */
  read: Promise<T> | null;
  /** A change was announced mid-read: the one read that follows it. */
  again: Promise<T> | null;
  /** Order of the newest read start or write: an answer older than the
   *  newest value applied is dropped. */
  applied: number;
};

export interface KeyedReadCache<T> {
  /** The newest value read or written for `key`. */
  peek(key: string): T | undefined;
  subscribe(key: string, listener: () => void): () => void;
  /** Reads `key` (a warm-up, a list activating): a read in flight is shared,
   *  so a prefetch followed by the list's mount reads once. */
  load(key: string, reader: () => Promise<T>): Promise<T>;
  /** Reads `key` after a change: a read in flight began before it, so one
   *  more follows that one; the returned promise is that newer read. */
  refresh(key: string, reader: () => Promise<T>): Promise<T>;
  /** A value the host answered a write with: newer than every read begun before. */
  write(key: string, value: T): void;
}

export function createKeyedReadCache<T>(): KeyedReadCache<T> {
  const entries = new Map<string, Entry<T>>();
  const listeners = new Map<string, Set<() => void>>();
  let order = 0;
  const entry = (key: string): Entry<T> => {
    let found = entries.get(key);
    if (!found) {
      found = { value: undefined, read: null, again: null, applied: 0 };
      entries.set(key, found);
    }
    return found;
  };
  const apply = (key: string, value: T, at: number) => {
    const current = entry(key);
    if (at < current.applied) return;
    current.applied = at;
    current.value = value;
    for (const listener of [...(listeners.get(key) ?? [])]) listener();
  };
  const start = (key: string, reader: () => Promise<T>): Promise<T> => {
    const current = entry(key);
    const at = ++order;
    const read = reader()
      .then((value) => {
        apply(key, value, at);
        return value;
      })
      .finally(() => {
        if (current.read === read) current.read = null;
      });
    current.read = read;
    // Every caller handles its own rejection; the shared promise must not
    // also surface as unhandled.
    read.catch(() => undefined);
    return read;
  };
  const load = (key: string, reader: () => Promise<T>) => entry(key).read ?? start(key, reader);
  const refresh = (key: string, reader: () => Promise<T>): Promise<T> => {
    const current = entry(key);
    if (!current.read) return start(key, reader);
    if (!current.again) {
      const follow = () => {
        current.again = null;
        return start(key, reader);
      };
      const again = current.read.then(follow, follow);
      again.catch(() => undefined);
      current.again = again;
    }
    return current.again;
  };
  return {
    peek: (key) => entries.get(key)?.value,
    subscribe(key, listener) {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    load,
    refresh,
    write: (key, value) => apply(key, value, ++order),
  };
}
