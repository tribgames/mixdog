import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { type LucideIcon } from "lucide-react";
import {
  DESKTOP_SIDEBAR_DEFAULT_WIDTH,
  DESKTOP_SIDEBAR_MIN_WIDTH,
  DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH,
  DESKTOP_UTILITY_DOCK_MIN_WIDTH,
} from "../shared/window-layout";
import type { SidebarPanelKey } from "./app-shell-components";
import type { UtilityDockTab } from "./UtilityDock";
import { t } from "./i18n";

export type WorkbenchSide = "left" | "right";
export type WorkbenchSideViewId = "sessions" | SidebarPanelKey | UtilityDockTab;
export type WorkbenchSideViewGroup = readonly WorkbenchSideViewId[];
export type WorkbenchSideTitleDragProps = {
  draggable: true;
  onDragStart(event: ReactDragEvent<HTMLElement>): void;
  onDragEnd(): void;
};
export type WorkbenchSideViewPlacement =
  | "before"
  | "after"
  | "inside"
  | "inside-before"
  | "inside-after";
export type WorkbenchSideViewLayout = Readonly<Record<
  WorkbenchSide,
  readonly WorkbenchSideViewGroup[]
>>;

export const WORKBENCH_SIDE_VIEW_MIME = "application/x-mixdog-side-view";
export const WORKBENCH_SIDE_GROUP_MIME = "application/x-mixdog-side-group";
const WORKBENCH_SIDE_LAYOUT_KEY = "mixdog.desktop.workbench-side-view-layout.v1";
const UTILITIES_RIGHT_MIGRATION_KEY =
  "mixdog.desktop.workbench-side-view-layout.utilities-right.v1";
const UTILITIES_FOURTH_MIGRATION_KEY =
  "mixdog.desktop.workbench-side-view-layout.utilities-fourth.v1";
const ALL_VIEW_IDS: readonly WorkbenchSideViewId[] = [
  "sessions",
  "projects",
  "workflows",
  "extensions",
  "schedules",
  "webhooks",
  "utilities",
  "agents",
  "search",
  "source-control",
  "pull-requests",
];

export const DEFAULT_WORKBENCH_SIDE_VIEW_LAYOUT: WorkbenchSideViewLayout = {
  left: [
    ["sessions"],
    ["projects"],
    ["workflows"],
    ["extensions"],
    ["schedules"],
    ["webhooks"],
  ],
  // Utilities sits FOURTH on the right (user: 오른쪽 사이드 탭에 유틸리티를
  // 네 번째로): the working tabs take the leading slots a phone reaches first,
  // and with pull-requests disabled Utilities lands on the trailing icon.
  right: [["agents"], ["search"], ["source-control"], ["utilities"], ["pull-requests"]],
};

function isViewId(value: unknown): value is WorkbenchSideViewId {
  return ALL_VIEW_IDS.includes(value as WorkbenchSideViewId);
}

/**
 * Where a view the stored layout never carried belongs: ahead of the first
 * group that already holds a default view following it. A side stored before
 * those views existed (a phone that only ever persisted Utilities) therefore
 * rebuilds in DEFAULT order instead of collecting every missing view behind
 * whatever it happened to store.
 */
function defaultSlotIndex(
  groups: readonly WorkbenchSideViewGroup[],
  defaultOrder: readonly WorkbenchSideViewId[],
  id: WorkbenchSideViewId,
): number {
  const rank = defaultOrder.indexOf(id);
  const index = groups.findIndex((group) =>
    group.some((member) => defaultOrder.indexOf(member) > rank));
  return index < 0 ? groups.length : index;
}

export function normalizeWorkbenchSideViewLayout(
  value: unknown,
  available: readonly WorkbenchSideViewId[] = ALL_VIEW_IDS,
): WorkbenchSideViewLayout {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const allowed = new Set(available);
  const seen = new Set<WorkbenchSideViewId>();
  const normalizeSide = (side: WorkbenchSide): WorkbenchSideViewId[][] => {
    const groups: WorkbenchSideViewId[][] = [];
    const rawGroups = Array.isArray(record[side]) ? record[side] : [];
    for (const rawGroup of rawGroups) {
      if (!Array.isArray(rawGroup)) continue;
      const group: WorkbenchSideViewId[] = [];
      for (const id of rawGroup) {
        if (!isViewId(id) || !allowed.has(id) || seen.has(id)) continue;
        seen.add(id);
        group.push(id);
      }
      if (group.length) groups.push(group);
    }
    return groups;
  };
  const left = normalizeSide("left");
  const right = normalizeSide("right");
  for (const side of ["left", "right"] as const) {
    const defaultOrder: WorkbenchSideViewId[] = [];
    for (const group of DEFAULT_WORKBENCH_SIDE_VIEW_LAYOUT[side]) defaultOrder.push(...group);
    const target = side === "left" ? left : right;
    for (const id of defaultOrder) {
      if (!allowed.has(id) || seen.has(id)) continue;
      target.splice(defaultSlotIndex(target, defaultOrder, id), 0, [id]);
      seen.add(id);
    }
  }
  return { left, right };
}

