// The renderer's read side of pushed state (desktop-services.md §2.3, §15). One store per window, fed by a
// `SectionsSource`: Electron's preload bridge (main owns the socket), or, on the phone, the client library's own
// fold store over the relay. `value` of a section is replaced whole when its `revision` is higher, so a snapshot
// read racing a push can never move a section backwards. Nothing in the renderer polls for what a section carries.
import { useCallback, useSyncExternalStore } from 'react';
import { EVENT_SECTIONS } from '../shared/contract-sections';
import type {
  DesktopProtocolStatus,
  DesktopSectionChange,
  DesktopSectionEntry,
  DesktopSectionsPush,
  DesktopSectionsSnapshot,
} from '../shared/contract-sections';

export interface SectionsSource {
  snapshot(): Promise<DesktopSectionsSnapshot>;
  subscribe(listener: (push: DesktopSectionsPush) => void): () => void;
}

/** The part of the client library's `FoldStore` a source reads. */
export interface FoldStoreLike {
  sections(section: string): readonly DesktopSectionEntry[];
  section(section: string, key?: string | null): DesktopSectionEntry | undefined;
  subscribe(listener: (change: { type: string; section?: string; key?: string | null }) => void): () => void;
  /** Set while the changes a snapshot swapped in are still being announced (the client library's `FoldStore.owed`). */
  readonly owed?: unknown;
}

/** Adapts a client-library store (the phone's `connectPhone().store`) to a source. `names` is the section registry. */
export function sectionsSourceFromFoldStore(
  store: FoldStoreLike,
  names: readonly string[],
  status: () => DesktopProtocolStatus
): SectionsSource {
  return {
    snapshot: async () => ({ status: status(), entries: names.flatMap((name) => store.sections(name)) }),
    subscribe: (listener) =>
      store.subscribe((change) => {
        if (change.type !== 'section' || change.section === undefined) return;
        // A tell is not state: the announcement of a snapshot (a late attach, a leg that came back) is not one. A phone whose leg
        // was down is not told what was pushed meanwhile (the relay does not replay it); its page reads again on its own reconnect.
        if (store.owed && EVENT_SECTIONS.includes(change.section)) return;
        const key = change.key ?? null;
        listener({
          kind: 'sections',
          changes: [{ section: change.section, key, entry: store.section(change.section, key) ?? null }],
        });
      }),
  };
}

const keyOf = (key: string | null): string => key ?? '';
const EMPTY: readonly DesktopSectionEntry[] = Object.freeze([]);

export interface SectionStore {
  get(section: string, key?: string | null): DesktopSectionEntry | undefined;
  /** Stable between changes of the section (usable as a `useSyncExternalStore` snapshot). */
  list(section: string): readonly DesktopSectionEntry[];
  status(): DesktopProtocolStatus;
  /** Called after each change of `section` (every section for `'*'`, plus status changes). */
  subscribe(section: string, listener: () => void): () => void;
  /** A scoped feed main could not restore after a reconnect for a reason other than the core not holding it. */
  onFeedError(listener: (feedId: string, message: string) => void): () => void;
  /** Resolves once the first snapshot is folded. */
  ready(): Promise<void>;
  dispose(): void;
}

