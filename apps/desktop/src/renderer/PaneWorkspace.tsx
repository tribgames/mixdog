// The split-pane workspace surface. App mounts this once in place of the old
// single main pane: the FOCUSED leaf renders App's existing fully interactive
// surface (conversation / new-task / file editor) through renderActive, and
// every other session leaf streams live through PaneSessionView. Clicking a
// non-focused pane focuses it and asks App to navigate its interactive
// surface there, so today's single-focused-engine renderer keeps working
// while the lanes already deliver concurrent live output.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { t } from "./i18n";
import {
  dataTransferHasLocalFiles,
  droppedLocalPaths,
} from "./file-drag";
import { PaneSplitLayout } from "./PaneSplitLayout";
import { PersistentPanePortal } from "./PaneSurfaceGate";
import type { NavigationSelection, WorkspaceSelection } from "./nav-types";
import {
  paneHierarchyDropTarget,
  paneInnerDropZone,
  paneOuterDropZone,
  type PaneHierarchyCandidate,
} from "./pane-drop-zone";
import {
  canSplitPaneSize,
  movePaneTabToNodeEdge,
  paneActiveSelection,
  paneLeafRelativeRect,
  paneLeavesInVisualOrder,
  paneNodeMinimumSize,
  paneSessionTabIds,
  type PaneLeaf,
} from "./pane-layout";
import type { PaneDropZone, usePaneWorkspace } from "./pane-workspace-state";
import { defaultSessionLaneStore } from "./session-lane-store";
import { subscribeTabDrag } from "./tab-drag-bus";
import { navigationKey } from "./text-format";

const DROP_PREVIEW_LEAF_ID = "__pane_drop_preview__";

function paneConversationSlotId(leafId: string): string {
  return `pane-conversation-slot-${leafId}`;
}

function selectionLabel(selection: WorkspaceSelection | null): string {
  if (!selection) return t("Empty pane");
  switch (selection.kind) {
    case "new": return t("New task");
    case "project": return selection.path;
    case "session": return selection.id;
    case "file": return selection.rel.split("/").at(-1) || selection.rel;
    case "studio": return "Studio";
    case "terminal": return "Terminal";
    case "folder":
      return selection.path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || selection.path;
    case "pull-request": return selection.title || `Pull Request #${selection.number}`;
    case "diff": return `${selection.rel.split("/").at(-1) || selection.rel} (Diff)`;
  }
}


type DropPreview = {
  leafId: string;
  zone: PaneDropZone | "center" | "insert";
  rect: { left: number; top: number; width: number; height: number };
};

function sameDropPreview(left: DropPreview | null, right: DropPreview): boolean {
  return Boolean(left
    && left.leafId === right.leafId
    && left.zone === right.zone
    && left.rect.left === right.rect.left
    && left.rect.top === right.rect.top
    && left.rect.width === right.rect.width
    && left.rect.height === right.rect.height);
}

type TreeDropOperation = {
  kind: "tab" | "group";
  sourceLeafId: string;
  key: string;
  selection: WorkspaceSelection;
  targetPath: string;
  zone: PaneDropZone;
};

type ConversationOwner = {
  key: string;
  leafId: string;
  selectionKey: string;
  selection: Extract<NavigationSelection, { kind: "session" | "new" }>;
  handoff: boolean;
  parked: boolean;
};

type ConversationSurface = {
  leaf: PaneLeaf;
  selectionKey: string;
  active: Extract<NavigationSelection, { kind: "session" | "new" }>;
  handoff: boolean;
  parked: boolean;
};

type PaneSurfaceSnapshot = {
  key: string;
  leaf: PaneLeaf;
};

function paneSurfaceKey(leaf: PaneLeaf): string {
  const active = paneActiveSelection(leaf);
  if (!active) return "empty";
  if (active.kind === "session" || active.kind === "new") return "conversation";
  return navigationKey(active);
}

function retainSurfaceForOneFrame(leaf: PaneLeaf): boolean {
  const active = paneActiveSelection(leaf);
  return active?.kind === "session" || active?.kind === "new"
    || active?.kind === "file"
    || active?.kind === "studio" || active?.kind === "terminal"
    || active?.kind === "folder"
    || active?.kind === "diff" || active?.kind === "pull-request";
}

function parksConversationBehindSelection(selection: WorkspaceSelection | null): boolean {
  return selection?.kind === "file"
    || selection?.kind === "studio" || selection?.kind === "terminal"
    || selection?.kind === "folder"
    || selection?.kind === "diff" || selection?.kind === "pull-request";
}

