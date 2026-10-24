// Folder loading and refresh for the Files pane: which directories are listed,
// expanded or stale, and every path that talks to listProjectDir — the first
// root listing, lazy expansion, the watcher/interval refresh and the toolbar's
// full refresh. The pane itself owns selection, inline editing and the entry
// mutations, and reaches this state only through the returned handles.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopApi } from '../shared/contract';
import { explorerErrorText } from './explorer-mutations';
import {
  loadExplorerRoot,
  peekExplorerRoot,
  peekExplorerRootFailure,
  refreshExplorerRoot,
  retainExplorerRoot,
} from './explorer-root-cache';
import { subscribeProjectFileChanges } from './project-file-changes';
import { startVisibleRefreshCadence } from './visible-refresh-cadence';
import {
  collapseExplorerDirs,
  explorerHasExpandedDirs,
  explorerRefreshTargets,
  explorerVisibleRows,
  patchExplorerDir,
  withChangedExplorerDirEntries,
  withExplorerDirEntries,
  type ExplorerDirListing,
  type ExplorerDirs,
  type ExplorerDirState,
  type ExplorerRow,
} from './explorer-tree-model';

// Watcher overflow and hosts without native change delivery still converge
// through this slow safety pass.
const SAFETY_REFRESH_MS = 30_000;

/** The tree as the cached root read shows it (collapsed below the root): the\n *  listing, or the error its newest read failed with. */
function seededExplorerDirs(projectPath: string): ExplorerDirs {
  const entries = projectPath ? peekExplorerRoot(projectPath) : undefined;
  if (entries) return new Map([['', { expanded: true, entries }]]);
  const failure = projectPath ? peekExplorerRootFailure(projectPath) : undefined;
  return failure
    ? new Map([['', { expanded: true, entries: [], error: explorerErrorText(failure.reason) }]])
    : new Map();
}

interface ExplorerDirTree {
  dirs: ExplorerDirs;
  /** Every visible row, error rows included (render order). */
  rows: ExplorerRow[];
  /** Rows the keyboard can land on: error rows are not navigable. */
  navRows: ExplorerRow[];
  refreshing: boolean;
  canCollapseAll: boolean;
  patch(rel: string, next: Partial<ExplorerDirState>): void;
  /** Expand a directory and (re)list it, surfacing a listing failure inline. */
  load(rel: string): void;
  /** Row click / Enter: fold, unfold from cache, or list for the first time. */
  toggle(rel: string): void;
  expandDir(rel: string): void;
  /** Silent re-list after a mutation: a directory that is gone stays as it is
   *  until the next interaction collapses it. */
  refreshDir(rel: string): void;
  refreshTree(): Promise<void>;
  collapseAll(): void;
}

