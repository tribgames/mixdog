import { createProjectWatchRegistry, type ProjectWatchTarget } from '../shared/project-watch-registry';

type ProjectFileChangeListener = () => void;
type Bridge = NonNullable<typeof window.mixdogDesktop>;

let unsubscribeBridge: (() => void) | null = null;
// A window on a core connection watches through the core's `fs/watch` (the Node host's folder watcher does not exist
// there: `folderWatch` is an operation the core connection does not carry), one watch id per project.
const coreWatches = new Map<string, () => void>();
let unsubscribeFsChanged: (() => void) | null = null;
let nextWatchId = 1;
const coreOfSections = new WeakMap<object, Promise<boolean>>();

function watchKey(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return navigator.platform.toLowerCase().includes('win') ? normalized.toLocaleLowerCase() : normalized;
}

function isCoreWindow(sections: NonNullable<Bridge['sections']>): Promise<boolean> {
  let asked = coreOfSections.get(sections);
  if (!asked) {
    asked = sections.core().catch(() => false);
    coreOfSections.set(sections, asked);
  }
  return asked;
}

function ensureBridge(): boolean {
  const subscribe = window.mixdogDesktop?.subscribeFolderChanges;
  if (typeof subscribe !== 'function') return false;
  if (!unsubscribeBridge) {
    unsubscribeBridge = subscribe((changedPath) => registry.changed(changedPath));
  }
  return true;
}

function ensureFsBridge(sections: NonNullable<Bridge['sections']>): void {
  unsubscribeFsChanged ??= sections.subscribeFsChanged((change) => coreWatches.get(change.watchId)?.());
}

async function startWatch(api: Bridge, target: ProjectWatchTarget): Promise<(() => unknown) | void> {
  const { sections } = api;
  if (sections && (await isCoreWindow(sections))) {
    const watchId = `project-${nextWatchId++}`;
    coreWatches.set(watchId, target.changed);
    ensureFsBridge(sections);
    const release = () => {
      coreWatches.delete(watchId);
      return sections.call('fs/unwatch', { watchId });
    };
    await sections.call('fs/watch', { watchId, path: target.path, recursive: target.recursive });
    return release;
  }
  if (typeof api.folderWatch !== 'function' || !ensureBridge()) return;
  await api.folderWatch(target.path, target.recursive);
  return () => api.folderUnwatch?.(target.path, target.recursive);
}

const registry = createProjectWatchRegistry({
  keyOf: watchKey,
  start: (target) => startWatch(window.mixdogDesktop!, target),
  idle() {
    unsubscribeBridge?.();
    unsubscribeBridge = null;
    unsubscribeFsChanged?.();
    unsubscribeFsChanged = null;
  },
});

export function subscribeProjectFileChanges(projectPath: string, listener: ProjectFileChangeListener): () => void {
  const api = window.mixdogDesktop;
  if (!api || !projectPath || (!api.sections && (typeof api.folderWatch !== 'function' || !ensureBridge()))) {
    return () => {};
  }
  return registry.subscribe(projectPath, listener);
}