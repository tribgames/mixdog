import {
  useCallback,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type HTMLAttributes,
} from "react";
import type { UtilityDockTab } from "./UtilityDock";

const UTILITY_DOCK_VIEW_LAYOUT_KEY = "mixdog.desktop.utility-dock-view-layout.v1";
export const UTILITY_DOCK_VIEW_MIME = "application/x-mixdog-utility-dock-view";
export const UTILITY_DOCK_GROUP_MIME = "application/x-mixdog-utility-dock-group";

export type UtilityDockViewGroup = readonly UtilityDockTab[];
export type UtilityDockViewPlacement = "before" | "after" | "inside";

export const DEFAULT_UTILITY_DOCK_VIEW_ORDER: readonly UtilityDockTab[] = [
  "agents",
  "search",
  "source-control",
  "pull-requests",
];

function isUtilityDockTab(value: unknown): value is UtilityDockTab {
  return DEFAULT_UTILITY_DOCK_VIEW_ORDER.includes(value as UtilityDockTab);
}

export function normalizeUtilityDockViewGroups(
  value: unknown,
  available: readonly UtilityDockTab[] = DEFAULT_UTILITY_DOCK_VIEW_ORDER,
): UtilityDockViewGroup[] {
  const allowed = new Set(available);
  const seen = new Set<UtilityDockTab>();
  const groups: UtilityDockTab[][] = [];
  if (Array.isArray(value)) {
    for (const rawGroup of value) {
      if (!Array.isArray(rawGroup)) continue;
      const group: UtilityDockTab[] = [];
      for (const id of rawGroup) {
        if (!isUtilityDockTab(id) || !allowed.has(id) || seen.has(id)) continue;
        seen.add(id);
        group.push(id);
      }
      if (group.length) groups.push(group);
    }
  }
  for (const id of available) {
    if (!seen.has(id)) groups.push([id]);
  }
  return groups;
}

function mutableGroups(groups: readonly UtilityDockViewGroup[]): UtilityDockTab[][] {
  return groups.map((group) => [...group]).filter((group) => group.length > 0);
}

export function moveUtilityDockViewGroup(
  groups: readonly UtilityDockViewGroup[],
  sourceRoot: UtilityDockTab,
  targetRoot: UtilityDockTab,
  placement: Exclude<UtilityDockViewPlacement, "inside">,
): UtilityDockViewGroup[] {
  const next = mutableGroups(groups);
  const sourceIndex = next.findIndex((group) => group[0] === sourceRoot);
  const targetIndex = next.findIndex((group) => group[0] === targetRoot);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return next;
  const [source] = next.splice(sourceIndex, 1);
  const adjustedTarget = next.findIndex((group) => group[0] === targetRoot);
  next.splice(adjustedTarget + (placement === "after" ? 1 : 0), 0, source);
  return next;
}

export function moveUtilityDockView(
  groups: readonly UtilityDockViewGroup[],
  sourceId: UtilityDockTab,
  targetId: UtilityDockTab,
  placement: UtilityDockViewPlacement,
): UtilityDockViewGroup[] {
  if (sourceId === targetId) return mutableGroups(groups);
  const next = mutableGroups(groups);
  const sourceGroupIndex = next.findIndex((group) => group.includes(sourceId));
  const targetGroupIndex = next.findIndex((group) => group.includes(targetId));
  if (sourceGroupIndex < 0 || targetGroupIndex < 0) return next;
  if (placement === "inside"
    && sourceGroupIndex === targetGroupIndex
    && next[sourceGroupIndex][0] === sourceId) return next;

  next[sourceGroupIndex] = next[sourceGroupIndex].filter((id) => id !== sourceId);
  if (next[sourceGroupIndex].length === 0) next.splice(sourceGroupIndex, 1);
  const currentTargetGroupIndex = next.findIndex((group) => group.includes(targetId));
  if (currentTargetGroupIndex < 0) return next;
  if (placement === "inside") {
    const targetGroup = next[currentTargetGroupIndex];
    targetGroup.splice(targetGroup.indexOf(targetId) + 1, 0, sourceId);
  } else {
    next.splice(currentTargetGroupIndex + (placement === "after" ? 1 : 0), 0, [sourceId]);
  }
  return next;
}

function readStoredGroups(): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(UTILITY_DOCK_VIEW_LAYOUT_KEY) || "null");
  } catch {
    return null;
  }
}

function persistGroups(groups: readonly UtilityDockViewGroup[]): void {
  try {
    window.localStorage.setItem(UTILITY_DOCK_VIEW_LAYOUT_KEY, JSON.stringify(groups));
  } catch {
    // View customization remains active for the current renderer.
  }
}

export function utilityDockViewDragId(
  event: Pick<DragEvent, "dataTransfer">,
): UtilityDockTab | null {
  const value = event.dataTransfer?.getData(UTILITY_DOCK_VIEW_MIME);
  return isUtilityDockTab(value) ? value : null;
}

export function utilityDockGroupDragId(
  event: Pick<DragEvent, "dataTransfer">,
): UtilityDockTab | null {
  const value = event.dataTransfer?.getData(UTILITY_DOCK_GROUP_MIME);
  return isUtilityDockTab(value) ? value : null;
}

export function useUtilityDockViewLayout(available: readonly UtilityDockTab[]) {
  const availableKey = available.join("\0");
  const [storedGroups, setStoredGroups] = useState<UtilityDockViewGroup[]>(() =>
    normalizeUtilityDockViewGroups(readStoredGroups(), available));
  const groups = useMemo(
    () => normalizeUtilityDockViewGroups(storedGroups, available),
    [availableKey, storedGroups],
  );
  const moveGroup = useCallback((
    sourceRoot: UtilityDockTab,
    targetRoot: UtilityDockTab,
    placement: "before" | "after",
  ) => {
    setStoredGroups((current) => {
      const next = moveUtilityDockViewGroup(
        normalizeUtilityDockViewGroups(current, available),
        sourceRoot,
        targetRoot,
        placement,
      );
      persistGroups(next);
      return next;
    });
  }, [availableKey]);
  const moveView = useCallback((
    sourceId: UtilityDockTab,
    targetId: UtilityDockTab,
    placement: UtilityDockViewPlacement,
  ) => {
    setStoredGroups((current) => {
      const next = moveUtilityDockView(
        normalizeUtilityDockViewGroups(current, available),
        sourceId,
        targetId,
        placement,
      );
      persistGroups(next);
      return next;
    });
  }, [availableKey]);
  const getViewDragProps = useCallback((id: UtilityDockTab): HTMLAttributes<HTMLElement> => ({
    draggable: true,
    onDragStart: (event) => {
      const dragEvent = event as ReactDragEvent<HTMLElement>;
      dragEvent.dataTransfer.effectAllowed = "move";
      dragEvent.dataTransfer.setData(UTILITY_DOCK_VIEW_MIME, id);
      dragEvent.dataTransfer.setData("text/plain", id);
    },
  }), []);
  return { groups, moveGroup, moveView, getViewDragProps };
}
