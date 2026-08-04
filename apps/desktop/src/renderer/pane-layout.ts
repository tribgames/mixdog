// Split-pane workspace model (VS Code editor groups). The workspace is a
// binary split tree whose leaves are TAB GROUPS: an ordered list of
// NavigationSelections plus the active tab's navigationKey — the 1:1
// counterpart of VS Code's editorGroupModel (editor list + active index).
// All operations are immutable — callers keep the returned root — and the
// tree is JSON-safe for persistence.
import type { WorkspaceSelection } from "./nav-types";
import { navigationKey } from "./text-format";

export type PaneDirection = "row" | "column";

export interface PaneLeaf {
  readonly type: "leaf";
  readonly id: string;
  /** Tab group in strip order; keys (navigationKey) are unique per group. */
  readonly tabs: readonly WorkspaceSelection[];
  /** navigationKey of the active tab; always one of `tabs`' keys. */
  readonly activeKey: string;
  /** At most one unpinned preview editor per group, matching VS Code. */
  readonly previewKey?: string;
}

export interface PaneSplit {
  readonly type: "split";
  readonly direction: PaneDirection;
  /** First child's share of the split axis, clamped to the ratio bounds. */
  readonly ratio: number;
  readonly first: PaneNode;
  readonly second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export const PANE_MIN_RATIO = 0.15;
export const PANE_MAX_RATIO = 0.85;
export const PANE_MIN_WIDTH = 320;
/** Vertical floor = 1.5x the horizontal floor (user spec): a stacked pane
 *  must keep a readable content run, not survive as a crushed strip. */
export const PANE_MIN_HEIGHT = 480;
export const PANE_RESIZE_HANDLE_SIZE = 4;
/** Persistence guard: a deeper stored tree than any real split arrangement
 *  could produce is rejected as corrupt instead of recursed into. */
const PANE_PARSE_DEPTH_LIMIT = 32;

let paneLeafCounter = 0;

export function createPaneLeaf(selection: WorkspaceSelection, id?: string): PaneLeaf {
  const leafId = id || (() => {
    paneLeafCounter += 1;
    return `pane_${Date.now().toString(36)}_${paneLeafCounter}`;
  })();
  return {
    type: "leaf",
    id: leafId,
    tabs: [selection],
    activeKey: navigationKey(selection),
  };
}

/** The empty workspace (VS Code/Orca): no tabs, no surface — the shell shows
 *  the centered guidance screen until a task pane is created. */
export function createEmptyPaneLeaf(id?: string): PaneLeaf {
  paneLeafCounter += 1;
  return {
    type: "leaf",
    id: id || `pane_${Date.now().toString(36)}_${paneLeafCounter}`,
    tabs: [],
    activeKey: "",
  };
}

/** The selection the group currently shows (null for an empty group). */
export function paneActiveSelection(leaf: PaneLeaf): WorkspaceSelection | null {
  return leaf.tabs.find((tab) => navigationKey(tab) === leaf.activeKey) ?? leaf.tabs[0] ?? null;
}

export function clampPaneRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(PANE_MAX_RATIO, Math.max(PANE_MIN_RATIO, value));
}

export type PaneMinimumSize = {
  width: number;
  height: number;
};

/** Recursive pixel floor for a pane subtree. Same-axis children add their
 *  tracks, while orthogonal children share the larger cross-axis floor. */
export function paneNodeMinimumSize(node: PaneNode): PaneMinimumSize {
  if (node.type === "leaf") {
    return { width: PANE_MIN_WIDTH, height: PANE_MIN_HEIGHT };
  }
  const first = paneNodeMinimumSize(node.first);
  const second = paneNodeMinimumSize(node.second);
  return node.direction === "row"
    ? {
      width: first.width + PANE_RESIZE_HANDLE_SIZE + second.width,
      height: Math.max(first.height, second.height),
    }
    : {
      width: Math.max(first.width, second.width),
      height: first.height + PANE_RESIZE_HANDLE_SIZE + second.height,
    };
}

/** Clamp a sash ratio against the recursive pixel floors of its two cells.
 *  Pixel floors take precedence over the generic 15/85 comfort bounds. */
