// State of the per-pane workspace tab strip (WorkspaceTabStrip.tsx): in-place
// session rename, the tab menu's dismissal, the width the tab run may spend,
// the close/enter motion beat, the phone's + tap feedback, and the native
// drag gestures (reorder inside the strip; a drag below it splits or moves).
import type React from 'react';
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  startTransition,
} from 'react';
import { flushSync } from 'react-dom';
import { clampOverlayIntoView } from './anchored-panel';
import { useMobileBack } from './mobile-back';
import type { WorkspaceTab } from './nav-types';
import {
  acceptPaneDrag,
  beginPaneDrag,
  currentPaneDrag,
  finishPaneDrag,
  type PaneDragSession,
} from './pane-drag-session';
import {
  TAB_MOTION_SETTLE_MS,
  type SetTabMenu,
  type TabMenuAnchor,
  tabDropIndex,
  tabsWithClosingGhosts,
} from './workspace-tab-layout';

export interface TabRename {
  draft: string | null;
  start(tab: WorkspaceTab): void;
  change(value: string): void;
  commit(tab: WorkspaceTab): void;
  cancel(): void;
}

/** Session tabs rename in place (same commit rules as the sidebar row): the
 *  returned function gives each tab its rename, null for a tab that cannot. */
export function useTabRename(
  onRenameSession: ((sessionId: string, title: string) => unknown) | undefined
): (tab: WorkspaceTab) => TabRename | null {
  const [renaming, setRenaming] = useState<{ key: string; draft: string } | null>(null);
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const cancelRename = useCallback(() => {
    // Cleared synchronously so the blur fired by the field unmounting cannot commit the draft.
    renamingRef.current = null;
    setRenaming(null);
  }, []);
  const commitRename = useCallback(
    (tab: WorkspaceTab) => {
      const current = renamingRef.current;
      if (!current || current.key !== tab.key) return;
      renamingRef.current = null;
      setRenaming(null);
      const title = current.draft.trim();
      if (!title || title === tab.title || tab.selection.kind !== 'session') return;
      void onRenameSession?.(tab.selection.id, title);
    },
    [onRenameSession]
  );
  // One identity for the rename actions: the memoised tab cells compare the
  // draft alone (sameTabCell).
  const renameActions = useMemo(
    () => ({
      start: (target: WorkspaceTab) => setRenaming({ key: target.key, draft: target.title }),
      change: (value: string) => setRenaming((current) => (current ? { ...current, draft: value } : current)),
      commit: commitRename,
      cancel: cancelRename,
    }),
    [commitRename, cancelRename]
  );
  return (tab: WorkspaceTab): TabRename | null => {
    if (!onRenameSession || tab.selection.kind !== 'session') return null;
    return { draft: renaming?.key === tab.key ? renaming.draft : null, ...renameActions };
  };
}

/** Tab context menu (Close / Close Others / Close to the Right / Keep Open)
 *  with standard outside-click, Escape, resize, scroll and hardware-back
 *  dismissal, kept on screen by its measured box. */
export function useTabMenuDismiss(
  tabMenu: TabMenuAnchor | null,
  tabMenuNode: RefObject<HTMLDivElement | null>,
  setTabMenu: SetTabMenu
): void {
  useEffect(() => {
    if (!tabMenu) return undefined;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && tabMenuNode.current?.contains(target)) return;
      setTabMenu(null);
    };
    const closeMenu = () => setTabMenu(null);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setTabMenu(null);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [tabMenu, tabMenuNode, setTabMenu]);
  // ABB: the context menu closes on hardware back like every other layer.
  useMobileBack(Boolean(tabMenu), () => setTabMenu(null));
  // Menus can anchor hard against the window's right edge; the measured box
  // is what keeps them on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the menu box is re-clamped whenever a menu opens or moves
  useLayoutEffect(() => {
    clampOverlayIntoView(tabMenuNode.current);
  }, [tabMenu]);
}

/** Layout INPUT: the width the tab run may spend — the shell minus the home
 *  slot, the fixed + slot and the three-control trailing safe zone. */
