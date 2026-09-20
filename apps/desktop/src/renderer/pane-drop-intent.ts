// Pane drag-and-drop intent: where a dragged surface lands and how the
// workspace model changes when it is dropped.
import type { WorkspaceSelection } from './nav-types';
import {
  paneHierarchyDropTarget,
  paneInnerDropZone,
  paneOuterDropZone,
  type PaneHierarchyCandidate,
} from './pane-drop-zone';
import { canSplitPaneSize, movePaneTabToNodeEdge, paneActiveSelection, paneLeafRelativeRect } from './pane-layout';
import type { PaneDropZone, usePaneWorkspace } from './pane-workspace-state';
import type { PaneDragFrame } from './pane-drag-session';
import { navigationKey } from './text-format';

const DROP_PREVIEW_LEAF_ID = '__pane_drop_preview__';

export type DropPreview = {
  leafId: string;
  zone: PaneDropZone | 'center' | 'insert';
  rect: { left: number; top: number; width: number; height: number };
};

export function sameDropPreview(left: DropPreview | null, right: DropPreview): boolean {
  return Boolean(
    left &&
      left.leafId === right.leafId &&
      left.zone === right.zone &&
      left.rect.left === right.rect.left &&
      left.rect.top === right.rect.top &&
      left.rect.width === right.rect.width &&
      left.rect.height === right.rect.height
  );
}

type PaneWorkspaceModel = ReturnType<typeof usePaneWorkspace>;

type PaneDropAction =
  | {
      type: 'move-group-to-node-edge';
      sourceLeafId: string;
      targetPath: string;
      zone: PaneDropZone;
    }
  | {
      type: 'move-tab-to-node-edge';
      sourceLeafId: string;
      key: string;
      targetPath: string;
      zone: PaneDropZone;
    }
  | {
      type: 'move-group';
      sourceLeafId: string;
      targetLeafId: string;
      zone: PaneDropZone;
    }
  | {
      type: 'merge-group';
      sourceLeafId: string;
      targetLeafId: string;
      insertIndex?: number;
    }
  | {
      type: 'open-in-leaf';
      targetLeafId: string;
      selection: WorkspaceSelection;
      insertIndex?: number;
    }
  | {
      type: 'move-tab';
      sourceLeafId: string;
      key: string;
      targetLeafId: string;
      insertIndex?: number;
    }
  | {
      type: 'split-leaf';
      targetLeafId: string;
      zone: PaneDropZone;
      selection: WorkspaceSelection;
      sourceLeafId: string;
    };

type PaneDropIntent = {
  preview: DropPreview;
  action: PaneDropAction;
  selection: WorkspaceSelection;
};

type PaneLeafModel = PaneWorkspaceModel['leaves'][number];

// A drop on a workspace edge band: the dragged tab (or group) becomes a new
// pane beside the hierarchy node under the band.
type RectBox = { left: number; top: number; width: number; height: number };

function rectBox({ left, top, width, height }: RectBox): RectBox {
  return { left, top, width, height };
}

// A layout-relative (0..1) rectangle placed inside the panel.
function scaledRect(relative: RectBox, panelRect: DOMRect): RectBox {
  return {
    left: panelRect.left + relative.left * panelRect.width,
    top: panelRect.top + relative.top * panelRect.height,
    width: relative.width * panelRect.width,
    height: relative.height * panelRect.height,
  };
}

function paneHierarchyCandidates(panelElement: HTMLElement, panelRect: DOMRect): PaneHierarchyCandidate[] {
  const candidates: PaneHierarchyCandidate[] = [...panelElement.querySelectorAll<HTMLElement>('[data-pane-path]')].map(
    (element) => ({
      path: element.dataset.panePath ?? '',
      rect: element.getBoundingClientRect(),
    })
  );
  if (!candidates.some((candidate) => candidate.path === '' && candidate.rect.width > 0 && candidate.rect.height > 0)) {
    candidates.push({ path: '', rect: panelRect });
  }
  return candidates;
}