function mutableLayout(layout: WorkbenchSideViewLayout): {
  left: WorkbenchSideViewId[][];
  right: WorkbenchSideViewId[][];
} {
  return {
    left: layout.left.map((group) => [...group]),
    right: layout.right.map((group) => [...group]),
  };
}

function locateGroup(
  layout: WorkbenchSideViewLayout,
  id: WorkbenchSideViewId,
): { side: WorkbenchSide; index: number } | null {
  for (const side of ["left", "right"] as const) {
    const index = layout[side].findIndex((group) => group.includes(id));
    if (index >= 0) return { side, index };
  }
  return null;
}

export function moveWorkbenchSideGroup(
  layout: WorkbenchSideViewLayout,
  sourceRoot: WorkbenchSideViewId,
  targetSide: WorkbenchSide,
  targetRoot: WorkbenchSideViewId | null,
  placement: WorkbenchSideViewPlacement,
): WorkbenchSideViewLayout {
  const source = locateGroup(layout, sourceRoot);
  if (!source || layout[source.side][source.index][0] !== sourceRoot) return layout;
  if (targetRoot && layout[source.side][source.index].includes(targetRoot)) return layout;
  const next = mutableLayout(layout);
  const [sourceGroup] = next[source.side].splice(source.index, 1);
  if (!targetRoot) {
    next[targetSide].push(sourceGroup);
    return next;
  }
  const targetIndex = next[targetSide].findIndex((group) => group.includes(targetRoot));
  if (targetIndex < 0) {
    next[targetSide].push(sourceGroup);
    return next;
  }
  if (placement === "inside"
    || placement === "inside-before"
    || placement === "inside-after") {
    const targetGroup = next[targetSide][targetIndex];
    const targetViewIndex = targetGroup.indexOf(targetRoot);
    const insertIndex = placement === "inside-before"
      ? targetViewIndex
      : targetViewIndex + 1;
    targetGroup.splice(insertIndex, 0, ...sourceGroup);
  } else {
    next[targetSide].splice(targetIndex + (placement === "after" ? 1 : 0), 0, sourceGroup);
  }
  return next;
}

export function moveWorkbenchSideView(
  layout: WorkbenchSideViewLayout,
  sourceId: WorkbenchSideViewId,
  targetSide: WorkbenchSide,
  targetRoot: WorkbenchSideViewId | null,
  placement: WorkbenchSideViewPlacement,
): WorkbenchSideViewLayout {
  const source = locateGroup(layout, sourceId);
  if (!source) return layout;
  if (targetRoot === sourceId) return layout;
  const next = mutableLayout(layout);
  next[source.side][source.index] = next[source.side][source.index]
    .filter((id) => id !== sourceId);
  if (next[source.side][source.index].length === 0) next[source.side].splice(source.index, 1);
  if (!targetRoot) {
    next[targetSide].push([sourceId]);
    return next;
  }
  const targetIndex = next[targetSide].findIndex((group) => group.includes(targetRoot));
  if (targetIndex < 0) {
    next[targetSide].push([sourceId]);
    return next;
  }
  if (placement === "inside"
    || placement === "inside-before"
    || placement === "inside-after") {
    const targetGroup = next[targetSide][targetIndex];
    const targetViewIndex = targetGroup.indexOf(targetRoot);
    const insertIndex = placement === "inside-before"
      ? targetViewIndex
      : targetViewIndex + 1;
    targetGroup.splice(insertIndex, 0, sourceId);
  } else {
    next[targetSide].splice(targetIndex + (placement === "after" ? 1 : 0), 0, [sourceId]);
  }
  return next;
}

