import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  DESKTOP_SIDEBAR_DEFAULT_WIDTH,
  DESKTOP_SIDEBAR_MIN_WIDTH,
  DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH,
  DESKTOP_UTILITY_DOCK_MIN_WIDTH,
} from '../shared/window-layout';
import { t } from './i18n';
import { useDockIconVisibility } from './dock-icon-visibility';
import {
  isViewId,
  type WorkbenchSide,
  type WorkbenchSideTitleDragProps,
  type WorkbenchSideViewGroup,
  type WorkbenchSideViewId,
  type WorkbenchSideViewPlacement,
} from './workbench-side-view-model';
export {
  discardLayoutForPaneBoundRight,
  initialActiveWorkbenchSideViews,
  moveWorkbenchSideGroup,
  moveWorkbenchSideView,
  normalizeWorkbenchSideViewLayout,
  useWorkbenchSideViewLayout,
} from './workbench-side-view-model';
export type {
  WorkbenchSide,
  WorkbenchSideTitleDragProps,
  WorkbenchSideViewGroup,
  WorkbenchSideViewId,
  WorkbenchSideViewPlacement,
} from './workbench-side-view-model';

const WORKBENCH_SIDE_VIEW_MIME = 'application/x-mixdog-side-view';
const WORKBENCH_SIDE_GROUP_MIME = 'application/x-mixdog-side-group';

export interface WorkbenchSideViewDescriptor {
  id: WorkbenchSideViewId;
  label: string;
  /** Header title when it should read shorter than the capability name
   *  (user: 브라우저 유즈 → 브라우저 로 헤더 바꾸고). */
  title?: string;
  tooltip?: string;
  icon: LucideIcon;
  onPrefetch?(): void;
}

type WorkbenchSideDragPayload = {
  type: 'group' | 'view';
  id: WorkbenchSideViewId;
};

let activeWorkbenchSideDrag: WorkbenchSideDragPayload | null = null;

/** The drag carries a side group or view this layout can seat. */
function carriesSideDrag(event: ReactDragEvent<HTMLElement>): boolean {
  const types = Array.from(event.dataTransfer.types);
  return types.includes(WORKBENCH_SIDE_GROUP_MIME) || types.includes(WORKBENCH_SIDE_VIEW_MIME);
}

function dragPayload(event: ReactDragEvent<HTMLElement>): WorkbenchSideDragPayload | null {
  const group = event.dataTransfer.getData(WORKBENCH_SIDE_GROUP_MIME);
  if (isViewId(group)) return { type: 'group', id: group };
  const view = event.dataTransfer.getData(WORKBENCH_SIDE_VIEW_MIME);
  return isViewId(view) ? { type: 'view', id: view } : activeWorkbenchSideDrag;
}

export function setWorkbenchSideIconDragImage(event: ReactDragEvent<HTMLButtonElement>): void {
  const dragImage = event.currentTarget.cloneNode(true) as HTMLButtonElement;
  const bounds = event.currentTarget.getBoundingClientRect();
  dragImage.className = 'workbench-side-icon-drag-image';
  dragImage.removeAttribute('aria-current');
  dragImage.removeAttribute('data-drop-position');
  dragImage.style.width = `${bounds.width}px`;
  dragImage.style.height = `${bounds.height}px`;
  document.body.append(dragImage);
  event.dataTransfer.setDragImage(dragImage, 0, 0);
  window.setTimeout(() => dragImage.remove(), 0);
}

export function workbenchSidePaneDropSlot(paneCenters: readonly number[], pointerY: number): number {
  let slot = 0;
  while (slot < paneCenters.length && pointerY >= paneCenters[slot]) slot++;
  return slot;
}

export function workbenchSidePaneDropIsNoop(
  group: readonly WorkbenchSideViewId[],
  sourceType: 'group' | 'view',
  sourceId: WorkbenchSideViewId,
  slot: number
): boolean {
  if (sourceType === 'group') return group.includes(sourceId);
  const sourceIndex = group.indexOf(sourceId);
  return sourceIndex >= 0 && (slot === sourceIndex || slot === sourceIndex + 1);
}

export function workbenchSideBarDropPlacement(point: number, previous: 'before' | 'after' | null): 'before' | 'after' {
  if (point <= 0.4) return 'before';
  if (point > 0.6) return 'after';
  return previous ?? (point <= 0.5 ? 'before' : 'after');
}