function dropZoneStyle(preview: DropPreview): React.CSSProperties {
  const { left, top, width, height } = preview.rect;
  switch (preview.zone) {
    case "left": return { left, top, width: width / 2, height };
    case "right": return { left: left + width / 2, top, width: width / 2, height };
    case "top": return { left, top, width, height: height / 2 };
    case "bottom": return { left, top: top + height / 2, width, height: height / 2 };
  // Center merge highlights the whole target group.
    case "center": return { left, top, width, height };
    // Strip insertion caret: the rect IS the bar (VS Code tabs drop index).
    case "insert": return { left, top, width, height };
  }
}

function orientVerticalDropZone(
  zone: PaneDropZone | "center",
  deltaX: number | undefined,
  deltaY: number | undefined,
): PaneDropZone | "center" {
  if ((zone !== "top" && zone !== "bottom") || !deltaY) return zone;
  if (Math.abs(deltaY) <= Math.abs(deltaX ?? 0)) return zone;
  return deltaY > 0 ? "bottom" : "top";
}

export function PaneWorkspace({
  workspace,
  observedSessionIds = [],
  renderActive,
  renderStrip,
  renderConversation,
  renderFileEditors,
  renderUtilityTabs,
  onFocusSelection,
  onOpenDroppedPaths,
}: {
  workspace: ReturnType<typeof usePaneWorkspace>;
  /** Additional live lanes required by non-editor surfaces such as Agents. */
  observedSessionIds?: readonly string[];
  /** App's non-chat surface for an empty/project/file focused leaf. */
  renderActive: (leaf: PaneLeaf) => React.ReactNode;
  /** Per-group tab strip. */
  renderStrip?: (leaf: PaneLeaf) => React.ReactNode;
  /** One permanently mounted chat surface per session/draft pane. Focus is a
   *  prop change only. */
  renderConversation?: (
    selection: NavigationSelection,
    focused: boolean,
    focusPane: () => void,
    leafId: string,
  ) => React.ReactNode;
  /** File editors stay mounted in their owning group while dirty. The active
   *  file renders in-place even when another pane has focus. */
  renderFileEditors?: (
    leaf: PaneLeaf,
    focused: boolean,
    focusPane: () => void,
  ) => React.ReactNode;
  /** Studio and terminal tabs stay mounted per group so their prompt,
   * gallery, terminal buffer, and PTY identity survive tab switches. */
  renderUtilityTabs?: (
    leaf: PaneLeaf,
    focused: boolean,
    focusPane: () => void,
  ) => React.ReactNode;
  /** Navigate App's interactive surface when another pane takes focus. */
  onFocusSelection: (selection: WorkspaceSelection) => void;
  /** Opens native/internal file drops in the pane they were dropped onto. */
  onOpenDroppedPaths?: (leafId: string, paths: string[]) => void | Promise<void>;
}): React.JSX.Element {
  const [fileDropLeafId, setFileDropLeafId] = useState("");
  useEffect(() => {
    const clear = () => setFileDropLeafId("");
    window.addEventListener("drop", clear, true);
    window.addEventListener("dragend", clear, true);
    return () => {
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("dragend", clear, true);
    };
  }, []);
  // Subscribe before the browser can paint the restored pane tree. main.tsx
  // starts this even earlier on a normal boot; this layout effect preserves
  // the same contract for tests, remote shells, and hot remounts.
  useLayoutEffect(() => defaultSessionLaneStore.start(), []);
  const paneSessionIds = paneSessionTabIds(workspace.leaves, workspace.focusedLeafId);
  // The Agents surface observes working background sessions even when none of
  // them owns an editor tab, so include those ids with every pane session.
  const visibleSessionIds = [...new Set([...observedSessionIds, ...paneSessionIds])];
  const visibleSessionKey = visibleSessionIds.join("\0");
  useLayoutEffect(() => {
    const setVisibleSessions = window.mixdogDesktop?.setVisibleSessions;
    if (typeof setVisibleSessions !== "function") return;
    let cancelled = false;
    let retryTimer = 0;
    let attempt = 0;
    const register = async (): Promise<void> => {
      let accepted = false;
      try {
        accepted = await setVisibleSessions(visibleSessionIds) === true;
      } catch {
        accepted = false;
      }
      if (cancelled || accepted) return;
      const delay = Math.min(1_000, 80 * (2 ** Math.min(attempt, 4)));
      attempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        void register();
      }, delay);
    };
    void register();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [visibleSessionKey]);
  useEffect(() => () => {
    const setVisibleSessions = window.mixdogDesktop?.setVisibleSessions;
    if (typeof setVisibleSessions === "function") {
      void setVisibleSessions([]).catch(() => undefined);
    }
  }, []);
  // Selection is ONE document-wide range, so a drag that starts in one pane
  // and travels over another painted every row in between (user: 왜 드래그가
  // 패널별로 분리 안 되어 있어). Mark the pane the gesture began in; CSS
  // suspends selection in every OTHER pane until the pointer is released, so
  // each pane reads as its own document the way editor groups do.
  useEffect(() => {
    const root = document.documentElement;
    const release = (): void => {
      document.querySelector<HTMLElement>(".pane-leaf[data-selecting]")
        ?.removeAttribute("data-selecting");
      delete root.dataset.paneSelecting;
    };
    const onPointerDown = (event: PointerEvent): void => {
      // Only a primary-button drag selects text; keep right-click menus and
      // middle-click paste out of it.
      if (event.button !== 0) return;
      release();
      const target = event.target instanceof Element ? event.target : null;
      const leaf = target?.closest<HTMLElement>(".pane-leaf");
      // A single-pane workspace has no .pane-leaf wrapper and needs no fence.
      if (!leaf) return;
      leaf.dataset.selecting = "true";
      root.dataset.paneSelecting = "true";
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      release();
    };
  }, []);
  // Drag-to-split (VS Code/orca): the titlebar strip publishes pointer frames
  // once a tab drag leaves the strip band; hit-test the pane under the
  // pointer, preview the edge zone, and split on drop. Refs keep the single
  // subscription stable across renders.
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const treeDropOperation = useRef<TreeDropOperation | null>(null);
  const conversationOwnerSequence = useRef(0);
  const conversationOwners = useRef<ConversationOwner[]>([]);
  const previousPaneSurfaces = useRef(new Map<string, PaneSurfaceSnapshot>());
  const paneSurfaceHandoffs = useRef(new Map<string, PaneSurfaceSnapshot>());
  const [, setSurfaceHandoffRevision] = useState(0);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const focusSelectionRef = useRef(onFocusSelection);
  focusSelectionRef.current = onFocusSelection;
  useEffect(() => subscribeTabDrag((frame) => {
    if (frame.phase === "cancel") {
      treeDropOperation.current = null;
      setDropPreview(null);
      return;
    }
    const current = workspaceRef.current;
    const groupDrag = frame.kind === "group";
    const sessionDrag = frame.kind === "session";
    const dragKind: TreeDropOperation["kind"] = groupDrag ? "group" : "tab";
    const sourceLeafId = sessionDrag
      ? current.leaves.find((leaf) =>
        leaf.tabs.some((tab) => navigationKey(tab) === frame.key))?.id ?? ""
      : frame.sourceLeafId || "";
    const commitTreeDrop = (operation: TreeDropOperation) => {
      if (operation.kind === "group") {
        current.moveGroupToNodeEdge(
          operation.sourceLeafId, operation.targetPath, operation.zone);
      } else {
        current.moveTabToNodeEdge(
          operation.sourceLeafId, operation.key, operation.targetPath, operation.zone);
      }
      focusSelectionRef.current(operation.selection);
    };
    const pendingTreeDrop = treeDropOperation.current;
    if (frame.phase === "drop" && pendingTreeDrop
      && pendingTreeDrop.kind === dragKind
      && pendingTreeDrop.sourceLeafId === sourceLeafId
      && (groupDrag || pendingTreeDrop.key === frame.key)) {
      treeDropOperation.current = null;
      setDropPreview(null);
      commitTreeDrop(pendingTreeDrop);
      return;
    }
    const pointedElement = document.elementFromPoint?.(frame.x, frame.y) ?? null;
    const panelRect = document.querySelector(".main-panel")?.getBoundingClientRect() ?? null;
    const sourceLeaf = current.leaves.find((leaf) => leaf.id === sourceLeafId);
    const sourceOwnsTab = sourceLeaf?.tabs.some((tab) => navigationKey(tab) === frame.key) === true;
    const canDetachAtRoot = groupDrag
      ? current.leaves.length > 1
      : sourceOwnsTab && (current.leaves.length > 1 || (sourceLeaf?.tabs.length ?? 0) > 1);
    const pointedStrip = pointedElement?.closest?.(".workspace-tabs-shell") ?? null;
    const outerZone = sourceLeafId && panelRect
      ? paneOuterDropZone(panelRect, frame.x, frame.y)
      : null;
    const panelElement = document.querySelector<HTMLElement>(".main-panel");
    const candidates: PaneHierarchyCandidate[] = panelElement
      ? [...panelElement.querySelectorAll<HTMLElement>("[data-pane-path]")]
        .map((element) => ({
          path: element.dataset.panePath ?? "",
          rect: element.getBoundingClientRect(),
        }))
      : [];
    if (panelRect && !candidates.some((candidate) =>
      candidate.path === "" && candidate.rect.width > 0 && candidate.rect.height > 0)) {
      candidates.push({ path: "", rect: panelRect });
    }
    const hierarchyTarget = canDetachAtRoot && outerZone && panelRect
      ? paneHierarchyDropTarget(
        panelRect, outerZone, frame.x, frame.y, candidates)
      : null;
    if (outerZone && hierarchyTarget && panelRect) {
      const direction = outerZone === "left" || outerZone === "right"
        ? "row" : "column";
      if (canSplitPaneSize(
        direction,
        hierarchyTarget.rect.width,
        hierarchyTarget.rect.height,
      )) {
        const operation: TreeDropOperation = {
          kind: dragKind,
          sourceLeafId,
          key: frame.key,
          selection: frame.selection,
          targetPath: hierarchyTarget.path,
          zone: outerZone,
        };
        if (frame.phase === "move") {
          treeDropOperation.current = operation;
          const addsPane = !groupDrag && (sourceLeaf?.tabs.length ?? 0) > 1;
          const position = outerZone === "left" || outerZone === "top" ? "before" : "after";
          const previewLayout = addsPane
            ? movePaneTabToNodeEdge(
              current.layout,
              sourceLeafId,
              frame.key,
              hierarchyTarget.path,
              direction,
              position,
              DROP_PREVIEW_LEAF_ID,
            )
            : null;
          const relativeRect = previewLayout
            ? paneLeafRelativeRect(previewLayout, DROP_PREVIEW_LEAF_ID)
            : null;
          const nextPreview: DropPreview = relativeRect
            ? {
              leafId: sourceLeafId,
              zone: "center",
              rect: {
                left: panelRect.left + relativeRect.left * panelRect.width,
                top: panelRect.top + relativeRect.top * panelRect.height,
                width: relativeRect.width * panelRect.width,
                height: relativeRect.height * panelRect.height,
              },
            }
            : {
              leafId: sourceLeafId,
              zone: outerZone,
              rect: {
                left: hierarchyTarget.rect.left,
                top: hierarchyTarget.rect.top,
                width: hierarchyTarget.rect.width,
                height: hierarchyTarget.rect.height,
              },
            };
          setDropPreview((currentPreview) =>
            sameDropPreview(currentPreview, nextPreview) ? currentPreview : nextPreview);
        } else {
          treeDropOperation.current = null;
          setDropPreview(null);
          commitTreeDrop(operation);
        }
        return;
      }
    }
    treeDropOperation.current = null;
    let leafId = "";
    let rect: DOMRect | null = null;
    let paneScope: HTMLElement | null = null;
    const paneNode = pointedElement?.closest?.(".pane-leaf") as HTMLElement | null;
    if (paneNode?.dataset.paneId) {
      leafId = paneNode.dataset.paneId;
      rect = paneNode.getBoundingClientRect();
      paneScope = paneNode;
    } else {
      // A single-pane workspace has no .pane-leaf wrapper; the whole main
      // panel is its drop surface.
      if (panelRect && frame.x >= panelRect.left && frame.x <= panelRect.right
        && frame.y >= panelRect.top && frame.y <= panelRect.bottom) {
        leafId = current.leaves[0]?.id ?? "";
        rect = panelRect;
        paneScope = panelElement;
      }
    }
    const target = leafId ? current.leaves.find((leaf) => leaf.id === leafId) : undefined;
    if (!target || !rect) {
      setDropPreview(null);
      return;
    }
    // A drop that cannot move anything draws no overlay at
    // all — a group over its own pane, or a single-tab group over itself
    // (editorDropTarget hides the overlay for both instead of previewing a
    // silent no-op).
    if (sourceLeafId === leafId
      && (groupDrag || (sourceOwnsTab && (sourceLeaf?.tabs.length ?? 0) < 2))) {
      setDropPreview(null);
      return;
    }
    // VS Code drops target the editor area BELOW the tab row
    // (getOverlayOffsetHeight): both the zone bands and the preview overlay
    // exclude the strip so top-split geometry is not skewed by it.
    const stripRect = paneScope
      ?.querySelector(".workspace-tabs-shell")?.getBoundingClientRect() ?? null;
    const editorTop = stripRect && stripRect.height > 0
      && stripRect.top <= rect.top + 1 && stripRect.bottom < rect.bottom
      ? stripRect.bottom
      : rect.top;
    const dropRect = {
      left: rect.left,
      top: editorTop,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.bottom - editorTop,
    };
    const overStrip = Boolean(pointedStrip);
    let zone: PaneDropZone | "center" = overStrip
      ? "center"
      : paneInnerDropZone(dropRect, frame.x, frame.y, groupDrag);
    // A pointer crossing into a foreign pane can geometrically enter its
    // opposite edge (downward motion enters the next pane's top band). Keep
    // the preview on the side the pointer is actually travelling toward.
    if (!sessionDrag && sourceLeafId && sourceLeafId !== leafId) {
      zone = orientVerticalDropZone(zone, frame.deltaX, frame.deltaY);
    }
    if (zone !== "center") {
      const direction = zone === "left" || zone === "right" ? "row" : "column";
      if (!canSplitPaneSize(direction, dropRect.width, dropRect.height)) {
        zone = "center";
      }
    }
    const targetActive = paneActiveSelection(target);
    if (zone === "center") {
      // Merging needs a foreign source group; a same-group or sourceless
      // center drop has nothing to move.
      if ((!sessionDrag && (!sourceLeafId || sourceLeafId === leafId))
        || (sessionDrag && sourceLeafId === leafId && !overStrip)) {
        setDropPreview(null);
        return;
      }
    } else if (!groupDrag && sourceLeafId !== leafId && targetActive
      && navigationKey(targetActive) === navigationKey(frame.selection)) {
      // An edge drop beside a pane that already shows the view is a no-op;
      // splitting a group with its OWN tab stays allowed (VS Code).
      setDropPreview(null);
      return;
    }
    // Foreign-strip hover inserts at the pointed tab position (VS Code
    // tabs-container drop): the feedback is an insertion caret in the strip,
    // not the editor-area merge wash, and the drop lands at that index.
    let insertIndex: number | undefined;
    let insertBar: DropPreview["rect"] | null = null;
    if (overStrip && pointedStrip && zone === "center" && sourceLeafId !== leafId) {
      const stripRect2 = pointedStrip.getBoundingClientRect();
      const stripTabs = [...pointedStrip.querySelectorAll<HTMLElement>(".workspace-tab")];
      insertIndex = stripTabs.length;
      let barX = stripTabs.length
        ? stripTabs[stripTabs.length - 1].getBoundingClientRect().right
        : stripRect2.left + 6;
      for (let at = 0; at < stripTabs.length; at += 1) {
        const tabRect = stripTabs[at].getBoundingClientRect();
        if (frame.x < tabRect.left + tabRect.width / 2) {
          insertIndex = at;
          barX = tabRect.left;
          break;
        }
      }
      if (stripRect2.width > 0 && stripRect2.height > 0) {
        insertBar = {
          left: barX - 1,
          top: stripRect2.top + 4,
          width: 2,
          height: Math.max(0, stripRect2.height - 8),
        };
      }
    }
    if (frame.phase === "move") {
      const nextPreview: DropPreview = insertBar
        ? { leafId, zone: "insert", rect: insertBar }
        : {
          leafId,
          zone,
          rect: {
            left: dropRect.left,
            top: dropRect.top,
            width: dropRect.width,
            height: dropRect.height,
          },
        };
      setDropPreview((currentPreview) =>
        sameDropPreview(currentPreview, nextPreview) ? currentPreview : nextPreview);
      return;
    }
    setDropPreview(null);
    if (groupDrag) {
      if (zone !== "center") current.moveGroupAt(sourceLeafId, leafId, zone);
      // Keep the classic 2-arg call for plain center merges: the optional
      // strip index only rides along when a strip drop actually produced one.
      else if (insertIndex === undefined) current.mergeGroup(sourceLeafId, leafId);
      else current.mergeGroup(sourceLeafId, leafId, insertIndex);
    } else if (sessionDrag && zone === "center") {
      current.openInLeaf(leafId, frame.selection, insertIndex);
    } else if (zone === "center" && insertIndex !== undefined) {
      current.moveTab(sourceLeafId, frame.key, leafId, insertIndex);
    } else if (zone === "center") {
      current.moveTab(sourceLeafId, frame.key, leafId);
    } else {
      current.splitLeafAt(leafId, zone, frame.selection, sourceLeafId);
    }
    // The dropped view owns the new focused pane; App navigates its
    // interactive surface there (resume for sessions, editor for files).
    focusSelectionRef.current(frame.selection);
  }), []);
  // Narrow shell (≤760px, phone composition): the split grid cannot hold two
  // panes above their floors, so the tree renders as ONE full-size pane at a
  // time — single-session mode (user decision) — and the strip-row pager
  // steps left/right through the panes in visual order.
  const [narrowShell, setNarrowShell] = useState(
    () => window.matchMedia?.("(max-width: 760px)").matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 760px)");
    if (!query) return undefined;
    const onChange = (): void => setNarrowShell(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  // The band check alone is not enough: on a mid-width window the panel can
  // shrink under the TREE's aggregate floors (side panels open, column
  // splits taller than the window) and the overflow buried panes past the
  // right or BOTTOM edge (user: 하단이 묻히는 케이스 — 올라와야 해). Track
  // the panel box and fall back to single-pane mode whenever the floors do
  // not fit either axis.
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const panel = document.querySelector<HTMLElement>(".main-panel");
    if (!panel || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setPanelSize((current) => {
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        return current.width === width && current.height === height
          ? current : { width, height };
      });
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const treeMinimum = workspace.layout.type === "split"
    ? paneNodeMinimumSize(workspace.layout)
    : null;
  const singlePaneMode = narrowShell || (treeMinimum !== null
    && panelSize.width > 0 && panelSize.height > 0
    && (treeMinimum.width > panelSize.width || treeMinimum.height > panelSize.height));
  const overlay = dropPreview
    ? createPortal(
      // VS Code creates one DropOverlay per editor group: the highlight
      // glides between zones INSIDE a pane but never slides across panes —
      // the key remounts the element when the pane (or surface kind)
      // changes, so only intra-pane moves animate.
      <div
        key={`${dropPreview.leafId}:${dropPreview.zone === "insert" ? "strip" : "area"}`}
        className={dropPreview.zone === "insert"
          ? "pane-drop-overlay pane-drop-insert"
          : "pane-drop-overlay"}
        style={dropZoneStyle(dropPreview)} />,
      document.body,
    )
    : null;
  const { focusedLeafId } = workspace;
  const fileDropPropsFor = (leafId: string) => (
    !onOpenDroppedPaths ? {} : {
      "data-file-dropping": fileDropLeafId === leafId ? "true" : undefined,
      onDragEnter: (event: React.DragEvent<HTMLDivElement>) => {
        if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
        event.preventDefault();
        setFileDropLeafId(leafId);
      },
      onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
        if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setFileDropLeafId(leafId);
      },
      onDragLeave: (event: React.DragEvent<HTMLDivElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setFileDropLeafId((current) => current === leafId ? "" : current);
      },
      onDrop: (event: React.DragEvent<HTMLDivElement>) => {
        if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
        const paths = droppedLocalPaths(event.dataTransfer);
        if (!paths.length) return;
        event.preventDefault();
        event.stopPropagation();
        setFileDropLeafId("");
        void onOpenDroppedPaths(leafId, paths);
      },
    }
  );
  const multi = workspace.leaves.length > 1;
  const currentPaneSurfaces = new Map<string, PaneSurfaceSnapshot>();
  const liveLeafIds = new Set(workspace.leaves.map((leaf) => leaf.id));
  for (const leaf of workspace.leaves) {
    const current = { key: paneSurfaceKey(leaf), leaf };
    const previous = previousPaneSurfaces.current.get(leaf.id);
    currentPaneSurfaces.set(leaf.id, current);
    if (previous && previous.key !== current.key && retainSurfaceForOneFrame(previous.leaf)) {
      paneSurfaceHandoffs.current.set(leaf.id, previous);
    } else if (paneSurfaceHandoffs.current.get(leaf.id)?.key === current.key) {
      paneSurfaceHandoffs.current.delete(leaf.id);
    }
  }
  for (const leafId of paneSurfaceHandoffs.current.keys()) {
    if (!liveLeafIds.has(leafId)) paneSurfaceHandoffs.current.delete(leafId);
  }
  previousPaneSurfaces.current = currentPaneSurfaces;
  const paneSurfaceHandoffKey = [...paneSurfaceHandoffs.current]
    .map(([leafId, surface]) => `${leafId}\0${surface.key}`)
    .join("\x01");
  useLayoutEffect(() => {
    if (!paneSurfaceHandoffKey) return undefined;
    const retiring = new Map(paneSurfaceHandoffs.current);
    const frame = window.requestAnimationFrame(() => {
      let changed = false;
      for (const [leafId, surface] of retiring) {
        if (paneSurfaceHandoffs.current.get(leafId)?.key !== surface.key) continue;
        paneSurfaceHandoffs.current.delete(leafId);
        changed = true;
      }
      if (changed) setSurfaceHandoffRevision((value) => value + 1);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [paneSurfaceHandoffKey]);
  // Conversation owns scroll, virtualizer, parsed Markdown and composer state.
  // Keep one stable owner per visible pane instead of keying it by the active
  // session. When an active tab/group moves to another leaf, match its prior
  // selection first so the same owner follows the move; ordinary tab switches
  // then fall back to the existing leaf owner and never remount Conversation.
  const conversationLeaves: ConversationSurface[] = workspace.restorePending
    ? []
    : workspace.leaves.flatMap((leaf) => {
      const active = paneActiveSelection(leaf);
      return active?.kind === "session" || active?.kind === "new"
        ? [{
          leaf,
          active,
          selectionKey: navigationKey(active),
          handoff: false,
          parked: false,
        }]
        : [];
    }).concat([...paneSurfaceHandoffs.current.values()].flatMap((surface) => {
      const active = paneActiveSelection(surface.leaf);
      return active?.kind === "session" || active?.kind === "new"
        ? [{
          leaf: surface.leaf,
          active,
          selectionKey: navigationKey(active),
          handoff: true,
          parked: false,
        }]
        : [];
    }));
  const previousConversationOwners = conversationOwners.current;
  const representedConversationLeaves = new Set(
    conversationLeaves.map((entry) => entry.leaf.id),
  );
  for (const owner of previousConversationOwners) {
    if (representedConversationLeaves.has(owner.leafId)) continue;
    const leaf = workspace.leaves.find((candidate) =>
      !representedConversationLeaves.has(candidate.id)
      && parksConversationBehindSelection(paneActiveSelection(candidate))
      && candidate.tabs.some((selection) => navigationKey(selection) === owner.selectionKey));
    if (!leaf) continue;
    const selection = leaf.tabs.find((candidate) =>
      navigationKey(candidate) === owner.selectionKey);
    if (selection?.kind !== "session" && selection?.kind !== "new") continue;
    conversationLeaves.push({
      leaf,
      active: selection,
      selectionKey: owner.selectionKey,
      handoff: false,
      parked: true,
    });
    representedConversationLeaves.add(leaf.id);
  }
  const ownerByLeaf = new Map<string, string>();
  const usedOwnerKeys = new Set<string>();
  for (const entry of conversationLeaves) {
    const movedOwner = previousConversationOwners.find((owner) =>
      owner.selectionKey === entry.selectionKey && !usedOwnerKeys.has(owner.key));
    if (!movedOwner) continue;
    ownerByLeaf.set(entry.leaf.id, movedOwner.key);
    usedOwnerKeys.add(movedOwner.key);
  }
  for (const entry of conversationLeaves) {
    if (ownerByLeaf.has(entry.leaf.id)) continue;
    const paneOwner = previousConversationOwners.find((owner) =>
      owner.leafId === entry.leaf.id && !usedOwnerKeys.has(owner.key));
    const ownerKey = paneOwner?.key
      ?? `pane-conversation-owner-${++conversationOwnerSequence.current}`;
    ownerByLeaf.set(entry.leaf.id, ownerKey);
    usedOwnerKeys.add(ownerKey);
  }
  conversationOwners.current = conversationLeaves.map((entry) => ({
    key: ownerByLeaf.get(entry.leaf.id)!,
    leafId: entry.leaf.id,
    selectionKey: entry.selectionKey,
    selection: entry.active,
    handoff: entry.handoff,
    parked: entry.parked,
  }));
  const conversationPortals = renderConversation
    ? conversationLeaves.map(({ leaf, active, handoff, parked }) => {
      const focused = leaf.id === focusedLeafId;
      const focusPane = (): void => {
        workspace.focusLeaf(leaf.id);
        onFocusSelection(active);
      };
      return <PersistentPanePortal key={ownerByLeaf.get(leaf.id)}
        targetId={paneConversationSlotId(leaf.id)}
        className={`conversation-persistent-surface${handoff ? " is-handoff" : ""}`}>
        {renderConversation(active, focused && !handoff && !parked, focusPane, leaf.id)}
      </PersistentPanePortal>;
    })
    : [];
  const conversationEntryByLeaf = new Map(
    conversationLeaves.map((entry) => [entry.leaf.id, entry]),
  );
  const conversationSlot = (leafId: string, parked: boolean) =>
    <div id={paneConversationSlotId(leafId)}
      className="pane-conversation-slot"
      data-conversation-parked={parked ? "true" : undefined}
      inert={parked ? true : undefined}
      aria-hidden={parked ? true : undefined} />;
  // Chat owns one fixed pane-sized paint layer. When Studio/file/terminal is
  // active it remains laid out and painted underneath the opaque utility
  // layer, so Chromium and TanStack never discard or recompute its geometry.
  const visualSurfaceHandoffFor = (leafId: string) => {
    const handoff = paneSurfaceHandoffs.current.get(leafId);
    const active = handoff ? paneActiveSelection(handoff.leaf) : null;
    return active?.kind === "session" || active?.kind === "new"
      ? undefined
      : handoff;
  };
  const surfaceLayersFor = (leaf: PaneLeaf) => {
    const current = currentPaneSurfaces.get(leaf.id)!;
    const handoff = visualSurfaceHandoffFor(leaf.id);
    return handoff && handoff.key !== current.key
      ? [{ ...handoff, handoff: true }, { ...current, handoff: false }]
      : [{ ...current, handoff: false }];
  };
  const renderPaneSurface = (
    surfaceLeaf: PaneLeaf,
    focused: boolean,
    handoff: boolean,
  ) => {
    if (workspace.restorePending) {
      return <div className="pane-placeholder" data-restoring="true" role="status">
        <span className="pane-placeholder-title">{t("Restoring layout…")}</span>
      </div>;
    }
    const active = paneActiveSelection(surfaceLeaf);
    const interactive = focused && !handoff;
    const focusPane = (): void => {
      if (handoff) return;
      workspace.focusLeaf(surfaceLeaf.id);
      if (active) onFocusSelection(active);
    };
    const fileEditors = renderFileEditors?.(surfaceLeaf, interactive, focusPane);
    // Utility portals already stay mounted after first activation. During a
    // handoff their one physical slot stays in the outgoing layer for exactly
    // one frame; the incoming layer receives it after that layer retires.
    // This avoids duplicate ids while preserving the last composed utility
    // frame instead of exposing an empty/rasterizing destination.
    const activeHandoff = visualSurfaceHandoffFor(surfaceLeaf.id);
    const utilityTabs = handoff || !activeHandoff
      ? renderUtilityTabs?.(surfaceLeaf, interactive, focusPane)
      : null;
    if (active?.kind === "session" || active?.kind === "new") {
      return <>
        {fileEditors}
        {utilityTabs}
      </>;
    }
    if (active?.kind === "file" && renderFileEditors) {
      return <>
        {fileEditors}
        {utilityTabs}
      </>;
    }
    if (active?.kind === "studio" || active?.kind === "terminal"
      || active?.kind === "folder"
      || active?.kind === "diff" || active?.kind === "pull-request") {
      return <>
        {fileEditors}
        {utilityTabs}
      </>;
    }
    if (interactive) {
      return <>
        {fileEditors}
        {utilityTabs}
        {renderActive(surfaceLeaf)}
      </>;
    }
    return <>
      {fileEditors}
      {utilityTabs}
      {!handoff && <button type="button" className="pane-placeholder" onClick={focusPane}>
        <span className="pane-placeholder-title">{selectionLabel(active)}</span>
        <span className="pane-placeholder-hint">{t("Click to work in this pane")}</span>
      </button>}
    </>;
  };
  const renderPaneSurfaceStack = (leaf: PaneLeaf, focused: boolean) => {
    const conversationEntry = conversationEntryByLeaf.get(leaf.id);
    return <div className="pane-surface-stack">
      {surfaceLayersFor(leaf).map((surface) =>
        <div key={surface.key}
          className="pane-surface-handoff-layer"
          data-pane-surface-handoff={surface.handoff ? "true" : "false"}
          inert={surface.handoff ? true : undefined}
          aria-hidden={surface.handoff ? true : undefined}>
          {renderPaneSurface(surface.leaf, focused, surface.handoff)}
        </div>)}
      {conversationEntry && conversationSlot(leaf.id, conversationEntry.parked)}
    </div>;
  };
  if (workspace.layout.type === "leaf") {
    const leaf = workspace.layout;
    // A single pane still owns its tab strip (VS Code single editor group);
    // the cell stacks the strip above the classic interactive markup.
    return (<>
      <div className="pane-cell is-focused" data-pane-id={leaf.id}
        {...fileDropPropsFor(leaf.id)}>
        {renderStrip?.(leaf)}
        {renderPaneSurfaceStack(leaf, true)}
        {overlay}
      </div>
      {conversationPortals}
    </>);
  }
  if (singlePaneMode) {
    const ordered = paneLeavesInVisualOrder(workspace.layout);
    const activeIndex = Math.max(0, ordered.findIndex((leaf) => leaf.id === focusedLeafId));
    return (<>
      <div className="pane-carousel">
        {ordered.map((leaf, index) => {
          const focused = index === activeIndex;
          return (
            <div key={leaf.id}
              className={`pane-cell pane-carousel-item${focused ? " is-focused has-siblings" : ""}`}
              data-pane-id={leaf.id}
              {...fileDropPropsFor(leaf.id)}
              data-carousel-active={focused ? "true" : "false"}
              inert={focused ? undefined : true}
              aria-hidden={focused ? undefined : true}>
              {renderStrip?.(leaf)}
              {renderPaneSurfaceStack(leaf, focused)}
            </div>
          );
        })}
      </div>
      {conversationPortals}
      {overlay}
    </>);
  }
  return (
    <>
    <PaneSplitLayout
      node={workspace.layout}
      onRatioChange={workspace.setRatio}
      renderLeaf={(leaf) => {
        const focused = leaf.id === focusedLeafId;
        return (
          <div className={`pane-cell${focused ? ` is-focused${multi ? " has-siblings" : ""}` : ""}`}
            {...fileDropPropsFor(leaf.id)}>
            {renderStrip?.(leaf)}
            {renderPaneSurfaceStack(leaf, focused)}
          </div>
        );
      }}
    />
    {conversationPortals}
    {overlay}
    </>
  );
}