export function useExplorerDirs(input: {
  api: DesktopApi | undefined;
  projectPath: string;
  active: boolean;
  readinessKey: string;
  onReadyChange(key: string, ready: boolean): void;
  /** Pane state that cannot outlive the tree it pointed at (selection, inline
   *  edit, clipboard, last mutation error) is cleared with the root listing. */
  onProjectReset(): void;
}): ExplorerDirTree {
  const { api, projectPath, active, readinessKey, onReadyChange } = input;
  const [dirs, setDirs] = useState<ExplorerDirs>(() => seededExplorerDirs(projectPath));
  const [refreshing, setRefreshing] = useState(false);
  // The watcher refresh reads the tree from here: React may run a state
  // updater more than once, so its listings must not be issued from one.
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  // The reset callback is rebuilt every render; keeping it in a ref leaves the
  // project effect keyed to the project/readiness signature alone, so a
  // re-render can never cancel an in-flight root listing.
  const resetPaneState = useRef(input.onProjectReset);
  resetPaneState.current = input.onProjectReset;
  const patch = useCallback((rel: string, next: Partial<ExplorerDirState>) => {
    setDirs((current) => patchExplorerDir(current, rel, next));
  }, []);
  // A mounted tree holds its project's cached root listing.
  useEffect(() => (projectPath ? retainExplorerRoot(projectPath) : undefined), [projectPath]);
  // The root listing rides the shared cache the next open paints from.
  const listDir = useCallback(
    (rel: string) => (rel ? api?.listProjectDir?.(projectPath, rel) : refreshExplorerRoot(api, projectPath)),
    [api, projectPath]
  );
  const load = useCallback(
    (rel: string) => {
      patch(rel, { expanded: true, error: undefined });
      void listDir(rel)
        ?.then((entries) => patch(rel, { entries: entries ?? [] }))
        .catch((reason) => patch(rel, { entries: [], error: explorerErrorText(reason) }));
    },
    [listDir, patch]
  );
  const refreshDir = useCallback(
    (rel: string) => {
      void listDir(rel)
        ?.then((entries) => patch(rel, { entries: entries ?? [] }))
        .catch(() => {
          /* gone — collapsed on next interaction */
        });
    },
    [listDir, patch]
  );
  // The Dock retains every visited tab, so this effect must never rebuild the
  // tree for a surface the user is not looking at: an inactive Files pane keeps
  // its expansion and issues no listProjectDir. The signature defers the reset
  // + root listing to the moment the pane becomes active again, which is also
  // the moment a stale project would otherwise be visible.
  const loadedTreeSignature = useRef('');
  useEffect(() => {
    const signature = `${readinessKey}\u0000${projectPath}`;
    if (!active || loadedTreeSignature.current === signature) return undefined;
    loadedTreeSignature.current = signature;
    let live = true;
    onReadyChange(readinessKey, false);
    // The cached root keeps the tree populated while this activation
    // revalidates it; nothing cached opens empty until the first listing.
    setDirs(seededExplorerDirs(projectPath));
    resetPaneState.current();
    if (!projectPath) {
      onReadyChange(readinessKey, true);
      return () => {
        live = false;
      };
    }
    void loadExplorerRoot(api, projectPath)
      .then((entries) => {
        // Folders opened on the cached rows stay open: a listing that matches
        // them changes nothing, a changed one replaces only the root level.
        if (live)
          setDirs((current) =>
            current.get('')?.entries && !current.get('')?.error
              ? withChangedExplorerDirEntries(current, '', entries)
              : new Map([['', { expanded: true, entries }]])
          );
      })
      .catch((reason) => {
        if (live)
          setDirs(
            new Map([
              [
                '',
                {
                  expanded: true,
                  entries: [],
                  error: explorerErrorText(reason),
                },
              ],
            ])
          );
      })
      .finally(() => {
        if (live) onReadyChange(readinessKey, true);
      });
    return () => {
      live = false;
    };
  }, [active, api, onReadyChange, projectPath, readinessKey]);
  // Agent/external edits arrive through the shared recursive project watcher.
  useEffect(() => {
    if (!active || !projectPath) return undefined;
    const refreshExpanded = () => {
      for (const [rel, state] of dirsRef.current) {
        if (!state.expanded || !state.entries) continue;
        void listDir(rel)
          ?.then((entries) => {
            if (!entries) return;
            setDirs((latest) => withChangedExplorerDirEntries(latest, rel, entries));
          })
          .catch(() => {
            /* dir removed — next expand reloads */
          });
      }
    };
    const unsubscribeProject = subscribeProjectFileChanges(projectPath, refreshExpanded);
    // A hidden window owns no safety timer; returning refreshes once.
    const stopSafety = startVisibleRefreshCadence({
      win: window,
      intervalMs: SAFETY_REFRESH_MS,
      refresh: refreshExpanded,
    });
    return () => {
      unsubscribeProject();
      stopSafety();
    };
  }, [active, listDir, projectPath]);
  const refreshTree = useCallback(async () => {
    if (!projectPath || refreshing) return;
    setRefreshing(true);
    const targets = explorerRefreshTargets(dirs);
    try {
      // One batch, applied together: a directory that failed to list keeps the
      // rows it already had instead of blinking empty mid-refresh.
      const refreshed = await Promise.all(
        targets.map(async (rel): Promise<ExplorerDirListing | null> => {
          try {
            return { rel, entries: await Promise.resolve(listDir(rel) ?? []) };
          } catch {
            return null;
          }
        })
      );
      const listings = refreshed.filter((listing): listing is ExplorerDirListing => listing !== null);
      setDirs((current) => withExplorerDirEntries(current, listings));
    } finally {
      setRefreshing(false);
    }
  }, [dirs, listDir, projectPath, refreshing]);
  const collapseAll = useCallback(() => {
    setDirs((current) => collapseExplorerDirs(current));
  }, []);
  const rows = useMemo(() => explorerVisibleRows(dirs), [dirs]);
  const navRows = useMemo(() => rows.filter((row) => !row.error), [rows]);
  const expandDir = (rel: string) => {
    if (!rel) return;
    const state = dirs.get(rel);
    if (state?.expanded) return;
    if (state?.entries) patch(rel, { expanded: true });
    else load(rel);
  };
  return {
    dirs,
    rows,
    navRows,
    refreshing,
    canCollapseAll: explorerHasExpandedDirs(dirs),
    patch,
    load,
    expandDir,
    toggle: (rel: string) => {
      const state = dirs.get(rel);
      if (state?.expanded) patch(rel, { expanded: false });
      else if (state?.entries) patch(rel, { expanded: true });
      else load(rel);
    },
    refreshDir,
    refreshTree,
    collapseAll,
  };
}
