type ProjectFileChangeListener = () => void;

interface ProjectWatchEntry {
  path: string;
  listeners: Set<ProjectFileChangeListener>;
  watching: Promise<unknown>;
}

const projectWatches = new Map<string, ProjectWatchEntry>();
let unsubscribeBridge: (() => void) | null = null;

function watchKey(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return navigator.platform.toLowerCase().includes("win")
    ? normalized.toLocaleLowerCase()
    : normalized;
}

function ensureBridge(): boolean {
  const subscribe = window.mixdogDesktop?.subscribeFolderChanges;
  if (typeof subscribe !== "function") return false;
  if (!unsubscribeBridge) {
    unsubscribeBridge = subscribe((changedPath) => {
      const entry = projectWatches.get(watchKey(changedPath));
      if (!entry) return;
      for (const listener of [...entry.listeners]) listener();
    });
  }
  return true;
}

export function subscribeProjectFileChanges(
  projectPath: string,
  listener: ProjectFileChangeListener,
): () => void {
  const api = window.mixdogDesktop;
  if (!projectPath || typeof api?.folderWatch !== "function" || !ensureBridge()) {
    return () => {};
  }
  const key = watchKey(projectPath);
  let entry = projectWatches.get(key);
  if (!entry) {
    entry = {
      path: projectPath,
      listeners: new Set(),
      watching: Promise.resolve(api.folderWatch(projectPath, true)).catch(() => undefined),
    };
    projectWatches.set(key, entry);
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
    void current.watching.then(() => api.folderUnwatch?.(current.path, true)).catch(() => undefined);
    if (projectWatches.size === 0) {
      unsubscribeBridge?.();
      unsubscribeBridge = null;
    }
  };
}