export function clampPaneRatioForSizes(
  value: number,
  availableSize: number,
  firstMinimum: number,
  secondMinimum: number,
): number {
  const ratio = clampPaneRatio(value);
  if (!Number.isFinite(availableSize)
    || !Number.isFinite(firstMinimum)
    || !Number.isFinite(secondMinimum)) return ratio;
  const first = Math.max(0, firstMinimum);
  const second = Math.max(0, secondMinimum);
  const usableSize = Math.max(0, availableSize - PANE_RESIZE_HANDLE_SIZE);
  if (usableSize <= 0) return ratio;
  if (first + second > usableSize) {
    const totalMinimum = first + second;
    return totalMinimum > 0 ? clampPaneRatio(first / totalMinimum) : ratio;
  }
  return Math.min(1 - second / usableSize, Math.max(first / usableSize, ratio));
}

export function paneLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === "leaf") return [node];
  return [...paneLeaves(node.first), ...paneLeaves(node.second)];
}

export function findPaneLeaf(node: PaneNode, leafId: string): PaneLeaf | null {
  if (node.type === "leaf") return node.id === leafId ? node : null;
  return findPaneLeaf(node.first, leafId) ?? findPaneLeaf(node.second, leafId);
}

/** First group (reading order) that holds the key, or null. */
export function paneLeafContainingKey(root: PaneNode, key: string): PaneLeaf | null {
  return paneLeaves(root)
    .find((leaf) => leaf.tabs.some((tab) => navigationKey(tab) === key)) ?? null;
}

/** Immutable single-leaf rewrite; an unchanged leaf returns the same root. */
function mapPaneLeaf(
  root: PaneNode,
  leafId: string,
  update: (leaf: PaneLeaf) => PaneLeaf,
): PaneNode {
  const walk = (node: PaneNode): PaneNode => {
    if (node.type === "leaf") return node.id === leafId ? update(node) : node;
    const first = walk(node.first);
    const second = first === node.first ? walk(node.second) : node.second;
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  };
  return walk(root);
}

/** Open a selection in one group: activate the existing tab, or append a new
 *  one. `replaceKey` promotes in place (draft → its materialized session) at
 *  the replaced tab's exact strip position, dropping any older copy of the
 *  destination elsewhere in the group. `index` places the tab at that strip
 *  position (VS Code tabs-container drop index). */
export function openTabInPaneLeaf(
  root: PaneNode,
  leafId: string,
  selection: WorkspaceSelection,
  replaceKey = "",
  options: { preview?: boolean; index?: number } = {},
): PaneNode {
  return mapPaneLeaf(root, leafId, (leaf) => {
    const key = navigationKey(selection);
    const preview = options.preview === true && selection.kind === "file";
    const placeAt = (tabs: readonly WorkspaceSelection[], tabKey: string) => {
      const index = options.index;
      if (index === undefined) return tabs;
      const from = tabs.findIndex((tab) => navigationKey(tab) === tabKey);
      if (from < 0) return tabs;
      const next = [...tabs];
      const [moved] = next.splice(from, 1);
      next.splice(Math.max(0, Math.min(index, next.length)), 0, moved);
      return next.every((tab, at) => tab === tabs[at]) ? tabs : next;
    };
    if (replaceKey && replaceKey !== key) {
      const replaced = leaf.tabs.findIndex((tab) => navigationKey(tab) === replaceKey);
      if (replaced >= 0) {
        const tabs = leaf.tabs
          .map((tab, index) => (index === replaced ? selection : tab))
          .filter((tab, index) => index === replaced || navigationKey(tab) !== key);
        return {
          ...leaf,
          tabs,
          activeKey: key,
          previewKey: leaf.previewKey === replaceKey
            ? (preview ? key : undefined)
            : leaf.previewKey,
        };
      }
    }
    const existingIndex = leaf.tabs.findIndex((tab) =>
      navigationKey(tab) === key
      || (tab.kind === "file" && selection.kind === "file"
        && tab.project === selection.project && tab.rel === selection.rel));
    if (existingIndex >= 0) {
      const existing = leaf.tabs[existingIndex];
      // Reopening an externally selected file may carry a freshly minted
      // permission token. Conversely, pane focus routes omit the token and
      // must not erase the one already attached to the tab.
      const nextSelection = existing.kind === "file" && selection.kind === "file"
        ? {
          ...selection,
          ...(selection.accessToken || existing.accessToken
            ? { accessToken: selection.accessToken || existing.accessToken }
            : {}),
        }
        : existing;
      const selectionChanged = nextSelection !== existing
        && (nextSelection.kind !== "file" || existing.kind !== "file"
          || nextSelection.accessToken !== existing.accessToken);
      const resolvedKey = navigationKey(nextSelection);
      const previewKey = preview
        ? leaf.previewKey
        : leaf.previewKey === resolvedKey ? undefined : leaf.previewKey;
      const tabs = placeAt(selectionChanged
        ? leaf.tabs.map((tab, index) => (index === existingIndex ? nextSelection : tab))
        : leaf.tabs, resolvedKey);
      if (leaf.activeKey === resolvedKey && !selectionChanged
        && previewKey === leaf.previewKey && tabs === leaf.tabs) return leaf;
      return { ...leaf, tabs, activeKey: resolvedKey, previewKey };
    }
    if (preview && leaf.previewKey) {
      const previewIndex = leaf.tabs.findIndex((tab) =>
        navigationKey(tab) === leaf.previewKey);
      if (previewIndex >= 0) {
        const tabs = leaf.tabs.map((tab, index) =>
          index === previewIndex ? selection : tab);
        return { ...leaf, tabs, activeKey: key, previewKey: key };
      }
    }
    const nextPreviewKey = preview ? key : leaf.previewKey;
    const appended = [...leaf.tabs];
    appended.splice(
      options.index === undefined
        ? appended.length
        : Math.max(0, Math.min(options.index, appended.length)),
      0,
      selection,
    );
    return {
      ...Object.fromEntries(Object.entries(leaf)
        .filter(([name]) => name !== "previewKey")) as PaneLeaf,
      tabs: appended,
      activeKey: key,
      ...(nextPreviewKey ? { previewKey: nextPreviewKey } : {}),
    };
  });
}

