import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { dataTransferHasLocalFiles, droppedLocalPaths } from './file-drag';
import {
  cancelPaneDragPreview,
  currentPaneDrag,
  dropPaneDrag,
  movePaneDrag,
  subscribePaneDrag,
} from './pane-drag-session';
import { commitPaneDropAction, resolvePaneDropIntent, sameDropPreview } from './pane-drop-intent';
import type { DropPreview } from './pane-drop-intent';
import { paneNodeMinimumSize, type PaneNode } from './pane-layout';
import type { usePaneWorkspace } from './pane-workspace-state';
import type { WorkspaceSelection } from './nav-types';
import { NARROW_SHELL_QUERY, useMediaBand } from './use-responsive-shell-bands';

/** Native/internal file drops onto a pane: tracks the hovered pane and builds
 *  the per-leaf drag handlers. */
export function usePaneFileDrop(onOpenDroppedPaths?: (leafId: string, paths: string[]) => void | Promise<void>) {
  const [fileDropLeafId, setFileDropLeafId] = useState('');
  useEffect(() => {
    const clear = () => setFileDropLeafId('');
    // An OS drag (Explorer) never sends this window its dragend, and Chromium
    // can skip the dragleave when the pointer exits the window fast, which
    // left the drop frame drawn around the pane after the drag was long gone
    // (user: 메인 패널 테두리 버그냐). No pointer event is dispatched while a
    // drag is in flight, so the first one proves the drag is over.
    window.addEventListener('drop', clear, true);
    window.addEventListener('dragend', clear, true);
    window.addEventListener('pointermove', clear, true);
    window.addEventListener('pointerdown', clear, true);
    return () => {
      window.removeEventListener('drop', clear, true);
      window.removeEventListener('dragend', clear, true);
      window.removeEventListener('pointermove', clear, true);
      window.removeEventListener('pointerdown', clear, true);
    };
  }, []);
  const fileDropPropsFor = (leafId: string) => {
    if (!onOpenDroppedPaths) return {};
    return {
      'data-file-dropping': fileDropLeafId === leafId ? 'true' : undefined,
      onDragEnter: (event: React.DragEvent<HTMLDivElement>) => {
        if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
        event.preventDefault();
        setFileDropLeafId(leafId);
      },
      onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
        if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setFileDropLeafId(leafId);
      },
      onDragLeave: (event: React.DragEvent<HTMLDivElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setFileDropLeafId((current) => (current === leafId ? '' : current));
      },
      onDrop: (event: React.DragEvent<HTMLDivElement>) => {
        if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
        const paths = droppedLocalPaths(event.dataTransfer);
        if (!paths.length) return;
        event.preventDefault();
        event.stopPropagation();
        setFileDropLeafId('');
        void onOpenDroppedPaths(leafId, paths);
      },
    };
  };
  return fileDropPropsFor;
}

/** Marks the pane a text-selection gesture began in so CSS can fence every other pane. */
export function usePaneSelectionFence() {
  // Selection is ONE document-wide range, so a drag that starts in one pane
  // and travels over another painted every row in between (user: 왜 드래그가
  // 패널별로 분리 안 되어 있어). Mark the pane the gesture began in; CSS
  // suspends selection in every OTHER pane until the pointer is released, so
  // each pane reads as its own document the way editor groups do.
  useEffect(() => {
    const root = document.documentElement;
    const release = (): void => {
      document.querySelector<HTMLElement>('.pane-leaf[data-selecting]')?.removeAttribute('data-selecting');
      delete root.dataset.paneSelecting;
    };
    const onPointerDown = (event: PointerEvent): void => {
      // Only a primary-button drag selects text; keep right-click menus and
      // middle-click paste out of it.
      if (event.button !== 0) return;
      release();
      const target = event.target instanceof Element ? event.target : null;
      const leaf = target?.closest<HTMLElement>('.pane-leaf');
      // A single-pane workspace has no .pane-leaf wrapper and needs no fence.
      if (!leaf) return;
      leaf.dataset.selecting = 'true';
      root.dataset.paneSelecting = 'true';
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
      release();
    };
  }, []);
}

