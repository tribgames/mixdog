// Mirrors the connection's section store to the windows of its connection. The renderer only ever replaces what it
// is told to; it never reads the wire. A burst of store changes (an app snapshot folds all its sections in one
// synchronous run) leaves one flush: the changed `(section, key)` pairs with their current entries. A reconnect sends
// the whole store as chunked `replace` pushes. Coalescing is a dirty set drained once per burst, not a timer.
import type {
  DesktopProtocolStatus,
  DesktopSectionChange,
  DesktopSectionEntry,
  DesktopSectionsPush,
  DesktopSectionsSnapshot,
} from '../../shared/contract-sections';

/** The part of the client library's `FoldStore` the relay reads. */
export interface RelayedStore {
  section(section: string, key?: string | null): DesktopSectionEntry | undefined;
  sections(section: string): readonly DesktopSectionEntry[];
  subscribe(listener: (change: { type: string; section?: string; key?: string | null }) => void): () => void;
}

export interface SectionRelayOptions {
  store: RelayedStore;
  /** Every section name that can exist; the closed registry (`SectionName`). */
  sectionNames: readonly string[];
  send(push: DesktopSectionsPush): void;
  /** Runs `flush` after the current synchronous run; `setImmediate` outside tests. A later loop turn, not a microtask:
   *  a flush must not share a turn with the library folding the frame that caused it. */
  defer?(flush: () => void): void;
}

export interface SectionRelay {
  snapshot(status: DesktopProtocolStatus): DesktopSectionsSnapshot;
  /** The restored app snapshot has been folded: the windows are sent the complete store, in chunks. */
  reconnected(): void;
  status(status: DesktopProtocolStatus): void;
  dispose(): void;
}

const pairKey = (section: string, key: string | null): string => `${section}\u0000${key ?? ''}`;

/** Entries per `replace` chunk: about 100 KB of sections, a few milliseconds of one turn to clone and send. */
export const REPLACE_CHUNK_ENTRIES = 100;

export function createSectionRelay({ store, sectionNames, send, defer = setImmediate }: SectionRelayOptions): SectionRelay {
  const dirty = new Map<string, { section: string; key: string | null }>();
  let replaceWanted = false;
  // The replace in flight; a newer one supersedes it, and its remaining chunks are dropped.
  let replacing = 0;
  let replaceCount = 0;
  let scheduled = false;
  let disposed = false;

  const all = (): DesktopSectionEntry[] => sectionNames.flatMap((name) => store.sections(name));

  /** The complete store as of now, one chunk per turn. Changes made meanwhile wait in `dirty` and follow the commit:
   *  the chunks are a point-in-time view, so the window never holds a store that never existed. */
  const replace = (): void => {
    const id = ++replaceCount;
    replacing = id;
    dirty.clear();
    const view = all();
    send({ kind: 'replace', stage: 'begin' });
    let at = 0;
    const step = (): void => {
      if (disposed || replacing !== id) return;
      if (at < view.length) {
        send({ kind: 'replace', stage: 'chunk', entries: view.slice(at, at + REPLACE_CHUNK_ENTRIES) });
        at += REPLACE_CHUNK_ENTRIES;
        defer(step);
        return;
      }
      send({ kind: 'replace', stage: 'commit' });
      replacing = 0;
      if (dirty.size > 0) schedule();
    };
    defer(step);
  };

  const flush = (): void => {
    scheduled = false;
    if (disposed) return;
    if (replaceWanted) {
      replaceWanted = false;
      replace();
      return;
    }
    if (replacing) return;
    const changes: DesktopSectionChange[] = [...dirty.values()].map(({ section, key }) => ({
      section,
      key,
      entry: store.section(section, key) ?? null,
    }));
    dirty.clear();
    if (changes.length > 0) send({ kind: 'sections', changes });
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    defer(flush);
  };

  const unsubscribe = store.subscribe((change) => {
    if (change.type !== 'section' || change.section === undefined) return;
    dirty.set(pairKey(change.section, change.key ?? null), { section: change.section, key: change.key ?? null });
    schedule();
  });

  return {
    snapshot: (status) => ({ status, entries: all() }),
    reconnected() {
      replaceWanted = true;
      schedule();
    },
    status: (status) => send({ kind: 'status', status }),
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}