export function pinTabInPaneLeaf(root: PaneNode, leafId: string, key: string): PaneNode {
  return mapPaneLeaf(root, leafId, (leaf) => (
    leaf.previewKey === key ? { ...leaf, previewKey: undefined } : leaf
  ));
}

export function activateTabInPaneLeaf(root: PaneNode, leafId: string, key: string): PaneNode {
  return mapPaneLeaf(root, leafId, (leaf) => (
    leaf.activeKey !== key && leaf.tabs.some((tab) => navigationKey(tab) === key)
      ? { ...leaf, activeKey: key }
      : leaf
  ));
}

export function reorderTabInPaneLeaf(
  root: PaneNode,
  leafId: string,
  sourceKey: string,
  target: string | number,
): PaneNode {
  return mapPaneLeaf(root, leafId, (leaf) => {
    const keys = leaf.tabs.map((tab) => navigationKey(tab));
    const from = keys.indexOf(sourceKey);
    // A numeric target is the VS Code drop index (multiEditorTabsControl
    // onDrop): resolved against the CURRENT list with the source still in
    // place — tab half rule, container drop = count — so an index past the
    // source shifts down by one after removal.
    const to = typeof target === "number"
      ? Math.max(0, Math.min(target > from ? target - 1 : target, keys.length - 1))
      : keys.indexOf(target);
    if (from < 0 || to < 0 || from === to) return leaf;
    const tabs = [...leaf.tabs];
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    return { ...leaf, tabs };
  });
}

/** Close one tab in one group. The last tab closes the group itself (its
 *  sibling absorbs the cell); closing the active tab activates its nearest
 *  neighbor — the same fallback rule the old strip used. Returns null when
 *  the whole tree emptied. */
export function closeTabInPaneLeaf(
  root: PaneNode,
  leafId: string,
  key: string,
): PaneNode | null {
  const leaf = findPaneLeaf(root, leafId);
  if (!leaf) return root;
  const index = leaf.tabs.findIndex((tab) => navigationKey(tab) === key);
  if (index < 0) return root;
  if (leaf.tabs.length === 1) return closePaneLeaf(root, leafId);
  const tabs = leaf.tabs.filter((_, tabIndex) => tabIndex !== index);
  const activeKey = leaf.activeKey === key
    ? navigationKey(tabs[Math.min(index, tabs.length - 1)])
    : leaf.activeKey;
  return mapPaneLeaf(root, leafId, () => ({
    ...leaf,
    tabs,
    activeKey,
    previewKey: leaf.previewKey === key ? undefined : leaf.previewKey,
  }));
}