// The leaf's drop rectangle excludes its own tab strip when that strip sits
// at the top of the leaf.
function leafDropRect(rect: DOMRect, paneScope: Element | null | undefined) {
  const stripRect = paneScope?.querySelector('.workspace-tabs-shell')?.getBoundingClientRect() ?? null;
  const editorTop =
    stripRect && stripRect.height > 0 && stripRect.top <= rect.top + 1 && stripRect.bottom < rect.bottom
      ? stripRect.bottom
      : rect.top;
  return {
    left: rect.left,
    top: editorTop,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.bottom - editorTop,
  };
}

function hierarchyDropIntent(input: {
  frame: PaneDragFrame;
  current: PaneWorkspaceModel;
  panelRect: DOMRect;
  outerZone: NonNullable<ReturnType<typeof paneOuterDropZone>>;
  direction: 'row' | 'column';
  hierarchyTarget: NonNullable<ReturnType<typeof paneHierarchyDropTarget>>;
  sourceLeafId: string;
  sourceLeaf: PaneLeafModel | undefined;
  groupDrag: boolean;
}): PaneDropIntent {
  const { frame, current, panelRect, outerZone, direction, hierarchyTarget, sourceLeafId, sourceLeaf, groupDrag } =
    input;
  const addsPane = !groupDrag && (sourceLeaf?.tabs.length ?? 0) > 1;
  const position = outerZone === 'left' || outerZone === 'top' ? 'before' : 'after';
  const previewLayout = addsPane
    ? movePaneTabToNodeEdge(
        current.layout,
        sourceLeafId,
        frame.key,
        hierarchyTarget.path,
        direction,
        position,
        DROP_PREVIEW_LEAF_ID
      )
    : null;
  const relativeRect = previewLayout ? paneLeafRelativeRect(previewLayout, DROP_PREVIEW_LEAF_ID) : null;
  const preview: DropPreview = relativeRect
    ? { leafId: sourceLeafId, zone: 'center', rect: scaledRect(relativeRect, panelRect) }
    : { leafId: sourceLeafId, zone: outerZone, rect: rectBox(hierarchyTarget.rect) };
  return {
    preview,
    selection: frame.selection,
    action: groupDrag
      ? {
          type: 'move-group-to-node-edge',
          sourceLeafId,
          targetPath: hierarchyTarget.path,
          zone: outerZone,
        }
      : {
          type: 'move-tab-to-node-edge',
          sourceLeafId,
          key: frame.key,
          targetPath: hierarchyTarget.path,
          zone: outerZone,
        },
  };
}

// The leaf under the pointer: its .pane-leaf wrapper, or the whole panel in
// a single-pane workspace (which has no wrapper).
function pointedLeaf(
  frame: PaneDragFrame,
  current: PaneWorkspaceModel,
  panelElement: HTMLElement,
  panelRect: DOMRect
): { leafId: string; rect: DOMRect | null; paneScope: HTMLElement | null } {
  const paneNode = frame.target?.closest?.('.pane-leaf') as HTMLElement | null;
  if (paneNode?.dataset.paneId) {
    return { leafId: paneNode.dataset.paneId, rect: paneNode.getBoundingClientRect(), paneScope: paneNode };
  }
  if (
    frame.x >= panelRect.left &&
    frame.x <= panelRect.right &&
    frame.y >= panelRect.top &&
    frame.y <= panelRect.bottom
  ) {
    return { leafId: current.leaves[0]?.id ?? '', rect: panelRect, paneScope: panelElement };
  }
  return { leafId: '', rect: null, paneScope: null };
}