/** Drag-to-split: previews the edge zone under a dragged tab and commits the drop. */
export function usePaneDropPreview(
  workspace: ReturnType<typeof usePaneWorkspace>,
  onFocusSelection: (selection: WorkspaceSelection) => void
) {
  // Drag-to-split: native dragover publishes target-local frames once a tab
  // leaves the strip band; hit-test the pane under the
  // pointer, preview the edge zone, and split on drop. Refs keep the single
  // subscription stable across renders.
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const focusSelectionRef = useRef(onFocusSelection);
  focusSelectionRef.current = onFocusSelection;
  useEffect(
    () =>
      subscribePaneDrag((frame) => {
        if (frame.phase === 'cancel') {
          setDropPreview(null);
          return;
        }
        const current = workspaceRef.current;
        const panelElement = document.querySelector<HTMLElement>('.main-panel');
        const intent = panelElement ? resolvePaneDropIntent(frame, current, panelElement) : null;
        if (frame.phase === 'move') {
          if (!intent) {
            setDropPreview(null);
          } else {
            setDropPreview((currentPreview) =>
              sameDropPreview(currentPreview, intent.preview) ? currentPreview : intent.preview
            );
          }
          return;
        }
        setDropPreview(null);
        if (!intent) return;
        commitPaneDropAction(current, intent.action);
        focusSelectionRef.current(intent.selection);
      }),
    []
  );
  useEffect(() => {
    const panel = document.querySelector<HTMLElement>('.main-panel');
    if (!panel) return undefined;
    let enterCounter = 0;
    const isSourceStripReorder = (event: DragEvent): boolean => {
      const drag = currentPaneDrag();
      if (drag?.kind !== 'tab' || !drag.sourceLeafId) return false;
      const target = event.target instanceof Element ? event.target : null;
      const strip = target?.closest('.workspace-tabs-shell');
      const pane = strip?.closest<HTMLElement>('[data-pane-id]');
      return pane?.dataset.paneId === drag.sourceLeafId;
    };
    // A bot list inside a pane reorders its own rows (bot-reorder.tsx): a
    // session dragged over it is the list's, never a split preview or pane drop.
    const inBotOrderZone = (event: DragEvent): boolean => {
      const target = event.target instanceof Element ? event.target : null;
      return currentPaneDrag()?.kind === 'session' && target?.closest('[data-pane-drag-zone="bot-order"]') != null;
    };
    const onDragEnter = (event: DragEvent): void => {
      if (!currentPaneDrag()) return;
      enterCounter += 1;
      if (isSourceStripReorder(event) || inBotOrderZone(event)) {
        cancelPaneDragPreview();
        return;
      }
      // dragenter coordinates can be synthetic or stale in Chromium. It only
      // admits the native drop; dragover owns every preview coordinate.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    };
    const onDragOver = (event: DragEvent): void => {
      if (!currentPaneDrag()) return;
      if (isSourceStripReorder(event) || inBotOrderZone(event)) {
        cancelPaneDragPreview();
        return;
      }
      movePaneDrag(event);
    };
    const onDragLeave = (): void => {
      if (!currentPaneDrag()) return;
      enterCounter = Math.max(0, enterCounter - 1);
      if (enterCounter === 0) cancelPaneDragPreview();
    };
    const onDrop = (event: DragEvent): void => {
      if (!currentPaneDrag()) return;
      enterCounter = 0;
      if (isSourceStripReorder(event) || inBotOrderZone(event)) {
        cancelPaneDragPreview();
        return;
      }
      dropPaneDrag(event);
    };
    panel.addEventListener('dragenter', onDragEnter);
    panel.addEventListener('dragover', onDragOver);
    panel.addEventListener('dragleave', onDragLeave);
    panel.addEventListener('drop', onDrop);
    return () => {
      panel.removeEventListener('dragenter', onDragEnter);
      panel.removeEventListener('dragover', onDragOver);
      panel.removeEventListener('dragleave', onDragLeave);
      panel.removeEventListener('drop', onDrop);
    };
  }, []);
  return dropPreview;
}

/** Whether the tree must collapse to one full-size pane (narrow shell or floors that do not fit). */
export function useSinglePaneMode(layout: PaneNode) {
  // Narrow shell (≤760px, phone composition): the split grid cannot hold two
  // panes above their floors, so the tree renders as ONE full-size pane at a
  // time — single-session mode (user decision) — and the strip-row pager
  // steps left/right through the panes in visual order.
  const narrowShell = useMediaBand(NARROW_SHELL_QUERY);
  // The band check alone is not enough: on a mid-width window the panel can
  // shrink under the TREE's aggregate floors (side panels open, column
  // splits taller than the window) and the overflow buried panes past the
  // right or BOTTOM edge (user: 하단이 묻히는 케이스 — 올라와야 해). Track
  // the panel box and fall back to single-pane mode whenever the floors do
  // not fit either axis.
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const panel = document.querySelector<HTMLElement>('.main-panel');
    if (!panel || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setPanelSize((current) => {
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        return current.width === width && current.height === height ? current : { width, height };
      });
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const treeMinimum = layout.type === 'split' ? paneNodeMinimumSize(layout) : null;
  const singlePaneMode =
    narrowShell ||
    (treeMinimum !== null &&
      panelSize.width > 0 &&
      panelSize.height > 0 &&
      (treeMinimum.width > panelSize.width || treeMinimum.height > panelSize.height));
  return singlePaneMode;
}