/** Split the addressed leaf: it keeps the first cell, the new leaf takes the
 *  second (or the first with position "before" — drop on a pane's left/top
 *  edge). Returns the root unchanged when the leaf is missing. */
export function splitPaneLeaf(
  root: PaneNode,
  leafId: string,
  direction: PaneDirection,
  leaf: PaneLeaf,
  ratio = 0.5,
  position: "before" | "after" = "after",
): PaneNode {
  if (!findPaneLeaf(root, leafId)) return root;
  const replace = (node: PaneNode): PaneNode => {
    if (node.type === "leaf") {
      if (node.id !== leafId) return node;
      return {
        type: "split",
        direction,
        ratio: clampPaneRatio(ratio),
        first: position === "before" ? leaf : node,
        second: position === "before" ? node : leaf,
      };
    }
    const first = replace(node.first);
    const second = first === node.first ? replace(node.second) : node.second;
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  };
  return replace(root);
}

/** Close the addressed leaf; its sibling absorbs the parent cell. Closing the
 *  root leaf yields null — the caller decides what an empty workspace shows. */
export function closePaneLeaf(root: PaneNode, leafId: string): PaneNode | null {
  const close = (node: PaneNode): PaneNode | null => {
    if (node.type === "leaf") return node.id === leafId ? null : node;
    const first = close(node.first);
    if (first === null) return node.second;
    const second = close(node.second);
    if (second === null) return first;
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  };
  return close(root);
}

/** Merge an entire source editor group into a target group. The source
 *  collapses out of the tree and its active tab remains active in the merged
 *  target, matching VS Code's group-header drop. `insertIndex` splices the
 *  incoming tabs at that strip position (VS Code mergeGroup { index }). */
export function mergePaneLeaf(
  root: PaneNode,
  sourceLeafId: string,
  targetLeafId: string,
  insertIndex?: number,
): PaneNode {
  if (!sourceLeafId || sourceLeafId === targetLeafId) return root;
  const source = findPaneLeaf(root, sourceLeafId);
  if (!source || !findPaneLeaf(root, targetLeafId)) return root;
  const removed = closePaneLeaf(root, sourceLeafId);
  if (!removed) return root;
  return mapPaneLeaf(removed, targetLeafId, (target) => {
    const tabs = [...target.tabs];
    const keys = new Set(tabs.map((tab) => navigationKey(tab)));
    const incoming: WorkspaceSelection[] = [];
    for (const tab of source.tabs) {
      const key = navigationKey(tab);
      if (keys.has(key)) continue;
      keys.add(key);
      incoming.push(tab);
    }
    tabs.splice(
      insertIndex === undefined
        ? tabs.length
        : Math.max(0, Math.min(insertIndex, tabs.length)),
      0,
      ...incoming,
    );
    return {
      ...target,
      tabs,
      activeKey: keys.has(source.activeKey) ? source.activeKey : target.activeKey,
      previewKey: target.previewKey
        || (source.previewKey && keys.has(source.previewKey) ? source.previewKey : undefined),
    };
  });
}

/** Move an entire source group beside a target group. Removing the source
 *  first collapses its old parent, then the same leaf identity is inserted at
 *  the target edge so mounted editor/session state survives the reshape. */
export function movePaneLeaf(
  root: PaneNode,
  sourceLeafId: string,
  targetLeafId: string,
  direction: PaneDirection,
  position: "before" | "after",
): PaneNode {
  if (!sourceLeafId || sourceLeafId === targetLeafId) return root;
  const source = findPaneLeaf(root, sourceLeafId);
  if (!source || !findPaneLeaf(root, targetLeafId)) return root;
  const removed = closePaneLeaf(root, sourceLeafId);
  if (!removed || !findPaneLeaf(removed, targetLeafId)) return root;
  return splitPaneLeaf(removed, targetLeafId, direction, source, 0.5, position);
}

function balanceInsertedPaneLayout(root: PaneNode, direction: PaneDirection): PaneNode {
  if (root.type !== "split" || root.direction !== direction) return root;
  // Orthogonal stacks count as one track on this axis, so adding a full-span
  // pane beside a two-column grid produces three equal columns.
  return distributePaneRatiosAlong(root, direction);
}