export function workbenchSideBarDropTarget(
  items: readonly {
    root: WorkbenchSideViewId;
    start: number;
    end: number;
  }[],
  point: number,
  previous: {
    root: WorkbenchSideViewId;
    placement: 'before' | 'after';
  } | null
): {
  root: WorkbenchSideViewId;
  placement: 'before' | 'after';
} | null {
  const first = items[0];
  if (!first) return null;
  if (point <= first.start) return { root: first.root, placement: 'before' };
  const last = items[items.length - 1];
  if (point >= last.end) return { root: last.root, placement: 'after' };

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (point >= item.start && point <= item.end) {
      return {
        root: item.root,
        placement: workbenchSideBarDropPlacement(
          (point - item.start) / Math.max(1, item.end - item.start),
          previous?.root === item.root ? previous.placement : null
        ),
      };
    }
    const next = items[index + 1];
    if (next && point > item.end && point < next.start) {
      return point <= (item.end + next.start) / 2
        ? { root: item.root, placement: 'after' }
        : { root: next.root, placement: 'before' };
    }
  }
  return { root: last.root, placement: 'after' };
}

/** The previous bar drop reused as the hysteresis hint for the next one: only
 *  the bar's own before/after placements qualify. */
function barDropHint(
  drop: { root: WorkbenchSideViewId; placement: WorkbenchSideViewPlacement } | null
): { root: WorkbenchSideViewId; placement: 'before' | 'after' } | null {
  const placement = drop?.placement;
  return drop && (placement === 'before' || placement === 'after') ? { root: drop.root, placement } : null;
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
  orientation: 'vertical' | 'horizontal';
  onSelect(id: WorkbenchSideViewId): void;
  onMoveGroup(
    sourceRoot: WorkbenchSideViewId,
    targetSide: WorkbenchSide,
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement
  ): void;
  onMoveView(
    sourceId: WorkbenchSideViewId,
    targetSide: WorkbenchSide,
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement
  ): void;
}) {
  const [drop, setDrop] = useState<{
    root: WorkbenchSideViewId;
    placement: WorkbenchSideViewPlacement;
  } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const { isVisible } = useDockIconVisibility();
  const renderedGroups = groups.filter((group) => descriptors.has(group[0]) && isVisible(group[0]));
  // Only the left rail rearranges (user: 왼쪽에서만 이동가능하게): the
  // pane-scoped right strip neither starts a drag nor accepts one.
  const movable = side === 'left';
  const acceptsDrag = (event: ReactDragEvent<HTMLElement>): boolean => movable && carriesSideDrag(event);
  const targetAt = (
    clientX: number,
    clientY: number,
    previous: {
      root: WorkbenchSideViewId;
      placement: 'before' | 'after';
    } | null
  ) => {
    const buttons = Array.from(barRef.current?.children ?? []) as HTMLButtonElement[];
    const items: Array<{
      root: WorkbenchSideViewId;
      start: number;
      end: number;
    }> = [];
    buttons.forEach((button, index) => {
      const root = renderedGroups[index]?.[0];
      if (!root) return;
      const bounds = button.getBoundingClientRect();
      items.push({
        root,
        start: orientation === 'vertical' ? bounds.top : bounds.left,
        end: orientation === 'vertical' ? bounds.bottom : bounds.right,
      });
    });
    return workbenchSideBarDropTarget(items, orientation === 'vertical' ? clientY : clientX, previous);
  };
  return (
    <div
      ref={barRef}
      className={`workbench-side-icon-bar is-${orientation}`}
      role="navigation"
      aria-label={side === 'left' ? t('Sidebar') : t('Utility panel tabs')}
      onDragOver={(event) => {
        if (!acceptsDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDrop((current) => targetAt(event.clientX, event.clientY, barDropHint(current)));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDrop(null);
        }
      }}
      onDrop={(event) => {
        if (!movable) return;
        const payload = dragPayload(event);
        if (!payload) return;
        event.preventDefault();
        const target = targetAt(event.clientX, event.clientY, barDropHint(drop));
        if (payload.type === 'group') {
          onMoveGroup(payload.id, side, target?.root ?? null, target?.placement ?? 'after');
        } else {
          onMoveView(payload.id, side, target?.root ?? null, target?.placement ?? 'after');
        }
        activeWorkbenchSideDrag = null;
        setDrop(null);
      }}
    >
      {renderedGroups.map((group) => {
        const root = group[0];
        const descriptor = descriptors.get(root);
        if (!descriptor) return null;
        const Icon = descriptor.icon;
        const active = activeRoot !== null && group.includes(activeRoot);
        return (
          <button
            key={root}
            type="button"
            className={active ? 'active selected' : ''}
            data-side-view={root}
            aria-label={descriptor.label}
            aria-current={active ? 'page' : undefined}
            data-tooltip={descriptor.tooltip || descriptor.label}
            data-drop-position={drop?.root === root ? drop.placement : undefined}
            draggable={movable}
            onPointerEnter={descriptor.onPrefetch}
            onFocus={descriptor.onPrefetch}
            onPointerDown={(event) => {
              if (event.button === 0) descriptor.onPrefetch?.();
            }}
            onDragStart={(event) => {
              if (!movable) return;
              activeWorkbenchSideDrag = { type: 'group', id: root };
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(WORKBENCH_SIDE_GROUP_MIME, root);
              event.dataTransfer.setData('text/plain', root);
              setWorkbenchSideIconDragImage(event);
            }}
            onDragEnd={() => {
              activeWorkbenchSideDrag = null;
              setDrop(null);
            }}
            onClick={() => onSelect(root)}
          >
            {/* Horizontal bars share the status island's 20px lucide tier (user:
            아이콘들도 사이드탭쪽이 더 얇은 것 같고 — 크기를 맞춰야). */}
            <Icon size={orientation === 'vertical' ? 24 : 20} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

function WorkbenchSideSection({
  id,
  active,
  movable,
  sectioned,
  order,
  basis,
  children,
}: {
  id: WorkbenchSideViewId;
  active: boolean;
  /** Left-side panels hand their title bar a live drag handle; the pane-scoped
   *  right side hands it an inert one. */
  movable: boolean;
  sectioned: boolean;
  order: number;
  basis: number;
  children(active: boolean, titleDragProps: WorkbenchSideTitleDragProps): ReactNode;
}) {
  const titleDragProps = useMemo<WorkbenchSideTitleDragProps>(
    () => ({
      draggable: movable,
      onDragStart: (event) => {
        if (!movable) return;
        activeWorkbenchSideDrag = { type: 'view', id };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(WORKBENCH_SIDE_VIEW_MIME, id);
        event.dataTransfer.setData('text/plain', id);
        event.dataTransfer.setDragImage(event.currentTarget, 0, 0);
      },
      onDragEnd: () => {
        activeWorkbenchSideDrag = null;
      },
    }),
    [id, movable]
  );
  return (
    <section
      className="workbench-side-section"
      style={
        {
          order,
          '--workbench-side-section-basis': `${basis}%`,
        } as React.CSSProperties
      }
      data-sectioned={sectioned ? 'true' : 'false'}
    >
      <div className="workbench-side-section-body">{children(active, titleDragProps)}</div>
    </section>
  );
}

const SIDE_PANEL_WIDTH_KEY: Record<WorkbenchSide, string> = {
  left: 'mixdog:session-sidebar-width',
  right: 'mixdog.desktop-utility-dock-width.v1',
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
  return sizes.map((size) => (size / total) * 100);
}

export function resizeSideSplitSizes(
  sizes: readonly number[],
  index: number,
  deltaPx: number,
  totalPx: number,
  minPx = 96
): number[] {
  if (index < 0 || index >= sizes.length - 1 || totalPx <= 0) return [...sizes];
  const next = normalizeSideSplitSizes(sizes, sizes.length);
  const firstPx = (next[index] / 100) * totalPx;
  const secondPx = (next[index + 1] / 100) * totalPx;
  const pairPx = firstPx + secondPx;
  const appliedMin = Math.min(minPx, pairPx / 2);
  const resizedFirst = Math.max(appliedMin, Math.min(pairPx - appliedMin, firstPx + deltaPx));
  next[index] = (resizedFirst / totalPx) * 100;
  next[index + 1] = ((pairPx - resizedFirst) / totalPx) * 100;
  return next;
}

/** Storage key of one group's section split ratios. */
function sideSplitKey(side: WorkbenchSide, group: readonly WorkbenchSideViewId[]): string {
  return `mixdog.desktop.side-view-split.${side}.${group.join('+')}.v1`;
}

/** The current roots when `next` names the same roots in the same order. */
function keepSameRoots(
  current: readonly WorkbenchSideViewId[],
  next: WorkbenchSideViewId[]
): readonly WorkbenchSideViewId[] {
  return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
}

function readSideSplitSizes(key: string, count: number): number[] {
  try {
    return normalizeSideSplitSizes(JSON.parse(window.localStorage.getItem(key) || 'null'), count);
  } catch {
    return normalizeSideSplitSizes(null, count);
  }
}

export function nextRetainedWorkbenchSideRoots(
  groups: readonly WorkbenchSideViewGroup[],
  current: readonly WorkbenchSideViewId[],
  activeRoot: WorkbenchSideViewId | null
): WorkbenchSideViewId[] {
  const retained = new Set(current);
  const selectedRoot = groups.find((group) => activeRoot !== null && group.includes(activeRoot))?.[0] ?? groups[0]?.[0];
  if (selectedRoot) retained.add(selectedRoot);
  return groups
    .map((group) => group[0])
    .filter((root): root is WorkbenchSideViewId => Boolean(root) && retained.has(root));
}

export function WorkbenchSidePanel({
  side,
  open,
  motion = 'animated',
  embedded = false,
  widthStorageKey,
  widthRange,
  widthOverride,
  onWidthDrag,
  hideTabs = false,
  groups,
  activeRoot,
  surfaces,
  surfacesActive = false,
  descriptors,
  onSelect,
  onMoveGroup,
  onMoveView,
  renderView,
  footer,
}: {
  side: WorkbenchSide;
  open: boolean;
  /** Narrow-band sheets slide; a responsive fold applies its state instantly. */
  motion?: 'animated' | 'instant';
  /** Pane-embedded panel (per-pane right dock): keeps the horizontal tabs
   *  header for view switching, is exempt from the window sheet-band CSS,
   *  and skips idle pre-retain — one hidden mount per pane would multiply
   *  across the split tree. */
  embedded?: boolean;
  /** Width preference override; pane docks share one key across panes. */
  widthStorageKey?: string;
  /** Width clamp override; pane docks widen past the window panel ceiling
   *  because browser/diff surfaces need the room. */
  widthRange?: { min: number; max: number; initial: number };
  /** Controlled width (pane docks): the owner measures the pane and hands
   *  the clamped width down; the resize handle reports through onWidthDrag
   *  and the owner persists its own preference. */
  widthOverride?: number;
  onWidthDrag?(width: number, commit: boolean): void;
  /** Pane docks render ONE unit-wide header themselves (user: 헤더 한 줄),
   *  so the panel's own tab header stays off. */
  hideTabs?: boolean;
  groups: readonly WorkbenchSideViewGroup[];
  activeRoot: WorkbenchSideViewId | null;
  /** Persistent surface stack (browser/diff) kept mounted over the panel
   *  body — display:none would wedge a browser guest, so `surfacesActive`
   *  swaps the showing layer by z-index/opacity instead. */
  surfaces?: ReactNode;
  surfacesActive?: boolean;
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  onSelect(id: WorkbenchSideViewId): void;
  onMoveGroup: Parameters<typeof WorkbenchSideIconBar>[0]['onMoveGroup'];
  onMoveView: Parameters<typeof WorkbenchSideIconBar>[0]['onMoveView'];
  renderView(id: WorkbenchSideViewId, active: boolean, titleDragProps: WorkbenchSideTitleDragProps): ReactNode;
  /** Pinned under the shown destination, the same for every view. */
  footer?: ReactNode;
}) {
  const selectedGroup = groups.find((group) => activeRoot !== null && group.includes(activeRoot)) ?? groups[0] ?? [];
  const root = selectedGroup[0] ?? null;
  const movable = side === 'left';
  const [retainedRoots, setRetainedRoots] = useState<readonly WorkbenchSideViewId[]>([]);
  useEffect(() => {
    setRetainedRoots((current) => keepSameRoots(current, nextRetainedWorkbenchSideRoots(groups, current, activeRoot)));
  }, [activeRoot, groups]);
  // Idle pre-retain (user: 메뉴 이동할 때 깜빡 — 바로바로 나오게): shortly
  // after the panel settles, EVERY destination hidden-mounts, so the first
  // visit to each menu swaps attributes on a live tree instead of mounting
  // from scratch and flashing an empty frame. Pane-embedded docks skip this:
  // visited views still retain, but a full hidden mount per pane is too heavy.
  useEffect(() => {
    if (embedded) return undefined;
    const timer = window.setTimeout(() => {
      setRetainedRoots((current) =>
        keepSameRoots(
          current,
          groups.map((group) => group[0]).filter((rootId): rootId is WorkbenchSideViewId => Boolean(rootId))
        )
      );
    }, 400);
    return () => window.clearTimeout(timer);
  }, [embedded, groups]);
  const retainedGroups = groups.filter((group) => group[0] !== root && retainedRoots.includes(group[0]));
  const splitKey = sideSplitKey(side, selectedGroup);
  const [splitSizesByKey, setSplitSizesByKey] = useState<Record<string, number[]>>({});
  const splitSizes = splitSizesByKey[splitKey] ?? readSideSplitSizes(splitKey, selectedGroup.length);
  const widthKey = widthStorageKey ?? SIDE_PANEL_WIDTH_KEY[side];
  const widthMin = widthRange?.min ?? SIDE_PANEL_MIN_WIDTH[side];
  const widthMax = widthRange?.max ?? SIDE_PANEL_MAX_WIDTH[side];
  const widthInitial = widthRange?.initial ?? SIDE_PANEL_DEFAULT_WIDTH[side];
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(widthKey));
      return Number.isFinite(stored) && stored > 0 ? Math.max(widthMin, Math.min(widthMax, stored)) : widthInitial;
    } catch {
      return widthInitial;
    }
  });
  const effectiveWidth = widthOverride ?? width;
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const dragPending = useRef<number | null>(null);
  const panelBodyRef = useRef<HTMLDivElement | null>(null);
  const [paneDrop, setPaneDrop] = useState<{
    targetRoot: WorkbenchSideViewId;
    placement: 'inside-before' | 'inside-after';
    slot: number;
    top: number;
    height: number;
    boundary: number;
  } | null>(null);
  const splitCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => splitCleanupRef.current?.(), []);
  const startSplitResize = (index: number, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const body = panelBodyRef.current;
    if (!body) return;
    splitCleanupRef.current?.();
    const startY = event.clientY;
    const totalPx = Math.max(1, body.clientHeight);
    const startSizes = [...splitSizes];
    let pending = startSizes;
    const move = (moveEvent: PointerEvent) => {
      pending = resizeSideSplitSizes(startSizes, index, moveEvent.clientY - startY, totalPx);
      setSplitSizesByKey((current) => ({ ...current, [splitKey]: pending }));
    };
    let cleaned = false;
    const cleanup = (commit: boolean) => {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      if (commit) {
        try {
          window.localStorage.setItem(splitKey, JSON.stringify(pending));
        } catch {
          /* split ratio remains active for this renderer */
        }
      }
      if (splitCleanupRef.current === cancel) splitCleanupRef.current = null;
    };
    const stop = () => cleanup(true);
    const cancel = () => cleanup(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    splitCleanupRef.current = cancel;
    event.preventDefault();
  };
  if (!root || groups.length === 0) return null;
  return (
    <aside
      className="workbench-side-panel"
      data-side={side}
      data-motion={motion}
      data-embedded={embedded ? 'true' : undefined}
      hidden={!open}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
      style={
        {
          '--workbench-side-panel-width': `${effectiveWidth}px`,
          '--workbench-side-panel-min-width': `${widthMin}px`,
          '--workbench-side-panel-max-width': `${widthMax}px`,
        } as React.CSSProperties
      }
    >
      <div
        className="workbench-side-panel-resize"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          resizeStart.current = { x: event.clientX, width: effectiveWidth };
          dragPending.current = null;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = resizeStart.current;
          if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const delta = side === 'left' ? event.clientX - start.x : start.x - event.clientX;
          const next = Math.max(widthMin, Math.min(widthMax, Math.round(start.width + delta)));
          if (onWidthDrag) {
            dragPending.current = next;
            onWidthDrag(next, false);
          } else setWidth(next);
        }}
        onPointerUp={(event) => {
          if (!resizeStart.current) return;
          resizeStart.current = null;
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {
            // The pointer was already released (cancelled or element detached).
          }
          if (onWidthDrag) {
            onWidthDrag(dragPending.current ?? effectiveWidth, true);
            dragPending.current = null;
            return;
          }
          try {
            window.localStorage.setItem(widthKey, String(width));
          } catch {
            // A width that cannot persist only resets on the next launch.
          }
        }}
      />
      <div className="workbench-side-panel-content">
        {side === 'right' && !hideTabs && (
          <header className="workbench-side-panel-tabs">
            <WorkbenchSideIconBar
              side="right"
              groups={groups}
              activeRoot={root}
              descriptors={descriptors}
              orientation="horizontal"
              onSelect={onSelect}
              onMoveGroup={onMoveGroup}
              onMoveView={onMoveView}
            />
          </header>
        )}
        {/* Selected and retained groups share one keyed tree. Separate JSX
            branches remounted every destination on selection, discarding its
            warmed controls, local state and scroll position. */}
        {[selectedGroup, ...retainedGroups].map((group) => {
          const selected = group[0] === root;
          const groupSplitKey = sideSplitKey(side, group);
          const sizes = selected
            ? splitSizes
            : (splitSizesByKey[groupSplitKey] ?? readSideSplitSizes(groupSplitKey, group.length));
          return (
            <div
              key={group[0]}
              className="workbench-side-panel-body"
              ref={selected ? panelBodyRef : undefined}
              hidden={!selected}
              inert={!selected || surfacesActive ? true : undefined}
              aria-hidden={!selected || surfacesActive ? true : undefined}
              onDragOver={(event) => {
                if (!selected || !movable || !carriesSideDrag(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const payload = dragPayload(event);
                const body = panelBodyRef.current;
                if (!payload || !body) {
                  setPaneDrop(null);
                  return;
                }
                const panes = Array.from(body.children).filter(
                  (child): child is HTMLElement =>
                    child instanceof HTMLElement && child.classList.contains('workbench-side-section')
                );
                if (panes.length !== selectedGroup.length) {
                  setPaneDrop(null);
                  return;
                }
                const bodyBounds = body.getBoundingClientRect();
                const paneBounds = panes.map((pane) => pane.getBoundingClientRect());
                const centers = paneBounds.map((bounds) => (bounds.top + bounds.bottom) / 2);
                const slot = workbenchSidePaneDropSlot(centers, event.clientY);
                if (workbenchSidePaneDropIsNoop(selectedGroup, payload.type, payload.id, slot)) {
                  setPaneDrop(null);
                  return;
                }
                const edges = [bodyBounds.top, ...centers, bodyBounds.bottom];
                const boundaries = [
                  paneBounds[0].top,
                  ...paneBounds.slice(0, -1).map((bounds, index) => (bounds.bottom + paneBounds[index + 1].top) / 2),
                  paneBounds[paneBounds.length - 1].bottom,
                ];
                const top = Math.max(0, edges[slot] - bodyBounds.top);
                const height = Math.max(1, edges[slot + 1] - edges[slot]);
                setPaneDrop({
                  targetRoot: slot === 0 ? selectedGroup[0] : selectedGroup[slot - 1],
                  placement: slot === 0 ? 'inside-before' : 'inside-after',
                  slot,
                  top,
                  height,
                  boundary: Math.max(0, Math.min(Math.max(0, height - 2), boundaries[slot] - bodyBounds.top - top)),
                });
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setPaneDrop(null);
                }
              }}
              onDrop={(event) => {
                if (!selected || !movable || !paneDrop) return;
                const payload = dragPayload(event);
                if (!payload) {
                  setPaneDrop(null);
                  return;
                }
                event.preventDefault();
                if (payload.type === 'group') {
                  onMoveGroup(payload.id, side, paneDrop.targetRoot, paneDrop.placement);
                } else {
                  onMoveView(payload.id, side, paneDrop.targetRoot, paneDrop.placement);
                }
                activeWorkbenchSideDrag = null;
                setPaneDrop(null);
              }}
            >
              {selected && paneDrop && (
                <div
                  className="workbench-side-pane-drop-overlay"
                  data-drop-slot={paneDrop.slot}
                  style={{ top: paneDrop.top, height: paneDrop.height }}
                >
                  <span style={{ top: paneDrop.boundary }} />
                </div>
              )}
              {group.map((id, index) => {
                const descriptor = descriptors.get(id);
                if (!descriptor) return null;
                return (
                  <Fragment key={id}>
                    <WorkbenchSideSection
                      id={id}
                      active={selected && open}
                      movable={movable}
                      sectioned={group.length > 1}
                      order={index * 2}
                      basis={sizes[index] ?? 100 / group.length}
                    >
                      {(active, titleDragProps) => renderView(id, active, titleDragProps)}
                    </WorkbenchSideSection>
                    {index < group.length - 1 && (
                      <div
                        className="workbench-side-sash"
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label={t('Resize combined views')}
                        style={{ order: index * 2 + 1 }}
                        onPointerDown={selected ? (event) => startSplitResize(index, event) : undefined}
                      />
                    )}
                  </Fragment>
                );
              })}
            </div>
          );
        })}
        {footer}
        {surfaces && (
          <div className="workbench-side-panel-surfaces" data-active={surfacesActive ? 'true' : 'false'}>
            {surfaces}
          </div>
        )}
      </div>
    </aside>
  );
}