export function useTabRunWidth(
  shellNode: RefObject<HTMLDivElement | null>,
  tabCount: number,
  hasTrailing: boolean
): number {
  const [, setShellWidth] = useState(0);
  const [stripAvailable, setStripAvailable] = useState(0);
  const measureWidths = useCallback(() => {
    const shell = shellNode.current;
    if (!shell) return;
    const width = shell.clientWidth;
    setShellWidth((previous) => (previous === width ? previous : width));
    const homeButton = shell.querySelector<HTMLElement>(':scope > .workspace-tab-home');
    const newButton = shell.querySelector<HTMLElement>(':scope > .workspace-tab-new');
    const trailingBox = shell.querySelector<HTMLElement>(':scope > .workspace-tabs-trailing');
    const available =
      width - (homeButton?.offsetWidth ?? 0) - (newButton?.offsetWidth ?? 0) - (trailingBox?.offsetWidth ?? 0);
    setStripAvailable((previous) => (previous === available ? previous : available));
  }, [shellNode]);
  // A geometry change (window resize, a sidebar or dock moving the pane edge)
  // re-fits the run in the frame the shell resized, without the glide: the
  // observer's update is rendered synchronously, before that frame paints, and
  // the strip's width transitions stay off for the beat. Left to React's
  // scheduler the labels re-collapsed a frame or more after the pane snapped.
  const geometrySnapFrame = useRef(0);
  const observeWidths = useCallback(() => {
    const shell = shellNode.current;
    if (!shell) return;
    shell.dataset.geometrySnap = 'true';
    window.cancelAnimationFrame(geometrySnapFrame.current);
    geometrySnapFrame.current = window.requestAnimationFrame(() => {
      geometrySnapFrame.current = window.requestAnimationFrame(() => {
        geometrySnapFrame.current = 0;
        delete shell.dataset.geometrySnap;
      });
    });
    flushSync(measureWidths);
  }, [measureWidths, shellNode]);
  useEffect(() => () => window.cancelAnimationFrame(geometrySnapFrame.current), []);
  // Shell width drives the Chrome tab-width ladder.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasTrailing re-attaches the observer when the trailing box mounts or unmounts
  useLayoutEffect(() => {
    const shell = shellNode.current;
    if (!shell || typeof ResizeObserver === 'undefined') return undefined;
    measureWidths();
    const observer = new ResizeObserver(observeWidths);
    observer.observe(shell);
    // The trailing controls resize WITHOUT resizing the shell (a dock toggle
    // appears, a status chip grows); observing the box itself replaces the
    // old re-measure on every render that handed a fresh `trailing` node —
    // which was every App render, each a forced layout inside the commit.
    const trailingBox = shell.querySelector<HTMLElement>(':scope > .workspace-tabs-trailing');
    if (trailingBox) observer.observe(trailingBox);
    return () => observer.disconnect();
  }, [measureWidths, observeWidths, hasTrailing]);
  // Tab-count changes move the available width without resizing the shell —
  // re-measure on those renders too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab count and trailing presence move the available width without resizing the shell
  useLayoutEffect(() => {
    measureWidths();
  }, [tabCount, hasTrailing, measureWidths]);
  return stripAvailable;
}

/** Survivor widths follow the recalculated run immediately; the CSS width
 *  transition glides them instead of holding then jumping.
 *  A tab the strip has just lost stays mounted as a ghost for one motion beat,
 *  collapsing to nothing so its neighbours slide into the released space
 *  instead of jumping across it; a tab the strip has just gained lands whole
 *  in its own commit, the run taking its new cells at once for that beat
 *  (04-workspace-tabs.css), so it never overflows the strip and nothing
 *  slides afterwards. Both are derived during render from the previous tab list: the
 *  closing element is the very node that was open (its width transition
 *  starts from where it stands), and the entering mark is on the node when
 *  it is inserted. A same-length change (a draft promoted to its session)
 *  animates nothing — that is a replacement, not an add or a close. */