export function paneNodeAtPath(root: PaneNode, path: string): PaneNode | null {
  let node = root;
  if (!path) return node;
  for (const segment of path.split(".")) {
    if (node.type !== "split" || (segment !== "first" && segment !== "second")) return null;
    node = node[segment];
  }
  return node;
}

/** Split axis that directly owns a leaf. Structural removals use this before
 *  collapsing the parent so the surviving tracks can be redistributed along
 *  exactly the axis that changed. */
export function paneLeafParentDirection(
  root: PaneNode,
  leafId: string,
): PaneDirection | null {
  if (root.type === "leaf") return null;
  if ((root.first.type === "leaf" && root.first.id === leafId)
    || (root.second.type === "leaf" && root.second.id === leafId)) {
    return root.direction;
  }
  return paneLeafParentDirection(root.first, leafId)
    ?? paneLeafParentDirection(root.second, leafId);
}

export type PaneRelativeRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Resolve one leaf's final normalized bounds after a structural layout
 *  operation. Drop previews use this so their highlighted slot matches the
 *  pane's actual row/column share instead of always claiming half a node. */
export function paneLeafRelativeRect(
  root: PaneNode,
  leafId: string,
): PaneRelativeRect | null {
  const walk = (
    node: PaneNode,
    rect: PaneRelativeRect,
  ): PaneRelativeRect | null => {
    if (node.type === "leaf") return node.id === leafId ? rect : null;
    const ratio = clampPaneRatio(node.ratio);
    if (node.direction === "row") {
      const firstWidth = rect.width * ratio;
      return walk(node.first, { ...rect, width: firstWidth })
        ?? walk(node.second, {
          left: rect.left + firstWidth,
          top: rect.top,
          width: rect.width - firstWidth,
          height: rect.height,
        });
    }
    const firstHeight = rect.height * ratio;
    return walk(node.first, { ...rect, height: firstHeight })
      ?? walk(node.second, {
        left: rect.left,
        top: rect.top + firstHeight,
        width: rect.width,
        height: rect.height - firstHeight,
      });
  };
  return walk(root, { left: 0, top: 0, width: 1, height: 1 });
}

/** Visual row-major order: traverse panes left-to-right within the topmost
 *  lane before continuing downward. The binary tree's DFS order becomes
 *  column-major when each side of a row split is split vertically. */
export function paneLeavesInVisualOrder(root: PaneNode): PaneLeaf[] {
  const leaves = paneLeaves(root);
  const fallbackOrder = new Map(leaves.map((leaf, index) => [leaf.id, index]));
  const rects = new Map(leaves.map((leaf) => [leaf.id, paneLeafRelativeRect(root, leaf.id)]));
  return [...leaves].sort((left, right) => {
    const leftRect = rects.get(left.id);
    const rightRect = rects.get(right.id);
    if (!leftRect || !rightRect) {
      return (fallbackOrder.get(left.id) ?? 0) - (fallbackOrder.get(right.id) ?? 0);
    }
    const vertical = leftRect.top - rightRect.top;
    if (Math.abs(vertical) > Number.EPSILON) return vertical;
    const horizontal = leftRect.left - rightRect.left;
    if (Math.abs(horizontal) > Number.EPSILON) return horizontal;
    return (fallbackOrder.get(left.id) ?? 0) - (fallbackOrder.get(right.id) ?? 0);
  });
}

function replacePaneNodeAtPath(root: PaneNode, path: string, replacement: PaneNode): PaneNode {
  if (!path) return replacement;
  const [head, ...rest] = path.split(".");
  if (root.type !== "split" || (head !== "first" && head !== "second")) return root;
  const child = replacePaneNodeAtPath(root[head], rest.join("."), replacement);
  return child === root[head] ? root : { ...root, [head]: child };
}

function smallestPanePathContaining(root: PaneNode, leafIds: ReadonlySet<string>): string | null {
  if (leafIds.size === 0) return null;
  const containsAll = (node: PaneNode): boolean => {
    const ids = new Set(paneLeaves(node).map((leaf) => leaf.id));
    return [...leafIds].every((id) => ids.has(id));
  };
  if (!containsAll(root)) return null;
  const walk = (node: PaneNode, path: string): string => {
    if (node.type === "leaf") return path;
    if (containsAll(node.first)) return walk(node.first, path ? `${path}.first` : "first");
    if (containsAll(node.second)) return walk(node.second, path ? `${path}.second` : "second");
    return path;
  };
  return walk(root, "");
}

