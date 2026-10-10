// Owner state for the split-pane workspace. App mounts usePaneWorkspace and
// hands the tree to PaneSplitLayout; this hook owns focus, the split/close/
// open commands, and persistence. It deliberately knows nothing about what a
// leaf renders — the integration layer maps NavigationSelection to views —
// so it stays testable and independent of the in-flight renderer work.
import { useCallback, useMemo } from 'react';

import type { WorkspaceSelection } from './nav-types';
import { paneDropDirection, paneDropPosition } from './pane-drop-zone';
import { createNewTaskPaneLeaf } from './pane-workspace-storage';
import { usePaneWorkspaceState } from './use-pane-workspace-restore';
import { navigationKey } from './text-format';
import {
  activateTabInPaneLeaf,
  canSplitPaneSize,
  closePaneLeaf,
  closeTabInPaneLeaf,
  createPaneLeaf,
  distributePaneRatiosAlong,
  findPaneLeaf,
  mergePaneLeaf,
  movePaneLeaf,
  movePaneLeafToNodeEdge,
  movePaneLeafToRootEdge,
  movePaneTabToNodeEdge,
  movePaneTabToRootEdge,
  neighborPaneLeafId,
  openTabInPaneLeaf,
  paneActiveSelection,
  paneLeafParentDirection,
  paneLeafContainingKey,
  paneLeaves,
  pinTabInPaneLeaf,
  reorderTabInPaneLeaf,
  updateTabSelectionInPaneLeaf,
  setPaneSplitRatio,
  splitPaneLeaf,
  type PaneDirection,
  type PaneLeaf,
  type PaneNode,
} from './pane-layout';

function rebalancePaneAxes(layout: PaneNode, ...directions: ReadonlyArray<PaneDirection | null>): PaneNode {
  let next = layout;
  const seen = new Set<PaneDirection>();
  for (const direction of directions) {
    if (!direction || seen.has(direction)) continue;
    seen.add(direction);
    next = distributePaneRatiosAlong(next, direction);
  }
  return next;
}

export { initialPaneWorkspaceState } from './pane-workspace-storage';

/** Drop zone of a drag-to-split gesture over one pane. */
export type PaneDropZone = 'left' | 'right' | 'top' | 'bottom';

function isSoleNewTaskPane(layout: PaneNode, leafId: string): boolean {
  return layout.type === 'leaf' && layout.id === leafId && layout.tabs.length === 1 && layout.tabs[0].kind === 'new';
}

