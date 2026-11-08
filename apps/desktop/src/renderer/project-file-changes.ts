import { createProjectWatchRegistry, type ProjectWatchTarget } from '../shared/project-watch-registry';

type ProjectFileChangeListener = () => void;
type Bridge = NonNullable<typeof window.mixdogDesktop>;

let unsubscribeBridge: (() => void) | null = null;
// A window on a core connection watches through the core's `fs/watch` (the Node host's folder watcher does not exist
// there: `folderWatch` is an operation the core connection does not carry), one watch id per project.
const coreWatches = new Map<string, () => void>();
const legacyWatches = new Set<ProjectWatchTarget>();
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

// Each bridge listener lives exactly as long as the started watches that use it: it is dropped with the last of them, or when
// a start fails or finds itself released, so a watch released while it was still starting leaves no listener behind.
function leaveLegacy(target: ProjectWatchTarget): void {
  legacyWatches.delete(target);
  if (legacyWatches.size > 0) return;
  unsubscribeBridge?.();
  unsubscribeBridge = null;
}

function leaveCore(watchId: string): void {
  coreWatches.delete(watchId);
  if (coreWatches.size > 0) return;
  unsubscribeFsChanged?.();
  unsubscribeFsChanged = null;
}

async function startWatch(api: Bridge, target: ProjectWatchTarget): Promise<(() => unknown) | void> {
  const { sections } = api;
  if (sections && (await isCoreWindow(sections))) {
    if (target.released()) return;
    const watchId = `project-${nextWatchId++}`;
    coreWatches.set(watchId, target.changed);
    unsubscribeFsChanged ??= sections.subscribeFsChanged((change) => coreWatches.get(change.watchId)?.());
    const release = () => {
      leaveCore(watchId);
      return sections.call('fs/unwatch', { watchId });
    };
    try {
      await sections.call('fs/watch', { watchId, path: target.path, recursive: target.recursive });
    } catch (error) {
      leaveCore(watchId);
      throw error;
    }
    return release;
  }
  if (target.released() || typeof api.folderWatch !== 'function' || !ensureBridge()) return;
  legacyWatches.add(target);
  try {
    await api.folderWatch(target.path, target.recursive);
  } catch (error) {
    leaveLegacy(target);
    throw error;
  }
  return () => {
    leaveLegacy(target);
    return api.folderUnwatch?.(target.path, target.recursive);
  };
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