function insertPaneBesideNode(
  root: PaneNode,
  targetPath: string,
  leaf: PaneLeaf,
  direction: PaneDirection,
  position: "before" | "after",
): PaneNode {
  const target = paneNodeAtPath(root, targetPath);
  if (!target) return root;
  const replacement = balanceInsertedPaneLayout({
    type: "split",
    direction,
    ratio: 0.5,
    first: position === "before" ? leaf : target,
    second: position === "before" ? target : leaf,
  }, direction);
  return replacePaneNodeAtPath(root, targetPath, replacement);
}

/** Move a group beside an ACTUAL pane-tree node. The target path is resolved
 *  again after detaching the source so collapsed parents cannot stale it. */
export function movePaneLeafToNodeEdge(
  root: PaneNode,
  sourceLeafId: string,
  targetPath: string,
  direction: PaneDirection,
  position: "before" | "after",
): PaneNode {
  if (!sourceLeafId) return root;
  const source = findPaneLeaf(root, sourceLeafId);
  const target = paneNodeAtPath(root, targetPath);
  if (!source || !target) return root;
  const sourceAlreadyAtEdge = target.type === "split"
    && target.direction === direction
    && (position === "before" ? target.first : target.second) === source;
  if (sourceAlreadyAtEdge) {
    const balanced = balanceInsertedPaneLayout(target, direction);
    return balanced === target ? root : replacePaneNodeAtPath(root, targetPath, balanced);
  }
  const targetLeafIds = new Set(
    paneLeaves(target).map((leaf) => leaf.id).filter((id) => id !== sourceLeafId),
  );
  if (targetLeafIds.size === 0) return root;
  const removed = closePaneLeaf(root, sourceLeafId);
  if (!removed) return root;
  const resolvedTargetPath = smallestPanePathContaining(removed, targetLeafIds);
  if (resolvedTargetPath === null) return root;
  return insertPaneBesideNode(removed, resolvedTargetPath, source, direction, position);
}

/** Move one dragged tab beside a pane-tree node. A one-tab source moves its
 *  group; a multi-tab source detaches only that tab into a new group. */
export function movePaneTabToNodeEdge(
  root: PaneNode,
  sourceLeafId: string,
  key: string,
  targetPath: string,
  direction: PaneDirection,
  position: "before" | "after",
  newLeafId?: string,
): PaneNode {
  const source = findPaneLeaf(root, sourceLeafId);
  const selection = source?.tabs.find((tab) => navigationKey(tab) === key);
  if (!source || !selection) return root;
  if (source.tabs.length === 1) {
    return movePaneLeafToNodeEdge(root, sourceLeafId, targetPath, direction, position);
  }
  const target = paneNodeAtPath(root, targetPath);
  if (!target) return root;
  const targetLeafIds = new Set(paneLeaves(target).map((leaf) => leaf.id));
  const removed = closeTabInPaneLeaf(root, sourceLeafId, key);
  if (!removed) return root;
  const resolvedTargetPath = smallestPanePathContaining(removed, targetLeafIds);
  if (resolvedTargetPath === null) return root;
  const leaf = createPaneLeaf(selection, newLeafId);
  return insertPaneBesideNode(removed, resolvedTargetPath, leaf, direction, position);
}

export function movePaneLeafToRootEdge(
  root: PaneNode,
  sourceLeafId: string,
  direction: PaneDirection,
  position: "before" | "after",
): PaneNode {
  return movePaneLeafToNodeEdge(root, sourceLeafId, "", direction, position);
}

export function movePaneTabToRootEdge(
  root: PaneNode,
  sourceLeafId: string,
  key: string,
  direction: PaneDirection,
  position: "before" | "after",
): PaneNode {
  return movePaneTabToNodeEdge(root, sourceLeafId, key, "", direction, position);
}

/** Update one split's ratio. The split is addressed by its path from the
 *  root — '' for the root split, then 'first'/'second' segments joined with
 *  dots (orca-style), which stays stable while the user drags one handle. */