// Insertion point inside a pointed tab strip: before the first tab whose
// midpoint lies right of the pointer, and the bar drawn there.
function stripInsertion(
  pointedStrip: Element,
  frameX: number
): { insertIndex: number; insertBar: DropPreview['rect'] | null } {
  const targetStripRect = pointedStrip.getBoundingClientRect();
  const stripTabs = [...pointedStrip.querySelectorAll<HTMLElement>('.workspace-tab')];
  let insertIndex = stripTabs.length;
  let barX = stripTabs.length
    ? stripTabs[stripTabs.length - 1].getBoundingClientRect().right
    : targetStripRect.left + 6;
  for (let at = 0; at < stripTabs.length; at += 1) {
    const tabRect = stripTabs[at].getBoundingClientRect();
    if (frameX < tabRect.left + tabRect.width / 2) {
      insertIndex = at;
      barX = tabRect.left;
      break;
    }
  }
  const insertBar =
    targetStripRect.width > 0 && targetStripRect.height > 0
      ? {
          left: barX - 1,
          top: targetStripRect.top + 4,
          width: 2,
          height: Math.max(0, targetStripRect.height - 8),
        }
      : null;
  return { insertIndex, insertBar };
}

function paneDropAction(input: {
  groupDrag: boolean;
  sessionDrag: boolean;
  zone: PaneDropZone | 'center';
  sourceLeafId: string;
  leafId: string;
  frame: PaneDragFrame;
  insertIndex: number | undefined;
}): PaneDropAction {
  const { groupDrag, sessionDrag, zone, sourceLeafId, leafId, frame, insertIndex } = input;
  if (groupDrag && zone !== 'center') return { type: 'move-group', sourceLeafId, targetLeafId: leafId, zone };
  if (groupDrag) return { type: 'merge-group', sourceLeafId, targetLeafId: leafId, insertIndex };
  if (sessionDrag && zone === 'center') {
    return { type: 'open-in-leaf', targetLeafId: leafId, selection: frame.selection, insertIndex };
  }
  if (zone === 'center') return { type: 'move-tab', sourceLeafId, key: frame.key, targetLeafId: leafId, insertIndex };
  return { type: 'split-leaf', targetLeafId: leafId, zone, selection: frame.selection, sourceLeafId };
}

/** Resolve preview and commit data from the same native frame. */
export function resolvePaneDropIntent(
  frame: PaneDragFrame,
  current: PaneWorkspaceModel,
  panelElement: HTMLElement
): PaneDropIntent | null {
  const groupDrag = frame.kind === 'group';
  const sessionDrag = frame.kind === 'session';
  const sourceLeafId = sessionDrag
    ? (current.leaves.find((leaf) => leaf.tabs.some((tab) => navigationKey(tab) === frame.key))?.id ?? '')
    : frame.sourceLeafId || '';
  const sourceLeaf = current.leaves.find((leaf) => leaf.id === sourceLeafId);
  const sourceOwnsTab = sourceLeaf?.tabs.some((tab) => navigationKey(tab) === frame.key) === true;
  const canDetachAtRoot = groupDrag
    ? current.leaves.length > 1
    : sourceOwnsTab && (current.leaves.length > 1 || (sourceLeaf?.tabs.length ?? 0) > 1);
  const pointedStrip = frame.target?.closest?.('.workspace-tabs-shell') ?? null;
  const panelRect = panelElement.getBoundingClientRect();
  // A visible tab strip is an explicit insertion target. It wins over the
  // workspace edge bands that geometrically overlap the top and side rails.
  const outerZone =
    !sessionDrag && sourceLeafId && !pointedStrip ? paneOuterDropZone(panelRect, frame.x, frame.y) : null;
  const hierarchyTarget =
    canDetachAtRoot && outerZone
      ? paneHierarchyDropTarget(
          panelRect,
          outerZone,
          frame.x,
          frame.y,
          paneHierarchyCandidates(panelElement, panelRect)
        )
      : null;
  const outerDirection = outerZone === 'left' || outerZone === 'right' ? 'row' : 'column';
  if (
    outerZone &&
    hierarchyTarget &&
    canSplitPaneSize(outerDirection, hierarchyTarget.rect.width, hierarchyTarget.rect.height)
  ) {
    return hierarchyDropIntent({
      frame,
      current,
      panelRect,
      outerZone,
      direction: outerDirection,
      hierarchyTarget,
      sourceLeafId,
      sourceLeaf,
      groupDrag,
    });
  }
  return leafDropIntent(frame, current, panelElement, panelRect, {
    groupDrag,
    sessionDrag,
    sourceLeafId,
    sourceLeaf,
    sourceOwnsTab,
    pointedStrip,
  });
}

