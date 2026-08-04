import type { PaneDropZone } from "./pane-workspace-state";

export type PaneDropRect = Pick<
  DOMRect,
  "left" | "right" | "top" | "bottom" | "width" | "height"
>;
export type PaneHierarchyCandidate = {
  path: string;
  rect: PaneDropRect;
};

function edgeReach(size: number): number {
  return Math.min(112, Math.max(72, size * 0.12));
}

/** Inner drop zone inside one pane — VS Code DropOverlay.positionOverlay
 *  grammar (preferSplitVertically, the default openSideBySideDirection=
 *  "right"): an edge band offers a split — tab drags use 15% (user: the
 *  stock 10% felt too tight; the ONE sanctioned deviation from the refs
 *  numbers); group drags widen only the HORIZONTAL band to 30% while the
 *  vertical band stays 10%. Everything inside merges. A band hit resolves
 *  its direction by THIRDS — the full left/right third aims a horizontal
 *  split; only the middle third splits up/down by vertical half. */
export function paneInnerDropZone(
  rect: PaneDropRect,
  x: number,
  y: number,
  groupDrag = false,
): PaneDropZone | "center" {
  const nx = (x - rect.left) / Math.max(1, rect.width);
  const ny = (y - rect.top) / Math.max(1, rect.height);
  const edgeX = groupDrag ? 0.3 : 0.15;
  const edgeY = groupDrag ? 0.1 : 0.15;
  if (nx > edgeX && nx < 1 - edgeX && ny > edgeY && ny < 1 - edgeY) return "center";
  if (nx < 1 / 3) return "left";
  if (nx > 2 / 3) return "right";
  return ny < 0.5 ? "top" : "bottom";
}

/** Resolve only the physical workspace edge. Which TREE node owns that edge
 *  is selected separately from real pane rectangles, never viewport bands. */
export function paneOuterDropZone(
  rect: PaneDropRect,
  x: number,
  y: number,
): PaneDropZone | null {
  if (rect.width <= 0 || rect.height <= 0
    || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  const horizontalReach = edgeReach(rect.width);
  const verticalReach = edgeReach(rect.height);
  const candidates: Array<{ zone: PaneDropZone; distance: number; reach: number }> = [
    { zone: "left", distance: x - rect.left, reach: horizontalReach },
    { zone: "right", distance: rect.right - x, reach: horizontalReach },
    { zone: "top", distance: y - rect.top, reach: verticalReach },
    { zone: "bottom", distance: rect.bottom - y, reach: verticalReach },
  ];
  let nearest: { zone: PaneDropZone; distance: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.distance > candidate.reach
      || (nearest && candidate.distance >= nearest.distance)) continue;
    nearest = candidate;
  }
  return nearest?.zone ?? null;
}

/** Choose the pane-tree node whose edge center is closest to the pointer.
 *  Equal geometry prefers the shallower ancestor, making a shared row divider
 *  select root while a row's own center selects that leaf. */
export function paneHierarchyDropTarget(
  panel: PaneDropRect,
  zone: PaneDropZone,
  x: number,
  y: number,
  candidates: readonly PaneHierarchyCandidate[],
): PaneHierarchyCandidate | null {
  const epsilon = 3;
  const depth = (path: string): number => path ? path.split(".").length : 0;
  const touchesEdge = (rect: PaneDropRect): boolean => {
    switch (zone) {
      case "left": return Math.abs(rect.left - panel.left) <= epsilon;
      case "right": return Math.abs(rect.right - panel.right) <= epsilon;
      case "top": return Math.abs(rect.top - panel.top) <= epsilon;
      case "bottom": return Math.abs(rect.bottom - panel.bottom) <= epsilon;
    }
  };
  const containsAlong = (rect: PaneDropRect): boolean =>
    zone === "left" || zone === "right"
      ? y >= rect.top - epsilon && y <= rect.bottom + epsilon
      : x >= rect.left - epsilon && x <= rect.right + epsilon;
  const centerDistance = (rect: PaneDropRect): number =>
    zone === "left" || zone === "right"
      ? Math.abs(y - (rect.top + rect.height / 2))
      : Math.abs(x - (rect.left + rect.width / 2));
  const panelCenterDistance = centerDistance(panel);
  const panelCrossSize = zone === "left" || zone === "right" ? panel.height : panel.width;
  const inRootCenterRail = panelCenterDistance <= Math.min(48, panelCrossSize * 0.12);
  return candidates
    .filter((candidate) => candidate.rect.width > 0 && candidate.rect.height > 0
      && touchesEdge(candidate.rect) && containsAlong(candidate.rect))
    .sort((left, right) => centerDistance(left.rect) - centerDistance(right.rect)
      || (inRootCenterRail
        ? depth(left.path) - depth(right.path)
        : depth(right.path) - depth(left.path)))[0] ?? null;
}