export function setPaneSplitRatio(root: PaneNode, path: string, ratio: number): PaneNode {
  const walk = (node: PaneNode, segments: string[]): PaneNode => {
    if (node.type !== "split") return node;
    if (segments.length === 0) return { ...node, ratio: clampPaneRatio(ratio) };
    const [head, ...rest] = segments;
    if (head === "first") {
      const first = walk(node.first, rest);
      return first === node.first ? node : { ...node, first };
    }
    if (head === "second") {
      const second = walk(node.second, rest);
      return second === node.second ? node : { ...node, second };
    }
    return node;
  };
  return walk(root, path ? path.split(".") : []);
}

/** Even distribution (VS Code arrange): after a structural change every
 *  split's ratio is recomputed from the leaf weights along its axis, so
 *  adding or removing panes always lands on equal columns/rows. Manual sash
 *  drags persist until the next structural change. */
export function distributePaneRatios(root: PaneNode): PaneNode {
  const weight = (node: PaneNode, direction: PaneDirection): number => {
    if (node.type === "leaf") return 1;
    if (node.direction === direction) {
      return weight(node.first, direction) + weight(node.second, direction);
    }
    return Math.max(weight(node.first, direction), weight(node.second, direction));
  };
  const walk = (node: PaneNode): PaneNode => {
    if (node.type === "leaf") return node;
    const first = walk(node.first);
    const second = walk(node.second);
    const a = weight(first, node.direction);
    const b = weight(second, node.direction);
    const ratio = clampPaneRatio(a / (a + b));
    if (first === node.first && second === node.second && ratio === node.ratio) return node;
    return { ...node, first, second, ratio };
  };
  return walk(root);
}

/** Distribute only the axis changed by a root-edge drop. Same-axis nested
 *  tracks become equal rows/columns while orthogonal manual sizing survives. */
export function distributePaneRatiosAlong(
  root: PaneNode,
  direction: PaneDirection,
): PaneNode {
  const weight = (node: PaneNode): number => {
    if (node.type === "leaf") return 1;
    if (node.direction === direction) return weight(node.first) + weight(node.second);
    return Math.max(weight(node.first), weight(node.second));
  };
  const walk = (node: PaneNode): PaneNode => {
    if (node.type === "leaf") return node;
    const first = walk(node.first);
    const second = walk(node.second);
    if (node.direction !== direction) {
      return first === node.first && second === node.second
        ? node
        : { ...node, first, second };
    }
    const a = weight(first);
    const b = weight(second);
    const ratio = clampPaneRatio(a / (a + b));
    if (first === node.first && second === node.second && ratio === node.ratio) return node;
    return { ...node, first, second, ratio };
  };
  return walk(root);
}

export function canSplitPaneSize(
  direction: PaneDirection,
  width: number,
  height: number,
): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return true;
  const minimumWidth = direction === "row"
    ? PANE_MIN_WIDTH * 2 + PANE_RESIZE_HANDLE_SIZE
    : PANE_MIN_WIDTH;
  const minimumHeight = direction === "column"
    ? PANE_MIN_HEIGHT * 2 + PANE_RESIZE_HANDLE_SIZE
    : PANE_MIN_HEIGHT;
  return width >= minimumWidth && height >= minimumHeight;
}

/** The leaf that should take focus after closing leafId: its nearest
 *  neighbor in reading order, matching how the tab strip picked the next tab. */
export function neighborPaneLeafId(root: PaneNode, leafId: string): string | null {
  const leaves = paneLeaves(root);
  const index = leaves.findIndex((leaf) => leaf.id === leafId);
  if (index < 0) return null;
  const remaining = leaves.filter((leaf) => leaf.id !== leafId);
  if (remaining.length === 0) return null;
  return remaining[Math.min(index, remaining.length - 1)].id;
}