export function usePaneWorkspace(initialSelection: WorkspaceSelection | null = null) {
  const { setState, state, restorePending, restoredFromStorage } = usePaneWorkspaceState(initialSelection);

  const focusLeaf = useCallback(
    (leafId: string) => {
      setState((prev) =>
        prev.focusedLeafId !== leafId && findPaneLeaf(prev.layout, leafId) ? { ...prev, focusedLeafId: leafId } : prev
      );
    },
    [setState]
  );

  const setRatio = useCallback(
    (path: string, ratio: number) => {
      setState((prev) => {
        const layout = setPaneSplitRatio(prev.layout, path, ratio);
        return layout === prev.layout ? prev : { ...prev, layout };
      });
    },
    [setState]
  );

  /** Navigation inside the focused pane (sidebar click, session open):
   *  activate the existing tab or open a new one in the focused group.
   *  `replaceKey` promotes a draft tab in place. A view that is already open
   *  in ANOTHER group is REVEALED there instead of duplicated (one live
   *  surface per session — duplicates share one engine and read as a bug). */
  const openInFocused = useCallback(
    (selection: WorkspaceSelection, replaceKey = '', options: { preview?: boolean } = {}) => {
      setState((prev) => {
        if (!replaceKey) {
          const key = navigationKey(selection);
          const focused = findPaneLeaf(prev.layout, prev.focusedLeafId);
          if (!focused?.tabs.some((tab) => navigationKey(tab) === key)) {
            const owner = paneLeaves(prev.layout).find(
              (leaf) => leaf.id !== prev.focusedLeafId && leaf.tabs.some((tab) => navigationKey(tab) === key)
            );
            if (owner) {
              return {
                layout: openTabInPaneLeaf(prev.layout, owner.id, selection, '', options),
                focusedLeafId: owner.id,
              };
            }
          }
        }
        const layout = openTabInPaneLeaf(prev.layout, prev.focusedLeafId, selection, replaceKey, options);
        return layout === prev.layout ? prev : { ...prev, layout };
      });
    },
    [setState]
  );

  /** Explicit pane drop: open a closed view in the target group, or MOVE its
   *  existing tab there so one live surface per session remains invariant. */
  const openInLeaf = useCallback(
    (leafId: string, selection: WorkspaceSelection, index?: number) => {
      setState((prev) => {
        if (!findPaneLeaf(prev.layout, leafId)) return prev;
        const key = navigationKey(selection);
        const owner = paneLeafContainingKey(prev.layout, key);
        let layout: PaneNode = prev.layout;
        if (owner && owner.id !== leafId) {
          const collapseDirection = owner.tabs.length === 1 ? paneLeafParentDirection(layout, owner.id) : null;
          const removed = closeTabInPaneLeaf(layout, owner.id, key);
          if (!removed || !findPaneLeaf(removed, leafId)) return prev;
          layout = rebalancePaneAxes(removed, collapseDirection);
        }
        const next = openTabInPaneLeaf(layout, leafId, selection, '', { index });
        if (next === prev.layout && prev.focusedLeafId === leafId) return prev;
        return { layout: next, focusedLeafId: leafId };
      });
    },
    [setState]
  );

  /** Addressed draft promotion: replace the exact tab in its owning group
   * without changing which group currently owns keyboard focus. */
  const promoteInLeaf = useCallback(
    (leafId: string, selection: WorkspaceSelection, replaceKey: string) => {
      setState((prev) => {
        const leaf = findPaneLeaf(prev.layout, leafId);
        if (!leaf?.tabs.some((tab) => navigationKey(tab) === replaceKey)) return prev;
        const layout = openTabInPaneLeaf(prev.layout, leafId, selection, replaceKey);
        return layout === prev.layout
          ? prev
          : {
              layout,
              focusedLeafId: prev.focusedLeafId,
            };
      });
    },
    [setState]
  );

  /** Refresh an open tab's own state (a browser tab's last URL/title) without
   *  activating, moving or refocusing anything. */
  const updateSelection = useCallback(
    (leafId: string, selection: WorkspaceSelection) => {
      setState((prev) => {
        const layout = updateTabSelectionInPaneLeaf(prev.layout, leafId, selection);
        return layout === prev.layout ? prev : { ...prev, layout };
      });
    },
    [setState]
  );

  const pinTab = useCallback(
    (leafId: string, key: string) => {
      setState((prev) => {
        const layout = pinTabInPaneLeaf(prev.layout, leafId, key);
        return layout === prev.layout ? prev : { ...prev, layout };
      });
    },
    [setState]
  );

  const pinTabByKey = useCallback(
    (key: string) => {
      setState((prev) => {
        const owner = paneLeafContainingKey(prev.layout, key);
        if (!owner) return prev;
        const layout = pinTabInPaneLeaf(prev.layout, owner.id, key);
        return layout === prev.layout ? prev : { ...prev, layout };
      });
    },
    [setState]
  );

  /** Strip click: activate a tab inside its group and focus that pane. */
  const activateTab = useCallback(
    (leafId: string, key: string) => {
      setState((prev) => {
        const layout = activateTabInPaneLeaf(prev.layout, leafId, key);
        if (layout === prev.layout && prev.focusedLeafId === leafId) return prev;
        return {
          layout,
          focusedLeafId: findPaneLeaf(layout, leafId) ? leafId : prev.focusedLeafId,
        };
      });
    },
    [setState]
  );

  const reorderTab = useCallback(
    (leafId: string, sourceKey: string, target: string | number) => {
      setState((prev) => {
        const layout = reorderTabInPaneLeaf(prev.layout, leafId, sourceKey, target);
        return layout === prev.layout ? prev : { ...prev, layout };
      });
    },
    [setState]
  );

  /** Close one tab in one group; an emptied group collapses into its sibling
   *  and hands focus to its neighbor (same fallback rule as the old strip). */
  const closeTab = useCallback(
    (leafId: string, key: string) => {
      setState((prev) => {
        const target = findPaneLeaf(prev.layout, leafId);
        if (!target) return prev;
        if (isSoleNewTaskPane(prev.layout, leafId)) return prev;
        const collapsing = target.tabs.length === 1;
        const fallback = collapsing ? neighborPaneLeafId(prev.layout, leafId) : null;
        const collapseDirection = collapsing ? paneLeafParentDirection(prev.layout, leafId) : null;
        const collapsedLayout = closeTabInPaneLeaf(prev.layout, leafId, key);
        if (collapsedLayout === prev.layout) return prev;
        if (!collapsedLayout) {
          const leaf = createNewTaskPaneLeaf(target.id);
          return { layout: leaf, focusedLeafId: leaf.id };
        }
        const layout = rebalancePaneAxes(collapsedLayout, collapseDirection);
        let focusedLeafId = prev.focusedLeafId;
        if (collapsing && prev.focusedLeafId === leafId) {
          focusedLeafId = fallback && findPaneLeaf(layout, fallback) ? fallback : paneLeaves(layout)[0].id;
        }
        return { layout, focusedLeafId };
      });
    },
    [setState]
  );

  /** Close a tab wherever it is open (global close paths: Ctrl+W, registry
   *  close). Groups that empty out collapse as usual. */
  const closeTabByKey = useCallback(
    (key: string) => {
      setState((prev) => {
        let layout: PaneNode | null = prev.layout;
        let focusedLeafId = prev.focusedLeafId;
        if (isSoleNewTaskPane(prev.layout, prev.focusedLeafId)) return prev;
        for (const leaf of paneLeaves(prev.layout)) {
          if (!layout) break;
          if (!findPaneLeaf(layout, leaf.id)) continue;
          if (!leaf.tabs.some((tab) => navigationKey(tab) === key)) continue;
          const collapsing = leaf.tabs.length === 1;
          const fallback = collapsing ? neighborPaneLeafId(layout, leaf.id) : null;
          const collapseDirection = collapsing ? paneLeafParentDirection(layout, leaf.id) : null;
          layout = closeTabInPaneLeaf(layout, leaf.id, key);
          if (layout) layout = rebalancePaneAxes(layout, collapseDirection);
          if (collapsing && focusedLeafId === leaf.id && layout) {
            focusedLeafId = fallback && findPaneLeaf(layout, fallback) ? fallback : paneLeaves(layout)[0].id;
          }
        }
        if (layout === prev.layout) return prev;
        if (!layout) {
          const leaf = createNewTaskPaneLeaf(prev.focusedLeafId);
          return { layout: leaf, focusedLeafId: leaf.id };
        }
        if (!findPaneLeaf(layout, focusedLeafId)) focusedLeafId = paneLeaves(layout)[0].id;
        return { layout, focusedLeafId };
      });
    },
    [setState]
  );

  /** Editor split: the focused pane keeps its cell, the new
   *  pane opens beside (row) or below (column) it and takes focus. */
  const splitFocused = useCallback(
    (
      direction: PaneDirection,
      selection: WorkspaceSelection = { kind: 'new' },
      availableSize?: { width: number; height: number }
    ) => {
      if (availableSize && !canSplitPaneSize(direction, availableSize.width, availableSize.height)) return;
      setState((prev) => {
        const leaf = createPaneLeaf(selection);
        const splitLayout = splitPaneLeaf(prev.layout, prev.focusedLeafId, direction, leaf);
        const layout = splitLayout === prev.layout ? splitLayout : rebalancePaneAxes(splitLayout, direction);
        return splitLayout === prev.layout ? prev : { layout, focusedLeafId: leaf.id };
      });
    },
    [setState]
  );

  const closeLeaf = useCallback(
    (leafId: string) => {
      setState((prev) => {
        if (isSoleNewTaskPane(prev.layout, leafId)) return prev;
        const fallback = neighborPaneLeafId(prev.layout, leafId);
        const collapseDirection = paneLeafParentDirection(prev.layout, leafId);
        const collapsedLayout = closePaneLeaf(prev.layout, leafId);
        if (collapsedLayout === prev.layout) return prev;
        if (!collapsedLayout) {
          const leaf = createNewTaskPaneLeaf(leafId);
          return { layout: leaf, focusedLeafId: leaf.id };
        }
        const layout = rebalancePaneAxes(collapsedLayout, collapseDirection);
        const focusedLeafId =
          prev.focusedLeafId === leafId ? (fallback ?? paneLeaves(layout)[0].id) : prev.focusedLeafId;
        return { layout, focusedLeafId };
      });
    },
    [setState]
  );

  /** Drag-to-split: drop a dragged tab on one pane's edge zone. The new pane
   *  opens on that side and takes focus. With a sourceLeafId the tab MOVES
   *  — it leaves its source group, which collapses when emptied.
   *  Dropping a view onto a pane that already shows it is a no-op. */
  const splitLeafAt = useCallback(
    (leafId: string, zone: PaneDropZone, selection: WorkspaceSelection, sourceLeafId = '') => {
      setState((prev) => {
        const target = findPaneLeaf(prev.layout, leafId);
        const key = navigationKey(selection);
        if (!target) return prev;
        const targetActive = paneActiveSelection(target);
        // A drop beside a DIFFERENT pane that already shows the view is a
        // no-op; splitting a multi-tab group with its own tab is the standard
        // gesture. (A single-tab self split shows no overlay
        // and stays a guarded no-op here.)
        if (sourceLeafId !== leafId && targetActive && navigationKey(targetActive) === key) return prev;
        let layout: PaneNode = prev.layout;
        const source = sourceLeafId ? findPaneLeaf(layout, sourceLeafId) : null;
        const collapseDirection = source?.tabs.length === 1 ? paneLeafParentDirection(layout, sourceLeafId) : null;
        if (source?.tabs.some((tab) => navigationKey(tab) === key)) {
          // A tab drag always MOVES (one live surface per view): the old
          // keep-a-copy-behind fallback put the SAME session in two panes,
          // which share one engine and read as a duplication bug. Splitting a
          // group with its only tab onto itself is simply a no-op.
          if (sourceLeafId === leafId && source.tabs.length === 1) return prev;
          const removed = closeTabInPaneLeaf(layout, sourceLeafId, key);
          if (!removed || !findPaneLeaf(removed, leafId)) return prev;
          layout = removed;
        }
        const leaf = createPaneLeaf(selection);
        const direction = paneDropDirection(zone);
        const splitLayout = splitPaneLeaf(layout, leafId, direction, leaf, 0.5, paneDropPosition(zone));
        if (splitLayout === prev.layout) return prev;
        const next = rebalancePaneAxes(splitLayout, collapseDirection, direction);
        return {
          layout: next,
          focusedLeafId: findPaneLeaf(next, leaf.id) ? leaf.id : prev.focusedLeafId,
        };
      });
    },
    [setState]
  );

  /** Drag-to-merge (center/strip drop): move a tab into another
   *  group; the emptied source group collapses and the target takes focus.
   *  A strip drop passes the pointed insert index. */
  const moveTab = useCallback(
    (sourceLeafId: string, key: string, targetLeafId: string, index?: number) => {
      setState((prev) => {
        if (!sourceLeafId || sourceLeafId === targetLeafId) return prev;
        const source = findPaneLeaf(prev.layout, sourceLeafId);
        const selection = source?.tabs.find((tab) => navigationKey(tab) === key);
        if (!source || !selection || !findPaneLeaf(prev.layout, targetLeafId)) return prev;
        const collapseDirection = source.tabs.length === 1 ? paneLeafParentDirection(prev.layout, sourceLeafId) : null;
        const removed = closeTabInPaneLeaf(prev.layout, sourceLeafId, key);
        if (!removed || !findPaneLeaf(removed, targetLeafId)) return prev;
        return {
          layout: rebalancePaneAxes(
            openTabInPaneLeaf(removed, targetLeafId, selection, '', { index }),
            collapseDirection
          ),
          focusedLeafId: targetLeafId,
        };
      });
    },
    [setState]
  );

  const mergeGroup = useCallback(
    (sourceLeafId: string, targetLeafId: string, index?: number) => {
      setState((prev) => {
        const collapseDirection = paneLeafParentDirection(prev.layout, sourceLeafId);
        const mergedLayout = mergePaneLeaf(prev.layout, sourceLeafId, targetLeafId, index);
        if (mergedLayout === prev.layout) return prev;
        const layout = rebalancePaneAxes(mergedLayout, collapseDirection);
        return {
          layout,
          focusedLeafId: findPaneLeaf(layout, targetLeafId) ? targetLeafId : paneLeaves(layout)[0].id,
        };
      });
    },
    [setState]
  );

  const moveGroupAt = useCallback(
    (sourceLeafId: string, targetLeafId: string, zone: PaneDropZone) => {
      setState((prev) => {
        const direction = paneDropDirection(zone);
        const collapseDirection = paneLeafParentDirection(prev.layout, sourceLeafId);
        const movedLayout = movePaneLeaf(prev.layout, sourceLeafId, targetLeafId, direction, paneDropPosition(zone));
        if (movedLayout === prev.layout) return prev;
        const layout = rebalancePaneAxes(movedLayout, collapseDirection, direction);
        return {
          layout,
          focusedLeafId: findPaneLeaf(layout, sourceLeafId) ? sourceLeafId : prev.focusedLeafId,
        };
      });
    },
    [setState]
  );

  const moveGroupToRootEdge = useCallback(
    (sourceLeafId: string, zone: PaneDropZone) => {
      setState((prev) => {
        const direction = paneDropDirection(zone);
        const collapseDirection = paneLeafParentDirection(prev.layout, sourceLeafId);
        const movedLayout = movePaneLeafToRootEdge(prev.layout, sourceLeafId, direction, paneDropPosition(zone));
        if (movedLayout === prev.layout) return prev;
        const layout = rebalancePaneAxes(movedLayout, collapseDirection, direction);
        return { layout, focusedLeafId: sourceLeafId };
      });
    },
    [setState]
  );

  const moveGroupToNodeEdge = useCallback(
    (sourceLeafId: string, targetPath: string, zone: PaneDropZone) => {
      setState((prev) => {
        const direction = paneDropDirection(zone);
        const collapseDirection = paneLeafParentDirection(prev.layout, sourceLeafId);
        const movedLayout = movePaneLeafToNodeEdge(
          prev.layout,
          sourceLeafId,
          targetPath,
          direction,
          paneDropPosition(zone)
        );
        if (movedLayout === prev.layout) return prev;
        const layout = rebalancePaneAxes(movedLayout, collapseDirection, direction);
        return { layout, focusedLeafId: sourceLeafId };
      });
    },
    [setState]
  );

  const moveTabToRootEdge = useCallback(
    (sourceLeafId: string, key: string, zone: PaneDropZone) => {
      setState((prev) => {
        const direction = paneDropDirection(zone);
        const source = findPaneLeaf(prev.layout, sourceLeafId);
        const collapseDirection = source?.tabs.length === 1 ? paneLeafParentDirection(prev.layout, sourceLeafId) : null;
        const movedLayout = movePaneTabToRootEdge(prev.layout, sourceLeafId, key, direction, paneDropPosition(zone));
        if (movedLayout === prev.layout) return prev;
        const layout = rebalancePaneAxes(movedLayout, collapseDirection, direction);
        return {
          layout,
          focusedLeafId: paneLeafContainingKey(layout, key)?.id ?? prev.focusedLeafId,
        };
      });
    },
    [setState]
  );

  const moveTabToNodeEdge = useCallback(
    (sourceLeafId: string, key: string, targetPath: string, zone: PaneDropZone) => {
      setState((prev) => {
        const direction = paneDropDirection(zone);
        const source = findPaneLeaf(prev.layout, sourceLeafId);
        const collapseDirection = source?.tabs.length === 1 ? paneLeafParentDirection(prev.layout, sourceLeafId) : null;
        const movedLayout = movePaneTabToNodeEdge(
          prev.layout,
          sourceLeafId,
          key,
          targetPath,
          direction,
          paneDropPosition(zone)
        );
        if (movedLayout === prev.layout) return prev;
        const layout = rebalancePaneAxes(movedLayout, collapseDirection, direction);
        return {
          layout,
          focusedLeafId: paneLeafContainingKey(layout, key)?.id ?? prev.focusedLeafId,
        };
      });
    },
    [setState]
  );

  const leaves = useMemo(() => paneLeaves(state.layout), [state.layout]);
  const focusedLeaf: PaneLeaf | null = useMemo(
    () => findPaneLeaf(state.layout, state.focusedLeafId) ?? leaves[0] ?? null,
    [state.layout, state.focusedLeafId, leaves]
  );

  return useMemo(
    () => ({
      layout: state.layout,
      restoredFromStorage,
      restorePending,
      leaves,
      focusedLeaf,
      focusedLeafId: focusedLeaf?.id ?? '',
      focusLeaf,
      openInFocused,
      openInLeaf,
      promoteInLeaf,
      updateSelection,
      pinTab,
      pinTabByKey,
      activateTab,
      reorderTab,
      closeTab,
      closeTabByKey,
      splitFocused,
      splitLeafAt,
      moveTab,
      mergeGroup,
      moveGroupAt,
      moveGroupToRootEdge,
      moveGroupToNodeEdge,
      moveTabToRootEdge,
      moveTabToNodeEdge,
      closeLeaf,
      setRatio,
    }),
    [
      state.layout,
      restoredFromStorage,
      restorePending,
      leaves,
      focusedLeaf,
      focusLeaf,
      openInFocused,
      openInLeaf,
      promoteInLeaf,
      updateSelection,
      pinTab,
      pinTabByKey,
      activateTab,
      reorderTab,
      closeTab,
      closeTabByKey,
      splitFocused,
      splitLeafAt,
      moveTab,
      mergeGroup,
      moveGroupAt,
      moveGroupToRootEdge,
      moveGroupToNodeEdge,
      moveTabToRootEdge,
      moveTabToNodeEdge,
      closeLeaf,
      setRatio,
    ]
  );
}
