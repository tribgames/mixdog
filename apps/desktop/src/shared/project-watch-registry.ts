// The reference-counted project watches of a core connection (`fs/watch`): one watch per (path, recursive) however many
// subscribers ask, started with the first and released with the last. The window's project file changes
// (renderer/project-file-changes.ts) and the host's `folderWatch` operation for the paired phones (the operation lane) are
// the same registry over two carriers, so a project is never watched twice for the same reason.

export interface ProjectWatchTarget {
  readonly path: string;
  readonly recursive: boolean;
  /** Tells every subscriber of this watch that something under it changed. */
  changed(): void;
  /** True once the last subscriber has left: a start that is still under way must not leave anything behind. */
  released(): boolean;
}

export interface ProjectWatchRegistryOptions {
  /** The map key of a path (case-folded where the file system is). */
  keyOf(path: string): string;
  /** Starts the watch; settles once it is started. Resolves to its release; a failed start has nothing to release. */
  start(target: ProjectWatchTarget): Promise<(() => unknown) | void>;
  /** The last watch ended. */
  idle?(): void;
}

interface Entry {
  readonly path: string;
  readonly recursive: boolean;
  readonly listeners: Set<() => void>;
  started: Promise<(() => unknown) | void>;
  released: boolean;
}

export interface ProjectWatchRegistry {
  /** Returns the removal of this subscription. */
  subscribe(path: string, listener: () => void, recursive?: boolean): () => void;
  /** A change reported by path (a carrier that names the watched path, not a watch id). */
  changed(path: string, recursive?: boolean): void;
}

export function createProjectWatchRegistry({ keyOf, start, idle }: ProjectWatchRegistryOptions): ProjectWatchRegistry {
  const entries = new Map<string, Entry>();
  const entryKey = (path: string, recursive: boolean): string => `${keyOf(path)}\0${recursive ? 'recursive' : 'direct'}`;
  return {
    subscribe(path, listener, recursive = true) {
      const key = entryKey(path, recursive);
      let entry = entries.get(key);
      if (!entry) {
        const created: Entry = { path, recursive, listeners: new Set(), started: Promise.resolve(), released: false };
        entries.set(key, created);
        created.started = start({
          path,
          recursive,
          changed: () => {
            for (const each of [...created.listeners]) each();
          },
          released: () => created.released,
        }).catch(() => undefined);
        entry = created;
      }
      entry.listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = entries.get(key);
        if (!current) return;
        current.listeners.delete(listener);
        if (current.listeners.size > 0) return;
        entries.delete(key);
        current.released = true;
        void current.started.then((release) => release?.()).catch(() => undefined);
        if (entries.size === 0) idle?.();
      };
    },
    changed(path, recursive = true) {
      const entry = entries.get(entryKey(path, recursive));
      if (entry) for (const listener of [...entry.listeners]) listener();
    },
  };
}