/**
 * First active view per side: ALWAYS the leading group (user: 좌·우·하단 도크
 * 전부 첫 메뉴로 초기화). No last-visited view survives a reload — the dock tab
 * and the bottom panel drop their persisted selection for the same reason — so
 * every reconnect lands on one predictable entry point per edge. A side that
 * holds nothing has no active view.
 */
export function initialActiveWorkbenchSideViews(
  layout: WorkbenchSideViewLayout,
): Record<WorkbenchSide, WorkbenchSideViewId | null> {
  return {
    left: layout.left[0]?.[0] ?? null,
    right: layout.right[0]?.[0] ?? null,
  };
}

/** Fourth slot, clamped to the end of a shorter right side. */
const UTILITIES_RIGHT_INDEX = 3;

function insertUtilitiesRightGroup(right: readonly unknown[]): unknown[] {
  const next = [...right];
  next.splice(Math.min(UTILITIES_RIGHT_INDEX, next.length), 0, ["utilities"]);
  return next;
}

export function migrateDefaultUtilitiesToRight(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const left = Array.isArray(record.left) ? record.left : [];
  const right = Array.isArray(record.right) ? record.right : [];
  const utilityIndex = left.findIndex((group) =>
    Array.isArray(group) && group.length === 1 && group[0] === "utilities");
  const alreadyRight = right.some((group) =>
    Array.isArray(group) && group.includes("utilities"));
  if (utilityIndex < 0 || alreadyRight) return value;
  return {
    ...record,
    left: left.filter((_, index) => index !== utilityIndex),
    right: insertUtilitiesRightGroup(right),
  };
}

/**
 * Installs that already moved Utilities to the right kept it in the LEADING
 * slot, so the new default alone would never reach them. One shot re-seats that
 * exact shape to the fourth position; a right side that does not START with the
 * Utilities singleton was arranged by hand and is left untouched.
 */
export function migrateLeadingUtilitiesToFourth(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const right = Array.isArray(record.right) ? record.right : [];
  const leading = right[0];
  if (!Array.isArray(leading) || leading.length !== 1 || leading[0] !== "utilities") {
    return value;
  }
  return { ...record, right: insertUtilitiesRightGroup(right.slice(1)) };
}

function readLayout(): unknown {
  try {
    let value: unknown = JSON.parse(
      window.localStorage.getItem(WORKBENCH_SIDE_LAYOUT_KEY) || "null",
    );
    let migrated = false;
    if (window.localStorage.getItem(UTILITIES_RIGHT_MIGRATION_KEY) !== "1") {
      value = migrateDefaultUtilitiesToRight(value);
      window.localStorage.setItem(UTILITIES_RIGHT_MIGRATION_KEY, "1");
      migrated = true;
    }
    if (window.localStorage.getItem(UTILITIES_FOURTH_MIGRATION_KEY) !== "1") {
      value = migrateLeadingUtilitiesToFourth(value);
      window.localStorage.setItem(UTILITIES_FOURTH_MIGRATION_KEY, "1");
      migrated = true;
    }
    if (migrated) {
      window.localStorage.setItem(WORKBENCH_SIDE_LAYOUT_KEY, JSON.stringify(value));
    }
    return value;
  } catch {
    return null;
  }
}

