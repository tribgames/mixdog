import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopApi } from '../shared/contract';
import { errorMessage } from './editor-pane-session-errors';
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
  explorerRevealStep,
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
  return failure ? new Map([['', { expanded: true, entries: [], error: errorMessage(failure.reason) }]]) : new Map();
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
        .catch((reason) => patch(rel, { entries: [], error: errorMessage(reason) }));
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
                  error: errorMessage(reason),
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

/** Auto-reveal: expands the ancestors of the active editor file step by step;
 *  each load/expand re-runs the effect until the row exists, then `onRevealed`
 *  selects it. Never steals keyboard focus. */
export function useExplorerReveal(input: {
  active: boolean;
  projectPath: string;
  activeFileKey: string;
  revealNonce: number;
  /** The target is a folder: after its ancestors open, it expands too. */
  revealDir: boolean;
  /** True while an inline edit owns the tree (the reveal waits). */
  editing: boolean;
  tree: Pick<ExplorerDirTree, 'dirs' | 'load' | 'patch' | 'expandDir'>;
  onRevealed(rel: string): void;
  scrollToRow(rel: string): void;
}) {
  const { active, projectPath, activeFileKey, revealNonce, revealDir, editing, tree, onRevealed, scrollToRow } = input;
  const { dirs, load, patch, expandDir } = tree;
  const revealTarget = useRef('');
  const latest = useRef({ expandDir, editing, onRevealed, scrollToRow });
  latest.current = { expandDir, editing, onRevealed, scrollToRow };
  // biome-ignore lint/correctness/useExhaustiveDependencies: revealNonce is the deliberate trigger - a repeat reveal of the same file must re-arm the target.
  useEffect(() => {
    if (!active || !projectPath) return;
    const prefix = `file:${projectPath}:`;
    if (!activeFileKey.startsWith(prefix)) return;
    const rel = activeFileKey.slice(prefix.length).replace(/\\/g, '/');
    if (rel) revealTarget.current = rel;
  }, [active, activeFileKey, projectPath, revealNonce]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeFileKey and revealNonce re-run the stepwise reveal for a new target.
  useEffect(() => {
    const rel = revealTarget.current;
    if (!rel || !active || latest.current.editing) return;
    // The root listing replaces the whole map when it lands, so a folder
    // reveal waits for it instead of being wiped.
    if (revealDir && !dirs.get('')?.entries) return;
    const step = explorerRevealStep(dirs, rel);
    if (step.kind === 'load') {
      load(step.rel);
      return;
    }
    if (step.kind === 'expand') {
      patch(step.rel, { expanded: true });
      return;
    }
    if (step.kind === 'pending') return;
    // Ready or abandoned: either way this target is done steering the tree.
    revealTarget.current = '';
    if (step.kind === 'blocked') return;
    latest.current.onRevealed(rel);
    if (revealDir) latest.current.expandDir(rel);
    window.requestAnimationFrame(() => latest.current.scrollToRow(rel));
  }, [active, activeFileKey, dirs, load, patch, revealDir, revealNonce]);
}
