type ProjectFileChangeListener = () => void;

interface ProjectWatchEntry {
  path: string;
  listeners: Set<ProjectFileChangeListener>;
  /** Settles once the watch is started (or has failed: a failed watch has nothing to release). */
  watching: Promise<unknown>;
  /** Ends the started watch. */
  release?: () => unknown;
}

const projectWatches = new Map<string, ProjectWatchEntry>();
let unsubscribeBridge: (() => void) | null = null;
// A window on a core connection watches through the core's `fs/watch` (the Node host's folder watcher does not exist
// there: `folderWatch` is an operation the core connection does not carry), one watch id per project.
const coreWatches = new Map<string, ProjectWatchEntry>();
let unsubscribeFsChanged: (() => void) | null = null;
let nextWatchId = 1;
const coreOfSections = new WeakMap<object, Promise<boolean>>();

function isCoreWindow(sections: NonNullable<typeof window.mixdogDesktop>['sections']): Promise<boolean> {
  if (!sections) return Promise.resolve(false);
  let asked = coreOfSections.get(sections);
  if (!asked) {
    asked = sections.core().catch(() => false);
    coreOfSections.set(sections, asked);
  }
  return asked;
}

function watchKey(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return navigator.platform.toLowerCase().includes('win') ? normalized.toLocaleLowerCase() : normalized;
}

function ensureBridge(): boolean {
  const subscribe = window.mixdogDesktop?.subscribeFolderChanges;
  if (typeof subscribe !== 'function') return false;
  if (!unsubscribeBridge) {
    unsubscribeBridge = subscribe((changedPath) => {
      const entry = projectWatches.get(watchKey(changedPath));
      if (!entry) return;
      for (const listener of [...entry.listeners]) listener();
    });
  }
  return true;
}

function ensureFsBridge(sections: NonNullable<NonNullable<typeof window.mixdogDesktop>['sections']>): void {
  unsubscribeFsChanged ??= sections.subscribeFsChanged((change) => {
    const entry = coreWatches.get(change.watchId);
    if (entry) for (const listener of [...entry.listeners]) listener();
  });
}

function startWatch(api: NonNullable<typeof window.mixdogDesktop>, entry: ProjectWatchEntry): Promise<unknown> {
  return (async () => {
    const { sections } = api;
    if (sections && (await isCoreWindow(sections))) {
      const watchId = `project-${nextWatchId++}`;
      coreWatches.set(watchId, entry);
      ensureFsBridge(sections);
      entry.release = () => {
        coreWatches.delete(watchId);
        return sections.call('fs/unwatch', { watchId });
      };
      await sections.call('fs/watch', { watchId, path: entry.path, recursive: true });
      return;
    }
    if (typeof api.folderWatch !== 'function' || !ensureBridge()) return;
    entry.release = () => api.folderUnwatch?.(entry.path, true);
    await api.folderWatch(entry.path, true);
  })().catch(() => undefined);
}

export function subscribeProjectFileChanges(projectPath: string, listener: ProjectFileChangeListener): () => void {
  const api = window.mixdogDesktop;
  if (!api || !projectPath || (!api.sections && (typeof api.folderWatch !== 'function' || !ensureBridge()))) {
    return () => {};
  }
  const key = watchKey(projectPath);
  let entry = projectWatches.get(key);
  if (!entry) {
    entry = { path: projectPath, listeners: new Set(), watching: Promise.resolve() };
    projectWatches.set(key, entry);
    entry.watching = startWatch(api, entry);
  }
  entry.listeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = projectWatches.get(key);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;
    projectWatches.delete(key);
    void current.watching.then(() => current.release?.()).catch(() => undefined);
    if (projectWatches.size === 0) {
      unsubscribeBridge?.();
      unsubscribeBridge = null;
      unsubscribeFsChanged?.();
      unsubscribeFsChanged = null;
    }
  };
}