export function createSectionStore(source: SectionsSource): SectionStore {
  const sections = new Map<string, Map<string, DesktopSectionEntry>>();
  const lists = new Map<string, readonly DesktopSectionEntry[]>();
  const listeners = new Map<string, Set<() => void>>();
  const feedErrorListeners = new Set<(feedId: string, message: string) => void>();
  let status: DesktopProtocolStatus = 'reconnecting';
  let disposed = false;
  // What pushes said before the first snapshot was folded. The snapshot was read at one instant and every change
  // before it is also a push that arrived ahead of its answer, so a pushed pair (a deletion included) or a pushed
  // whole store is already newer than the snapshot's copy, and a pushed status is not moved back to its status.
  let loaded = false;
  let pushedWholeStore = false;
  let pushedStatus = false;
  const pushedPairs = new Set<string>();
  // The revision of the tell this store last took in or was told of, per section and key, and the core it came from (the app
  // feed's epoch: a restarted core numbers its revisions from the start again). A tell is not state, so a whole store never makes a
  // listener act on a tell it was not there for: a window that attaches later reads the store as it is. But a store that was
  // connected before (it knows a core's epoch) and is handed a whole store again missed what the core told meanwhile: a tell it
  // does not hold, a different revision of one it holds, or any tell of another core, is announced once. A store the core's
  // reviewDiff never leaves an entry out of (a clear is published as a tell too), so an entry the whole store lacks is no tell.
  const tellRevisions = new Map<string, number>();
  let epoch: string | undefined;
  const tellAt = (section: string, key: string | null): string => `${section}\u0000${keyOf(key)}`;  // The chunks of a replace between its begin and its commit.
  let staged: DesktopSectionEntry[] | null = null;

  const notify = (touched: ReadonlySet<string>): void => {
    for (const name of [...touched, '*']) for (const listener of [...(listeners.get(name) ?? [])]) listener();
  };
  const apply = (change: DesktopSectionChange, touched: Set<string>): void => {
    const bucket = sections.get(change.section) ?? new Map<string, DesktopSectionEntry>();
    sections.set(change.section, bucket);
    const k = keyOf(change.key);
    const current = bucket.get(k);
    if (change.entry === null) {
      if (!bucket.delete(k)) return;
    } else {
      if (current && current.revision >= change.entry.revision) return;
      bucket.set(k, change.entry);
      if (EVENT_SECTIONS.includes(change.section)) tellRevisions.set(tellAt(change.section, change.key), change.entry.revision);
    }
    lists.delete(change.section);
    touched.add(change.section);
  };
  const fold = (push: DesktopSectionsPush): void => {
    if (disposed) return;
    if (push.kind === 'status') {
      status = push.status;
      if (!loaded) pushedStatus = true;
      notify(new Set());
      return;
    }
    if (push.kind === 'feedError') {
      for (const listener of [...feedErrorListeners]) listener(push.feedId, push.message);
      return;
    }
    if (push.kind === 'replace') {
      if (push.stage === 'begin') staged = [];
      else if (push.stage === 'chunk') staged?.push(...push.entries);
      else {
        // The staged store replaces the held one at once: one swap, one notification per changed section.
        // A tell is not state: a replace neither carries one in nor tells the listeners of the one it drops.
        const touched = new Set<string>([...sections.keys()].filter((name) => !EVENT_SECTIONS.includes(name)));
        if (!loaded) pushedWholeStore = true;
        const connectedBefore = epoch !== undefined;
        const sameCore = connectedBefore && push.epoch === epoch;
        const held = new Map(tellRevisions);
        tellRevisions.clear();
        sections.clear();
        lists.clear();
        for (const entry of staged ?? []) {
          if (!EVENT_SECTIONS.includes(entry.section)) {
            apply({ section: entry.section, key: entry.key, entry }, touched);
            continue;
          }
          const at = tellAt(entry.section, entry.key);
          tellRevisions.set(at, entry.revision);
          if (connectedBefore && (!sameCore || held.get(at) !== entry.revision)) touched.add(entry.section);
        }
        epoch = push.epoch;
        staged = null;
        notify(touched);
      }
      return;
    }
    const touched = new Set<string>();
    for (const change of push.changes) {
      if (!loaded) pushedPairs.add(`${change.section}\u0000${keyOf(change.key)}`);
      apply(change, touched);
    }
    if (touched.size > 0) notify(touched);
  };

  const unsubscribe = source.subscribe(fold);
  // The listener is attached before the snapshot is read: a push that lands in between is not lost.
  const ready = source.snapshot().then((snapshot) => {
    if (disposed) return;
    if (!pushedStatus) status = snapshot.status;
    const touched = new Set<string>();
    if (!pushedWholeStore) {
      for (const entry of snapshot.entries) {
        if (EVENT_SECTIONS.includes(entry.section)) {
          tellRevisions.set(tellAt(entry.section, entry.key), entry.revision);
          continue;
        }
        if (pushedPairs.has(`${entry.section}\u0000${keyOf(entry.key)}`)) continue;
        apply({ section: entry.section, key: entry.key, entry }, touched);
      }
    }
    if (!pushedWholeStore) epoch = snapshot.epoch;
    loaded = true;
    pushedPairs.clear();
    notify(touched);
  });

  return {
    get: (section, key = null) => sections.get(section)?.get(keyOf(key)),
    list(section) {
      const cached = lists.get(section);
      if (cached) return cached;
      const bucket = sections.get(section);
      const list = bucket && bucket.size > 0 ? Object.freeze([...bucket.values()]) : EMPTY;
      lists.set(section, list);
      return list;
    },
    status: () => status,
    subscribe(section, listener) {
      const set = listeners.get(section) ?? new Set();
      listeners.set(section, set);
      set.add(listener);
      return () => void set.delete(listener);
    },
    onFeedError(listener) {
      feedErrorListeners.add(listener);
      return () => void feedErrorListeners.delete(listener);
    },
    ready: () => ready,
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}

// ── The window's store ──

let installed: SectionStore | undefined;
const HOST_STORES = new WeakMap<object, SectionStore>();

/** Installs the window's store over `source` (the phone installs the library's; Electron's is created on first use). */
export function installSectionStore(source: SectionsSource): SectionStore {
  installed?.dispose();
  installed = createSectionStore(source);
  return installed;
}

/** The store installSectionStore installed (the phone's), if any. */
export function installedSectionStore(): SectionStore | undefined {
  return installed;
}

/** The store of a desktop bridge (`window.mixdogDesktop`), one per bridge object. */
export function sectionStoreFor(host: { readonly sections?: SectionsSource } | undefined): SectionStore | undefined {
  if (installed) return installed;
  if (!host?.sections) return undefined;
  const cached = HOST_STORES.get(host);
  if (cached) return cached;
  const created = createSectionStore(host.sections);
  HOST_STORES.set(host, created);
  return created;
}

export function windowSectionStore(): SectionStore | undefined {
  return sectionStoreFor(typeof window === 'undefined' ? undefined : window.mixdogDesktop);
}

const NO_STORE: SectionStore = {
  get: () => undefined,
  list: () => EMPTY,
  status: () => 'reconnecting',
  subscribe: () => () => undefined,
  onFeedError: () => () => undefined,
  ready: () => Promise.resolve(),
  dispose: () => undefined,
};

/** The value of one `(section, key)`, re-rendering on every change of the section. `undefined` until it is pushed. */
export function useSection<T>(section: string, key: string | null = null): T | undefined {
  const store = windowSectionStore() ?? NO_STORE;
  const subscribe = useCallback((listener: () => void) => store.subscribe(section, listener), [store, section]);
  return useSyncExternalStore(subscribe, () => store.get(section, key)?.value as T | undefined);
}

/** Every entry of a keyed section. */
export function useSectionEntries(section: string): readonly DesktopSectionEntry[] {
  const store = windowSectionStore() ?? NO_STORE;
  const subscribe = useCallback((listener: () => void) => store.subscribe(section, listener), [store, section]);
  return useSyncExternalStore(subscribe, () => store.list(section));
}

export function useSectionsStatus(): DesktopProtocolStatus {
  const store = windowSectionStore() ?? NO_STORE;
  const subscribe = useCallback((listener: () => void) => store.subscribe('*', listener), [store]);
  return useSyncExternalStore(subscribe, () => store.status());
}
