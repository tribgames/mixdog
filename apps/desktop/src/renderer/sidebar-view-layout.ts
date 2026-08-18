import {
  useCallback,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type HTMLAttributes,
} from "react";
import type { SidebarPanelKey } from "./app-shell-components";

const SIDEBAR_VIEW_LAYOUT_KEY = "mixdog.desktop.sidebar-view-layout.v1";
export const SIDEBAR_VIEW_MIME = "application/x-mixdog-sidebar-view";
export const SIDEBAR_GROUP_MIME = "application/x-mixdog-sidebar-group";

export type SidebarViewGroup = readonly SidebarPanelKey[];
export type SidebarViewPlacement = "before" | "after" | "inside";

export const DEFAULT_SIDEBAR_VIEW_ORDER: readonly SidebarPanelKey[] = [
  "projects",
  "workflows",
  "schedules",
  "webhooks",
  "utilities",
];

function isSidebarPanelKey(value: unknown): value is SidebarPanelKey {
  return DEFAULT_SIDEBAR_VIEW_ORDER.includes(value as SidebarPanelKey);
}

export function normalizeSidebarViewGroups(
  value: unknown,
  available: readonly SidebarPanelKey[] = DEFAULT_SIDEBAR_VIEW_ORDER,
): SidebarViewGroup[] {
  const allowed = new Set(available);
  const seen = new Set<SidebarPanelKey>();
  const groups: SidebarPanelKey[][] = [];
  if (Array.isArray(value)) {
    for (const rawGroup of value) {
      if (!Array.isArray(rawGroup)) continue;
      const group: SidebarPanelKey[] = [];
      for (const id of rawGroup) {
        if (!isSidebarPanelKey(id) || !allowed.has(id) || seen.has(id)) continue;
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

function withoutEmpty(groups: readonly SidebarViewGroup[]): SidebarPanelKey[][] {
  return groups.map((group) => [...group]).filter((group) => group.length > 0);
}

export function moveSidebarViewGroup(
  groups: readonly SidebarViewGroup[],
  sourceRoot: SidebarPanelKey,
  targetRoot: SidebarPanelKey,
  placement: Exclude<SidebarViewPlacement, "inside">,
): SidebarViewGroup[] {
  const next = withoutEmpty(groups);
  const sourceIndex = next.findIndex((group) => group[0] === sourceRoot);
  const targetIndex = next.findIndex((group) => group[0] === targetRoot);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return next;
  const [source] = next.splice(sourceIndex, 1);
  const adjustedTarget = next.findIndex((group) => group[0] === targetRoot);
  next.splice(adjustedTarget + (placement === "after" ? 1 : 0), 0, source);
  return next;
}

export function moveSidebarView(
  groups: readonly SidebarViewGroup[],
  sourceId: SidebarPanelKey,
  targetId: SidebarPanelKey,
  placement: SidebarViewPlacement,
): SidebarViewGroup[] {
  if (sourceId === targetId) return withoutEmpty(groups);
  const next = withoutEmpty(groups);
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
    const targetIndex = targetGroup.indexOf(targetId);
    targetGroup.splice(targetIndex + 1, 0, sourceId);
  } else {
    next.splice(
      currentTargetGroupIndex + (placement === "after" ? 1 : 0),
      0,
      [sourceId],
    );
  }
  return next;
}

function readStoredGroups(): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(SIDEBAR_VIEW_LAYOUT_KEY) || "null");
  } catch {
    return null;
  }
}

function persistGroups(groups: readonly SidebarViewGroup[]): void {
  try {
    window.localStorage.setItem(SIDEBAR_VIEW_LAYOUT_KEY, JSON.stringify(groups));
  } catch {
    // View customization remains available for the current renderer session.
  }
}

export function sidebarViewDragId(event: Pick<DragEvent, "dataTransfer">): SidebarPanelKey | null {
  const value = event.dataTransfer?.getData(SIDEBAR_VIEW_MIME);
  return isSidebarPanelKey(value) ? value : null;
}

export function sidebarGroupDragId(event: Pick<DragEvent, "dataTransfer">): SidebarPanelKey | null {
  const value = event.dataTransfer?.getData(SIDEBAR_GROUP_MIME);
  return isSidebarPanelKey(value) ? value : null;
}

export function useSidebarViewLayout(available: readonly SidebarPanelKey[]) {
  const availableKey = available.join("\0");
  const [storedGroups, setStoredGroups] = useState<SidebarViewGroup[]>(() =>
    normalizeSidebarViewGroups(readStoredGroups(), available));
  const groups = useMemo(
    () => normalizeSidebarViewGroups(storedGroups, available),
    [availableKey, storedGroups],
  );
  const commit = useCallback((next: SidebarViewGroup[]) => {
    setStoredGroups(next);
    persistGroups(next);
  }, []);
  const moveGroup = useCallback((
    sourceRoot: SidebarPanelKey,
    targetRoot: SidebarPanelKey,
    placement: "before" | "after",
  ) => {
    setStoredGroups((current) => {
      const next = moveSidebarViewGroup(
        normalizeSidebarViewGroups(current, available),
        sourceRoot,
        targetRoot,
        placement,
      );
      persistGroups(next);
      return next;
    });
  }, [availableKey]);
  const moveView = useCallback((
    sourceId: SidebarPanelKey,
    targetId: SidebarPanelKey,
    placement: SidebarViewPlacement,
  ) => {
    setStoredGroups((current) => {
      const next = moveSidebarView(
        normalizeSidebarViewGroups(current, available),
        sourceId,
        targetId,
        placement,
      );
      persistGroups(next);
      return next;
    });
  }, [availableKey]);
  const reset = useCallback(() => {
    const next = normalizeSidebarViewGroups(null, available);
    commit(next);
  }, [availableKey, commit]);
  const groupFor = useCallback((id: SidebarPanelKey): SidebarViewGroup =>
    groups.find((group) => group.includes(id)) ?? [id], [groups]);
  const getViewDragProps = useCallback((id: SidebarPanelKey): HTMLAttributes<HTMLElement> => ({
    draggable: true,
    onDragStart: (event) => {
      const dragEvent = event as ReactDragEvent<HTMLElement>;
      dragEvent.dataTransfer.effectAllowed = "move";
      dragEvent.dataTransfer.setData(SIDEBAR_VIEW_MIME, id);
      dragEvent.dataTransfer.setData("text/plain", id);
    },
  }), []);
  return { groups, groupFor, moveGroup, moveView, reset, getViewDragProps };
}