// A drop that lands on a leaf: an edge split, a center merge, or an explicit
// tab-strip insertion.
function leafDropIntent(
  frame: PaneDragFrame,
  current: PaneWorkspaceModel,
  panelElement: HTMLElement,
  panelRect: DOMRect,
  source: {
    groupDrag: boolean;
    sessionDrag: boolean;
    sourceLeafId: string;
    sourceLeaf: PaneLeafModel | undefined;
    sourceOwnsTab: boolean;
    pointedStrip: Element | null;
  }
): PaneDropIntent | null {
  const { groupDrag, sessionDrag, sourceLeafId, sourceLeaf, sourceOwnsTab, pointedStrip } = source;
  const { leafId, rect, paneScope } = pointedLeaf(frame, current, panelElement, panelRect);
  const target = leafId ? current.leaves.find((leaf) => leaf.id === leafId) : undefined;
  if (!target || !rect) return null;
  if (sourceLeafId === leafId && (groupDrag || (sourceOwnsTab && (sourceLeaf?.tabs.length ?? 0) < 2))) {
    return null;
  }

  const dropRect = leafDropRect(rect, paneScope);
  const overStrip = Boolean(pointedStrip);
  let zone: PaneDropZone | 'center' = overStrip ? 'center' : paneInnerDropZone(dropRect, frame.x, frame.y, groupDrag);
  if (zone !== 'center') {
    const direction = zone === 'left' || zone === 'right' ? 'row' : 'column';
    if (!canSplitPaneSize(direction, dropRect.width, dropRect.height)) zone = 'center';
  }
  const targetActive = paneActiveSelection(target);
  if (zone === 'center') {
    if (
      (!sessionDrag && (!sourceLeafId || sourceLeafId === leafId)) ||
      (sessionDrag && sourceLeafId === leafId && !overStrip)
    )
      return null;
  } else if (
    !groupDrag &&
    sourceLeafId !== leafId &&
    targetActive &&
    navigationKey(targetActive) === navigationKey(frame.selection)
  ) {
    return null;
  }

  const insertion =
    overStrip && pointedStrip && zone === 'center' && sourceLeafId !== leafId
      ? stripInsertion(pointedStrip, frame.x)
      : { insertIndex: undefined, insertBar: null };
  const preview: DropPreview = insertion.insertBar
    ? { leafId, zone: 'insert', rect: insertion.insertBar }
    : { leafId, zone, rect: rectBox(dropRect) };
  const action = paneDropAction({
    groupDrag,
    sessionDrag,
    zone,
    sourceLeafId,
    leafId,
    frame,
    insertIndex: insertion.insertIndex,
  });
  return { preview, action, selection: frame.selection };
}

export function commitPaneDropAction(current: PaneWorkspaceModel, action: PaneDropAction): void {
  switch (action.type) {
    case 'move-group-to-node-edge':
      current.moveGroupToNodeEdge(action.sourceLeafId, action.targetPath, action.zone);
      return;
    case 'move-tab-to-node-edge':
      current.moveTabToNodeEdge(action.sourceLeafId, action.key, action.targetPath, action.zone);
      return;
    case 'move-group':
      current.moveGroupAt(action.sourceLeafId, action.targetLeafId, action.zone);
      return;
    case 'merge-group':
      if (action.insertIndex === undefined) {
        current.mergeGroup(action.sourceLeafId, action.targetLeafId);
      } else {
        current.mergeGroup(action.sourceLeafId, action.targetLeafId, action.insertIndex);
      }
      return;
    case 'open-in-leaf':
      current.openInLeaf(action.targetLeafId, action.selection, action.insertIndex);
      return;
    case 'move-tab':
      current.moveTab(action.sourceLeafId, action.key, action.targetLeafId, action.insertIndex);
      return;
    case 'split-leaf':
      current.splitLeafAt(action.targetLeafId, action.zone, action.selection, action.sourceLeafId);
  }
}
