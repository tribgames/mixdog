// Values computed from a directory tree (a stat walk's signature), reused
// while a recursive fs.watch on that tree has reported nothing since. Any
// event or watcher error drops the value and closes the watch (the next
// compute opens a new one), so a churning tree never keeps a handle on
// directories being deleted. A path that is not a directory (missing, a plain
// file) or cannot be watched is computed on every call. Nothing is polled.
import { statSync, watch as watchTree } from 'node:fs';
import { sep } from 'node:path';

const liveMemos = new Set(); // each memo's held map
const dropWaiters = new Set(); // { path, resolve }

const covers = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Resolves once a held root containing `path` (or `path` itself) drops its
 * value — the event an edit under it causes. Resolves at once when no memo
 * holds such a root, so a caller never waits on a drop that cannot come.
 * While someone waits, the watches it waits on keep the process alive.
 */
export function treeWatchDropped(path) {
  const watching = [];
  for (const held of liveMemos) {
    for (const [root, entry] of held) if (covers(root, path)) watching.push(entry.watcher);
  }
  if (!watching.length) return Promise.resolve();
  for (const watcher of watching) watcher.ref?.();
  return new Promise((resolve) => dropWaiters.add({ path, resolve }));
}

/** `onDrop(root)`: a root's value was dropped (event, error, `dropAll`). */
export function createTreeWatchMemo({ limit = 64, onDrop = null } = {}) {
  const held = new Map(); // root -> { watcher, ready, value }
  liveMemos.add(held);

  const drop = (root) => {
    const entry = held.get(root);
    if (!entry) return;
    held.delete(root);
    try {
      entry.watcher.close();
    } catch {
      /* already closed */
    }
    onDrop?.(root);
    for (const waiter of [...dropWaiters]) {
      if (!covers(root, waiter.path)) continue;
      dropWaiters.delete(waiter);
      waiter.resolve();
    }
  };

  const dropAll = () => {
    for (const root of [...held.keys()]) drop(root);
  };

  const open = (root) => {
    try {
      if (!statSync(root).isDirectory()) return null;
    } catch {
      return null;
    }
    if (held.size >= limit) dropAll();
    const entry = { watcher: null, ready: false, value: undefined };
    const dropOwn = () => {
      if (held.get(root) === entry) drop(root);
    };
    try {
      entry.watcher = watchTree(root, { recursive: true, persistent: false }, dropOwn);
      entry.watcher.on('error', dropOwn);
    } catch {
      return null;
    }
    held.set(root, entry);
    return entry;
  };

  return {
    /** `compute(root)`, reused while root's watch stays quiet. A value
     *  `keep(value)` refuses is answered but computed again next time. */
    get(root, compute, keep = () => true) {
      const current = held.get(root);
      if (current?.ready) return current.value;
      // Watch BEFORE computing: fs.watch is armed when it returns, so a change
      // racing the compute either shows in it or arrives as an event.
      const entry = current || open(root);
      const value = compute(root);
      if (entry && held.get(root) === entry && keep(value)) {
        entry.value = value;
        entry.ready = true;
      }
      return value;
    },
    dropAll,
  };
}