export function useTabMotion(tabs: WorkspaceTab[], activeKey: string) {
  const previousTabs = useRef(tabs);
  const previousActiveKey = useRef(activeKey);
  const closingTabs = useRef(new Map<string, { tab: WorkspaceTab; index: number; active: boolean }>());
  const enteringKeys = useRef(new Set<string>());
  const [, settleTabMotion] = useReducer((count: number) => count + 1, 0);
  const displayTabs = tabsWithClosingGhosts(tabs, previousTabs, closingTabs, enteringKeys, previousActiveKey.current);
  useLayoutEffect(() => {
    previousTabs.current = tabs;
    previousActiveKey.current = activeKey;
  }, [tabs, activeKey]);
  // One beat after the last change the ghosts unmount and the entering marks
  // drop; a change inside the beat restarts it so every tab settles together.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a tab list change restarts the settle beat
  useEffect(() => {
    if (!closingTabs.current.size && !enteringKeys.current.size) return undefined;
    const timer = window.setTimeout(() => {
      closingTabs.current.clear();
      enteringKeys.current.clear();
      settleTabMotion();
    }, TAB_MOTION_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [tabs]);
  return { displayTabs, enteringKeys };
}

/** Phone tap feedback for +: the pill names the new task on the tap itself
 *  while the navigation (a pane-wide render) commits as a transition behind
 *  it. The mark holds the tab that was active at the tap and ends when the
 *  active tab changes, or after a beat if the tap changed nothing. Returns
 *  whether the + was just tapped, and the + handler. */
export function useNewTaskTap(mobile: boolean, activeKey: string, onNewTask: () => void): [boolean, () => void] {
  const [newTaskTappedFrom, setNewTaskTappedFrom] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active tab changing is the settle trigger; the body does not read it
  useEffect(() => setNewTaskTappedFrom(null), [activeKey]);
  useEffect(() => {
    if (newTaskTappedFrom === null) return undefined;
    const timer = window.setTimeout(() => setNewTaskTappedFrom(null), 800);
    return () => window.clearTimeout(timer);
  }, [newTaskTappedFrom]);
  const tapNewTask = () => {
    if (!mobile) return onNewTask();
    setNewTaskTappedFrom(activeKey);
    startTransition(onNewTask);
  };
  return [newTaskTappedFrom !== null && newTaskTappedFrom === activeKey, tapNewTask];
}

/** The strip's native drag gestures: a tab (or the whole group, dragged by
 *  the strip itself) starts a pane drag; a tab dropped back on its own strip
 *  reorders at the half-tab drop index. */
export function useTabStripDrag({
  tabs,
  paneId,
  tabStrip,
  tabNodes,
  onReorderTab,
}: {
  tabs: WorkspaceTab[];
  paneId: string;
  tabStrip: RefObject<HTMLElement | null>;
  tabNodes: RefObject<Map<string, HTMLDivElement>>;
  onReorderTab(sourceKey: string, target: string | number): void;
}) {
  const nativeDrag = useRef<PaneDragSession | null>(null);
  const dragSourceMounted = useRef(true);
  const suppressTabClick = useRef('');
  const [draggingKey, setDraggingKey] = useState('');
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingGroup, setDraggingGroup] = useState(false);
  const [dragScroll, setDragScroll] = useState(false);

  const clearNativeDrag = useCallback(() => {
    const drag = nativeDrag.current;
    nativeDrag.current = null;
    delete document.body.dataset.tabDragging;
    if (!dragSourceMounted.current) return;
    setDraggingKey('');
    setDraggingGroup(false);
    setDragScroll(false);
    setDropIndex(null);
    if (drag?.kind === 'tab') {
      suppressTabClick.current = drag.key;
      window.setTimeout(() => {
        if (suppressTabClick.current === drag.key) suppressTabClick.current = '';
      }, 0);
    }
  }, []);
  const finishNativeDrag = useCallback(() => finishPaneDrag(), []);
  useEffect(() => {
    dragSourceMounted.current = true;
    return () => {
      dragSourceMounted.current = false;
      if (nativeDrag.current) finishPaneDrag();
      nativeDrag.current = null;
      delete document.body.dataset.tabDragging;
    };
  }, []);

  const startNativeDrag = useCallback(
    (event: React.DragEvent<HTMLElement>, kind: 'tab' | 'group', sourceTab: WorkspaceTab | undefined) => {
      if (!sourceTab) {
        event.preventDefault();
        return;
      }
      const drag: PaneDragSession = {
        kind,
        key: sourceTab.key,
        title: sourceTab.title,
        selection: sourceTab.selection,
        sourceLeafId: paneId,
      };
      beginPaneDrag(event.nativeEvent, drag, event.currentTarget, clearNativeDrag);
      nativeDrag.current = drag;
      if (kind === 'group') setDraggingGroup(true);
      else setDraggingKey(sourceTab.key);
      document.body.dataset.tabDragging = '1';
    },
    [clearNativeDrag, paneId]
  );

  const dropIndexAt = useCallback(
    (clientX: number, target: EventTarget | null): number | null => {
      const strip = tabStrip.current;
      if (!strip) return null;
      return tabDropIndex({ tabs, tabNodes: tabNodes.current, strip, clientX, target });
    },
    [tabs, tabStrip, tabNodes]
  );

  const handleNativeDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const drag = currentPaneDrag();
      if (!drag) return;
      setDragScroll(true);
      if (drag.kind !== 'tab' || drag.sourceLeafId !== paneId) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      setDropIndex(dropIndexAt(event.clientX, event.target));
    },
    [dropIndexAt, paneId]
  );

  const handleNativeDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const drag = currentPaneDrag();
      if (drag?.kind !== 'tab' || drag.sourceLeafId !== paneId) return;
      event.preventDefault();
      event.stopPropagation();
      const index = dropIndexAt(event.clientX, event.target);
      if (index !== null) onReorderTab(drag.key, index);
      acceptPaneDrag();
      setDropIndex(null);
    },
    [dropIndexAt, onReorderTab, paneId]
  );

  const enterStrip = () => setDragScroll(true);
  const leaveStrip = (event: React.DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragScroll(false);
    setDropIndex(null);
  };

  return {
    draggingKey,
    dropIndex,
    draggingGroup,
    dragScroll,
    suppressTabClick,
    startNativeDrag,
    finishNativeDrag,
    handleNativeDragOver,
    handleNativeDrop,
    enterStrip,
    leaveStrip,
  };
}