function parsedSelection(value: unknown): WorkspaceSelection | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!record) return null;
  switch (record.kind) {
    case "new":
      return typeof record.draftId === "string" && record.draftId
        ? { kind: "new", draftId: record.draftId }
        : { kind: "new" };
    case "project":
      return typeof record.path === "string" && record.path
        ? { kind: "project", path: record.path }
        : null;
    case "session":
      return typeof record.id === "string" && record.id
        ? { kind: "session", id: record.id }
        : null;
    case "agent-session":
      return typeof record.id === "string" && record.id
        && typeof record.ownerSessionId === "string" && record.ownerSessionId
        && typeof record.title === "string" && record.title
        ? {
          kind: "agent-session",
          id: record.id,
          ownerSessionId: record.ownerSessionId,
          title: record.title,
        }
        : null;
    case "file":
      return typeof record.project === "string" && record.project
        && typeof record.rel === "string" && record.rel
        ? {
          kind: "file",
          project: record.project,
          rel: record.rel,
          ...(typeof record.accessToken === "string" && record.accessToken
            ? { accessToken: record.accessToken }
            : {}),
        }
        : null;
    case "studio":
      return typeof record.id === "string" && record.id
        ? { kind: "studio", id: record.id }
        : null;
    case "terminal":
      return typeof record.id === "string" && record.id
        ? {
          kind: "terminal",
          id: record.id,
          ...(typeof record.cwd === "string" && record.cwd ? { cwd: record.cwd } : {}),
        }
        : null;
    case "folder":
      return typeof record.id === "string" && record.id
        && typeof record.path === "string" && record.path
        ? { kind: "folder", id: record.id, path: record.path }
        : null;
    case "pull-request":
      return typeof record.project === "string" && record.project
        && Number.isInteger(record.number) && Number(record.number) > 0
        && (record.mode === "overview" || record.mode === "changes")
        ? {
          kind: "pull-request",
          project: record.project,
          number: Number(record.number),
          mode: record.mode,
          ...(typeof record.title === "string" && record.title ? { title: record.title } : {}),
          ...(typeof record.instanceId === "string" && record.instanceId
            ? { instanceId: record.instanceId }
            : {}),
        }
        : null;
    case "diff":
      return typeof record.project === "string" && record.project
        && typeof record.rel === "string" && record.rel
        && (record.source === "staged" || record.source === "unstaged" || record.source === "commit")
        && (record.source !== "commit" || (typeof record.hash === "string" && record.hash))
        ? {
          kind: "diff",
          project: record.project,
          rel: record.rel,
          source: record.source,
          ...(typeof record.hash === "string" && record.hash ? { hash: record.hash } : {}),
          ...(record.untracked === true ? { untracked: true } : {}),
        }
        : null;
    default:
      return null;
  }
}

/** Validate a persisted tree. Any malformed node rejects the WHOLE layout —
 *  a partially restored split arrangement is worse than a fresh single pane. */
export function parsePaneLayout(value: unknown): PaneNode | null {
  const seenIds = new Set<string>();
  const parse = (node: unknown, depth: number): PaneNode | null => {
    if (depth > PANE_PARSE_DEPTH_LIMIT) return null;
    const record = node && typeof node === "object" ? node as Record<string, unknown> : null;
    if (!record) return null;
    if (record.type === "leaf") {
      const id = typeof record.id === "string" ? record.id : "";
      if (!id || seenIds.has(id)) return null;
      // Legacy single-selection leaves (pre-tab-group) migrate to a
      // one-tab group instead of invalidating the stored layout.
      const rawTabs = Array.isArray(record.tabs)
        ? record.tabs
        : record.selection !== undefined ? [record.selection] : [];
      const tabs: WorkspaceSelection[] = [];
      const keys = new Set<string>();
      for (const value of rawTabs) {
        const selection = parsedSelection(value);
        if (!selection) return null;
        const key = navigationKey(selection);
        if (keys.has(key)) return null;
        keys.add(key);
        tabs.push(selection);
      }
      seenIds.add(id);
      // A zero-tab leaf is the persisted EMPTY workspace.
      if (tabs.length === 0) return { type: "leaf", id, tabs, activeKey: "" };
      const activeKey = typeof record.activeKey === "string" && keys.has(record.activeKey)
        ? record.activeKey
        : navigationKey(tabs[0]);
      const previewKey = typeof record.previewKey === "string"
        && keys.has(record.previewKey)
        && tabs.find((tab) => navigationKey(tab) === record.previewKey)?.kind === "file"
        ? record.previewKey
        : undefined;
      return { type: "leaf", id, tabs, activeKey, ...(previewKey ? { previewKey } : {}) };
    }
    if (record.type === "split") {
      if (record.direction !== "row" && record.direction !== "column") return null;
      const first = parse(record.first, depth + 1);
      const second = parse(record.second, depth + 1);
      if (!first || !second) return null;
      return {
        type: "split",
        direction: record.direction,
        ratio: clampPaneRatio(Number(record.ratio)),
        first,
        second,
      };
    }
    return null;
  };
  const parsed = value == null ? null : parse(value, 0);
  return parsed;
}