function persistLayout(layout: WorkbenchSideViewLayout): void {
  try {
    window.localStorage.setItem(WORKBENCH_SIDE_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Layout remains active for this renderer session.
  }
}

export function useWorkbenchSideViewLayout(available: readonly WorkbenchSideViewId[]) {
  const availableKey = available.join("\0");
  const [stored, setStored] = useState<WorkbenchSideViewLayout>(() =>
    normalizeWorkbenchSideViewLayout(readLayout(), available));
  const layout = useMemo(
    () => normalizeWorkbenchSideViewLayout(stored, available),
    [availableKey, stored],
  );
  const commit = useCallback((update: (current: WorkbenchSideViewLayout) => WorkbenchSideViewLayout) => {
    setStored((current) => {
      const next = update(normalizeWorkbenchSideViewLayout(current, available));
      persistLayout(next);
      return next;
    });
  }, [availableKey]);
  const moveGroup = useCallback((
    sourceRoot: WorkbenchSideViewId,
    targetSide: WorkbenchSide,
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement,
  ) => commit((current) =>
    moveWorkbenchSideGroup(current, sourceRoot, targetSide, targetRoot, placement)), [commit]);
  const moveView = useCallback((
    sourceId: WorkbenchSideViewId,
    targetSide: WorkbenchSide,
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement,
  ) => commit((current) =>
    moveWorkbenchSideView(current, sourceId, targetSide, targetRoot, placement)), [commit]);
  const sideOf = useCallback((id: WorkbenchSideViewId): WorkbenchSide =>
    locateGroup(layout, id)?.side ?? "left", [layout]);
  const groupFor = useCallback((id: WorkbenchSideViewId): WorkbenchSideViewGroup =>
    layout.left.find((group) => group.includes(id))
      ?? layout.right.find((group) => group.includes(id))
      ?? [id], [layout]);
  return { layout, moveGroup, moveView, sideOf, groupFor };
}

export interface WorkbenchSideViewDescriptor {
  id: WorkbenchSideViewId;
  label: string;
  tooltip?: string;
  icon: LucideIcon;
  onPrefetch?(): void;
}

type WorkbenchSideDragPayload = {
  type: "group" | "view";
  id: WorkbenchSideViewId;
};

let activeWorkbenchSideDrag: WorkbenchSideDragPayload | null = null;

function dragPayload(event: ReactDragEvent<HTMLElement>): WorkbenchSideDragPayload | null {
  const group = event.dataTransfer.getData(WORKBENCH_SIDE_GROUP_MIME);
  if (isViewId(group)) return { type: "group", id: group };
  const view = event.dataTransfer.getData(WORKBENCH_SIDE_VIEW_MIME);
  return isViewId(view) ? { type: "view", id: view } : activeWorkbenchSideDrag;
}

function setWorkbenchSideIconDragImage(event: ReactDragEvent<HTMLButtonElement>): void {
  const dragImage = event.currentTarget.cloneNode(true) as HTMLButtonElement;
  const bounds = event.currentTarget.getBoundingClientRect();
  dragImage.className = "workbench-side-icon-drag-image";
  dragImage.removeAttribute("aria-current");
  dragImage.removeAttribute("data-drop-position");
  dragImage.style.width = `${bounds.width}px`;
  dragImage.style.height = `${bounds.height}px`;
  document.body.append(dragImage);
  event.dataTransfer.setDragImage(dragImage, 0, 0);
  window.setTimeout(() => dragImage.remove(), 0);
}

export function workbenchSidePaneDropSlot(
  paneCenters: readonly number[],
  pointerY: number,
): number {
  let slot = 0;
  while (slot < paneCenters.length && pointerY >= paneCenters[slot]) slot++;
  return slot;
}

export function workbenchSidePaneDropIsNoop(
  group: readonly WorkbenchSideViewId[],
  sourceType: "group" | "view",
  sourceId: WorkbenchSideViewId,
  slot: number,
): boolean {
  if (sourceType === "group") return group.includes(sourceId);
  const sourceIndex = group.indexOf(sourceId);
  return sourceIndex >= 0 && (slot === sourceIndex || slot === sourceIndex + 1);
}

export function workbenchSideBarDropPlacement(
  point: number,
  previous: "before" | "after" | null,
): "before" | "after" {
  if (point <= .4) return "before";
  if (point > .6) return "after";
  return previous ?? (point <= .5 ? "before" : "after");
}

export function WorkbenchSideIconBar({
  side,
  groups,
  activeRoot,
  descriptors,
  orientation,
  onSelect,
  onMoveGroup,
  onMoveView,
}: {
  side: WorkbenchSide;
  groups: readonly WorkbenchSideViewGroup[];
  activeRoot: WorkbenchSideViewId | null;
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  orientation: "vertical" | "horizontal";
  onSelect(id: WorkbenchSideViewId): void;
  onMoveGroup(
    sourceRoot: WorkbenchSideViewId,
    targetSide: WorkbenchSide,
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement,
  ): void;
  onMoveView(
    sourceId: WorkbenchSideViewId,
    targetSide: WorkbenchSide,
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement,
  ): void;
}) {
  const [drop, setDrop] = useState<{
    root: WorkbenchSideViewId;
    placement: WorkbenchSideViewPlacement;
  } | null>(null);
  return <div className={`workbench-side-icon-bar is-${orientation}`}
    role="navigation"
    aria-label={t(side === "left" ? "Sidebar" : "Utility panel tabs")}
    onDragOver={(event) => {
      if (!groups.length && (
        Array.from(event.dataTransfer.types).includes(WORKBENCH_SIDE_GROUP_MIME)
        || Array.from(event.dataTransfer.types).includes(WORKBENCH_SIDE_VIEW_MIME)
      )) event.preventDefault();
    }}
    onDrop={(event) => {
      if (groups.length) return;
      event.preventDefault();
      const payload = dragPayload(event);
      if (payload?.type === "group") onMoveGroup(payload.id, side, null, "after");
      if (payload?.type === "view") onMoveView(payload.id, side, null, "after");
    }}>
    {groups.map((group) => {
      const root = group[0];
      const descriptor = descriptors.get(root);
      if (!descriptor) return null;
      const Icon = descriptor.icon;
      const active = activeRoot !== null && group.includes(activeRoot);
      return <button key={root} type="button"
        className={active ? "active selected" : ""}
        aria-label={t(descriptor.label)}
        aria-current={active ? "page" : undefined}
        data-tooltip={t(descriptor.tooltip || descriptor.label)}
        data-drop-position={drop?.root === root ? drop.placement : undefined}
        draggable
        onPointerEnter={descriptor.onPrefetch}
        onFocus={descriptor.onPrefetch}
        onPointerDown={(event) => {
          if (event.button === 0) descriptor.onPrefetch?.();
        }}
        onDragStart={(event) => {
          activeWorkbenchSideDrag = { type: "group", id: root };
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(WORKBENCH_SIDE_GROUP_MIME, root);
          event.dataTransfer.setData("text/plain", root);
          setWorkbenchSideIconDragImage(event);
        }}
        onDragOver={(event) => {
          const types = Array.from(event.dataTransfer.types);
          const groupDrag = types.includes(WORKBENCH_SIDE_GROUP_MIME);
          const viewDrag = types.includes(WORKBENCH_SIDE_VIEW_MIME);
          if (!groupDrag && !viewDrag) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const bounds = event.currentTarget.getBoundingClientRect();
          const point = orientation === "vertical"
            ? (event.clientY - bounds.top) / Math.max(1, bounds.height)
            : (event.clientX - bounds.left) / Math.max(1, bounds.width);
          setDrop((current) => ({
            root,
            placement: workbenchSideBarDropPlacement(
              point,
              current?.root === root ? current.placement as "before" | "after" : null,
            ),
          }));
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDrop((current) => current?.root === root ? null : current);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          const payload = dragPayload(event);
          const placement = drop?.root === root ? drop.placement : "inside";
          if (payload?.type === "group") onMoveGroup(payload.id, side, root, placement);
          if (payload?.type === "view") onMoveView(payload.id, side, root, placement);
          setDrop(null);
          if (placement === "inside") onSelect(root);
        }}
        onDragEnd={() => {
          activeWorkbenchSideDrag = null;
          setDrop(null);
        }}
        onClick={() => onSelect(root)}>
        <Icon size={orientation === "vertical" ? 24 : 18} aria-hidden="true" />
      </button>;
    })}
  </div>;
}

function WorkbenchSideSection({
  id,
  active,
  sectioned,
  order,
  basis,
  children,
}: {
  id: WorkbenchSideViewId;
  active: boolean;
  sectioned: boolean;
  order: number;
  basis: number;
  children(
    active: boolean,
    titleDragProps: WorkbenchSideTitleDragProps,
  ): ReactNode;
}) {
  const titleDragProps: WorkbenchSideTitleDragProps = {
    draggable: true,
    onDragStart: (event) => {
      activeWorkbenchSideDrag = { type: "view", id };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(WORKBENCH_SIDE_VIEW_MIME, id);
      event.dataTransfer.setData("text/plain", id);
      event.dataTransfer.setDragImage(event.currentTarget, 0, 0);
    },
    onDragEnd: () => {
      activeWorkbenchSideDrag = null;
    },
  };
  return <section className="workbench-side-section"
    style={{
      order,
      "--workbench-side-section-basis": `${basis}%`,
    } as React.CSSProperties}
    data-sectioned={sectioned ? "true" : "false"}>
    <div className="workbench-side-section-body">
      {children(active, titleDragProps)}
    </div>
  </section>;
}

const SIDE_PANEL_WIDTH_KEY: Record<WorkbenchSide, string> = {
  left: "mixdog:session-sidebar-width",
  right: "mixdog.desktop-utility-dock-width.v1",
};
const SIDE_PANEL_MIN_WIDTH: Record<WorkbenchSide, number> = {
  left: DESKTOP_SIDEBAR_MIN_WIDTH,
  right: DESKTOP_UTILITY_DOCK_MIN_WIDTH,
};
const SIDE_PANEL_DEFAULT_WIDTH: Record<WorkbenchSide, number> = {
  left: DESKTOP_SIDEBAR_DEFAULT_WIDTH,
  right: DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH,
};
const SIDE_PANEL_MAX_WIDTH: Record<WorkbenchSide, number> = {
  left: 420,
  right: 560,
};

export function normalizeSideSplitSizes(value: unknown, count: number): number[] {
  if (count <= 0) return [];
  const equal = Array.from({ length: count }, () => 100 / count);
  if (!Array.isArray(value) || value.length !== count) return equal;
  const sizes = value.map(Number);
  if (sizes.some((size) => !Number.isFinite(size) || size <= 0)) return equal;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return equal;
  return sizes.map((size) => size / total * 100);
}

export function resizeSideSplitSizes(
  sizes: readonly number[],
  index: number,
  deltaPx: number,
  totalPx: number,
  minPx = 96,
): number[] {
  if (index < 0 || index >= sizes.length - 1 || totalPx <= 0) return [...sizes];
  const next = normalizeSideSplitSizes(sizes, sizes.length);
  const firstPx = next[index] / 100 * totalPx;
  const secondPx = next[index + 1] / 100 * totalPx;
  const pairPx = firstPx + secondPx;
  const appliedMin = Math.min(minPx, pairPx / 2);
  const resizedFirst = Math.max(appliedMin, Math.min(pairPx - appliedMin, firstPx + deltaPx));
  next[index] = resizedFirst / totalPx * 100;
  next[index + 1] = (pairPx - resizedFirst) / totalPx * 100;
  return next;
}

function readSideSplitSizes(key: string, count: number): number[] {
  try {
    return normalizeSideSplitSizes(
      JSON.parse(window.localStorage.getItem(key) || "null"),
      count,
    );
  } catch {
    return normalizeSideSplitSizes(null, count);
  }
}

export function nextRetainedWorkbenchSideRoots(
  groups: readonly WorkbenchSideViewGroup[],
  current: readonly WorkbenchSideViewId[],
  activeRoot: WorkbenchSideViewId | null,
): WorkbenchSideViewId[] {
  const retained = new Set(current);
  const selectedRoot = groups.find((group) =>
    activeRoot !== null && group.includes(activeRoot))?.[0] ?? groups[0]?.[0];
  if (selectedRoot) retained.add(selectedRoot);
  return groups
    .map((group) => group[0])
    .filter((root): root is WorkbenchSideViewId => Boolean(root) && retained.has(root));
}

export function WorkbenchSidePanel({
  side,
  open,
  motion = "animated",
  groups,
  activeRoot,
  descriptors,
  onSelect,
  onMoveGroup,
  onMoveView,
  renderView,
}: {
  side: WorkbenchSide;
  open: boolean;
  /** Narrow-band sheets slide; a responsive fold applies its state instantly. */
  motion?: "animated" | "instant";
  groups: readonly WorkbenchSideViewGroup[];
  activeRoot: WorkbenchSideViewId | null;
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  onSelect(id: WorkbenchSideViewId): void;
  onMoveGroup: Parameters<typeof WorkbenchSideIconBar>[0]["onMoveGroup"];
  onMoveView: Parameters<typeof WorkbenchSideIconBar>[0]["onMoveView"];
  renderView(
    id: WorkbenchSideViewId,
    active: boolean,
    titleDragProps: WorkbenchSideTitleDragProps,
  ): ReactNode;
}) {
  const selectedGroup = groups.find((group) =>
    activeRoot !== null && group.includes(activeRoot)) ?? groups[0] ?? [];
  const root = selectedGroup[0] ?? null;
  const [retainedRoots, setRetainedRoots] = useState<readonly WorkbenchSideViewId[]>([]);
  useEffect(() => {
    setRetainedRoots((current) => {
      const next = nextRetainedWorkbenchSideRoots(groups, current, activeRoot);
      return next.length === current.length
        && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [activeRoot, groups]);
  // Idle pre-retain (user: 메뉴 이동할 때 깜빡 — 바로바로 나오게): shortly
  // after the panel settles, EVERY destination hidden-mounts, so the first
  // visit to each menu swaps attributes on a live tree instead of mounting
  // from scratch and flashing an empty frame.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setRetainedRoots((current) => {
        const next = groups
          .map((group) => group[0])
          .filter((rootId): rootId is WorkbenchSideViewId => Boolean(rootId));
        return next.length === current.length
          && next.every((id, index) => id === current[index]) ? current : next;
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [groups]);
  const retainedGroups = groups.filter((group) =>
    group[0] !== root && retainedRoots.includes(group[0]));
  const splitKey = `mixdog.desktop.side-view-split.${side}.${selectedGroup.join("+")}.v1`;
  const [splitSizesByKey, setSplitSizesByKey] = useState<Record<string, number[]>>({});
  const splitSizes = splitSizesByKey[splitKey]
    ?? readSideSplitSizes(splitKey, selectedGroup.length);
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(SIDE_PANEL_WIDTH_KEY[side]));
      return Number.isFinite(stored) && stored > 0
        ? Math.max(SIDE_PANEL_MIN_WIDTH[side], Math.min(SIDE_PANEL_MAX_WIDTH[side], stored))
        : SIDE_PANEL_DEFAULT_WIDTH[side];
    } catch {
      return SIDE_PANEL_DEFAULT_WIDTH[side];
    }
  });
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const panelBodyRef = useRef<HTMLDivElement | null>(null);
  const [paneDrop, setPaneDrop] = useState<{
    targetRoot: WorkbenchSideViewId;
    placement: "inside-before" | "inside-after";
    slot: number;
    top: number;
    height: number;
    boundary: number;
  } | null>(null);
  const splitCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => splitCleanupRef.current?.(), []);
  const startSplitResize = (
    index: number,
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    const body = panelBodyRef.current;
    if (!body) return;
    splitCleanupRef.current?.();
    const startY = event.clientY;
    const totalPx = Math.max(1, body.clientHeight);
    const startSizes = [...splitSizes];
    let pending = startSizes;
    const move = (moveEvent: PointerEvent) => {
      pending = resizeSideSplitSizes(
        startSizes,
        index,
        moveEvent.clientY - startY,
        totalPx,
      );
      setSplitSizesByKey((current) => ({ ...current, [splitKey]: pending }));
    };
    let cleaned = false;
    const cleanup = (commit: boolean) => {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      if (commit) {
        try { window.localStorage.setItem(splitKey, JSON.stringify(pending)); }
        catch { /* split ratio remains active for this renderer */ }
      }
      if (splitCleanupRef.current === cancel) splitCleanupRef.current = null;
    };
    const stop = () => cleanup(true);
    const cancel = () => cleanup(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    splitCleanupRef.current = cancel;
    event.preventDefault();
  };
  if (!root || groups.length === 0) return null;
  const sectioned = selectedGroup.length > 1;
  return <aside className="workbench-side-panel"
    data-side={side}
    data-motion={motion}
    hidden={!open}
    aria-hidden={open ? undefined : true}
    inert={open ? undefined : true}
    style={{
      "--workbench-side-panel-width": `${width}px`,
      "--workbench-side-panel-min-width": `${SIDE_PANEL_MIN_WIDTH[side]}px`,
      "--workbench-side-panel-max-width": `${SIDE_PANEL_MAX_WIDTH[side]}px`,
    } as React.CSSProperties}>
    <div className="workbench-side-panel-resize" role="separator"
      aria-orientation="vertical"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        resizeStart.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = resizeStart.current;
        if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const delta = side === "left" ? event.clientX - start.x : start.x - event.clientX;
        setWidth(Math.max(
          SIDE_PANEL_MIN_WIDTH[side],
          Math.min(SIDE_PANEL_MAX_WIDTH[side], Math.round(start.width + delta)),
        ));
      }}
      onPointerUp={(event) => {
        if (!resizeStart.current) return;
        resizeStart.current = null;
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
        try { window.localStorage.setItem(SIDE_PANEL_WIDTH_KEY[side], String(width)); } catch {}
      }} />
    <div className="workbench-side-panel-content">
    {side === "right" && <header className="workbench-side-panel-tabs">
      <WorkbenchSideIconBar side="right" groups={groups}
        activeRoot={root} descriptors={descriptors} orientation="horizontal"
        onSelect={onSelect} onMoveGroup={onMoveGroup} onMoveView={onMoveView} />
    </header>}
    <div key={root} className="workbench-side-panel-body" ref={panelBodyRef}
      onDragOver={(event) => {
        const types = Array.from(event.dataTransfer.types);
        if (!types.includes(WORKBENCH_SIDE_GROUP_MIME)
          && !types.includes(WORKBENCH_SIDE_VIEW_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const payload = dragPayload(event);
        const body = panelBodyRef.current;
        if (!payload || !body) {
          setPaneDrop(null);
          return;
        }
        const panes = Array.from(body.children)
          .filter((child): child is HTMLElement =>
            child instanceof HTMLElement && child.classList.contains("workbench-side-section"));
        if (panes.length !== selectedGroup.length) {
          setPaneDrop(null);
          return;
        }
        const bodyBounds = body.getBoundingClientRect();
        const paneBounds = panes.map((pane) => pane.getBoundingClientRect());
        const centers = paneBounds.map((bounds) => (bounds.top + bounds.bottom) / 2);
        const slot = workbenchSidePaneDropSlot(centers, event.clientY);
        if (workbenchSidePaneDropIsNoop(
          selectedGroup,
          payload.type,
          payload.id,
          slot,
        )) {
          setPaneDrop(null);
          return;
        }
        const edges = [bodyBounds.top, ...centers, bodyBounds.bottom];
        const boundaries = [
          paneBounds[0].top,
          ...paneBounds.slice(0, -1).map((bounds, index) =>
            (bounds.bottom + paneBounds[index + 1].top) / 2),
          paneBounds[paneBounds.length - 1].bottom,
        ];
        const top = Math.max(0, edges[slot] - bodyBounds.top);
        const height = Math.max(1, edges[slot + 1] - edges[slot]);
        setPaneDrop({
          targetRoot: slot === 0 ? selectedGroup[0] : selectedGroup[slot - 1],
          placement: slot === 0 ? "inside-before" : "inside-after",
          slot,
          top,
          height,
          boundary: Math.max(0, Math.min(
            Math.max(0, height - 2),
            boundaries[slot] - bodyBounds.top - top,
          )),
        });
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPaneDrop(null);
        }
      }}
      onDrop={(event) => {
        if (!paneDrop) return;
        const payload = dragPayload(event);
        if (!payload) {
          setPaneDrop(null);
          return;
        }
        event.preventDefault();
        if (payload.type === "group") {
          onMoveGroup(payload.id, side, paneDrop.targetRoot, paneDrop.placement);
        } else {
          onMoveView(payload.id, side, paneDrop.targetRoot, paneDrop.placement);
        }
        activeWorkbenchSideDrag = null;
        setPaneDrop(null);
      }}>
      {paneDrop && <div className="workbench-side-pane-drop-overlay"
        data-drop-slot={paneDrop.slot}
        style={{ top: paneDrop.top, height: paneDrop.height }}>
        <span style={{ top: paneDrop.boundary }} />
      </div>}
      {selectedGroup.map((id, index) => {
        const descriptor = descriptors.get(id);
        if (!descriptor) return null;
        return <Fragment key={id}>
          <WorkbenchSideSection id={id} active={open}
            sectioned={sectioned} order={index * 2}
            basis={splitSizes[index] ?? 100 / selectedGroup.length}>
            {(active, titleDragProps) => renderView(id, active, titleDragProps)}
          </WorkbenchSideSection>
          {index < selectedGroup.length - 1 &&
            <div className="workbench-side-sash" role="separator"
              aria-orientation="horizontal"
              aria-label={t("Resize combined views")}
              style={{ order: index * 2 + 1 }}
              onPointerDown={(event) => startSplitResize(index, event)} />}
        </Fragment>;
      })}
    </div>
    {retainedGroups.map((group) => {
      const retainedRoot = group[0];
      const retainedSplitKey =
        `mixdog.desktop.side-view-split.${side}.${group.join("+")}.v1`;
      const retainedSizes = splitSizesByKey[retainedSplitKey]
        ?? readSideSplitSizes(retainedSplitKey, group.length);
      return <div key={retainedRoot} className="workbench-side-panel-body"
        hidden inert aria-hidden="true">
        {group.map((id, index) => descriptors.has(id)
          ? <WorkbenchSideSection key={id} id={id} active={false}
              sectioned={group.length > 1} order={index * 2}
              basis={retainedSizes[index] ?? 100 / group.length}>
              {(active, titleDragProps) => renderView(id, active, titleDragProps)}
            </WorkbenchSideSection>
          : null)}
      </div>;
    })}
    </div>
  </aside>;
}
