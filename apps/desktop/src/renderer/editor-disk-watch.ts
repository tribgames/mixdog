import type { DesktopApi } from '../shared/contract';

let nextWatch = 1;

/** The file's directory entry changed on disk: the core's one watcher pushes `fs/changed` for this watch
 *  (desktop-services.md §4.3, §15 P12), so there is no stat poll. `check` decides what the change means. */
export function startEditorDiskWatch(
  host: Pick<DesktopApi, 'sections'> | undefined,
  projectPath: string,
  relPath: string,
  check: () => void
): () => void {
  const sections = host?.sections;
  if (!sections) return () => undefined;
  const watchId = `editor-${nextWatch++}`;
  const path = `${projectPath.replace(/[\\/]+$/, '')}/${relPath.replace(/^[\\/]+/, '')}`;
  const unsubscribe = sections.subscribeFsChanged((change) => {
    if (change.watchId === watchId) check();
  });
  let live = true;
  void sections.call('fs/watch', { watchId, path, recursive: false }).catch(() => undefined);
  return () => {
    if (!live) return;
    live = false;
    unsubscribe();
    void sections.call('fs/unwatch', { watchId }).catch(() => undefined);
  };
}
