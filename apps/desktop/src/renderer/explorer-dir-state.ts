// Folder loading and refresh for the Files pane: which directories are listed,
// expanded or stale, and every path that talks to listProjectDir — the first
// root listing, lazy expansion, the watcher/interval refresh and the toolbar's
// full refresh. The pane itself owns selection, inline editing and the entry
// mutations, and reaches this state only through the returned handles.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopApi } from '../shared/contract';
import { explorerErrorText } from './explorer-mutations';
import { subscribeProjectFileChanges } from './project-file-changes';
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
  const [dirs, setDirs] = useState<ExplorerDirs>(() => new Map());
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
  const load = useCallback(
    (rel: string) => {
      patch(rel, { expanded: true, error: undefined });
      void api
        ?.listProjectDir?.(projectPath, rel)
        .then((entries) => patch(rel, { entries: entries ?? [] }))
        .catch((reason) => patch(rel, { entries: [], error: explorerErrorText(reason) }));
    },
    [api, projectPath, patch]
  );
  const refreshDir = useCallback(
    (rel: string) => {
      void api
        ?.listProjectDir?.(projectPath, rel)
        .then((entries) => patch(rel, { entries: entries ?? [] }))
        .catch(() => {
          /* gone — collapsed on next interaction */
        });
    },
    [api, patch, projectPath]
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
    setDirs(new Map());
    resetPaneState.current();
    if (!projectPath) {
      onReadyChange(readinessKey, true);
      return () => {
        live = false;
      };
    }
    const rootRequest = api?.listProjectDir?.(projectPath, '');
    void Promise.resolve(rootRequest ?? [])
      .then((entries) => {
        if (live) setDirs(new Map([['', { expanded: true, entries: entries ?? [] }]]));
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
        void api
          ?.listProjectDir?.(projectPath, rel)
          .then((entries) => {
            if (!entries) return;
            setDirs((latest) => withChangedExplorerDirEntries(latest, rel, entries));
          })
          .catch(() => {
            /* dir removed — next expand reloads */
          });
      }
    };
    const unsubscribeProject = subscribeProjectFileChanges(projectPath, refreshExpanded);
    const timer = window.setInterval(refreshExpanded, SAFETY_REFRESH_MS);
    return () => {
      unsubscribeProject();
      window.clearInterval(timer);
    };
  }, [active, api, projectPath]);
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
            return { rel, entries: await Promise.resolve(api?.listProjectDir?.(projectPath, rel) ?? []) };
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
  }, [api, dirs, projectPath, refreshing]);
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
