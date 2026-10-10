import { useCallback, useMemo, useState, type DragEvent as ReactDragEvent } from 'react';
import type { SidebarPanelKey } from './app-shell-components';
import type { UtilityDockTab } from './UtilityDock';

export type WorkbenchSide = 'left' | 'right';
/** Browser Use and Terminal are session-owned pane-dock child views. Their
 *  header icons select persistent surfaces stacked over the classic panel.
 *  Studio is no rail view at all: it opens as a workspace tab from the
 *  Sessions panel's fixed launcher rows (user: 세션 위에 새 작업·새 스튜디오
 *  고정), so a stored rail order still carrying the retired `studio` id
 *  drops it on load like any other unknown id. */
export type WorkbenchSideViewId =
  | 'sessions'
  | SidebarPanelKey
  | UtilityDockTab
  | 'session-diff'
  | 'browser'
  | 'terminal';
export type WorkbenchSideViewGroup = readonly WorkbenchSideViewId[];
export type WorkbenchSideTitleDragProps = {
  draggable: boolean;
  onDragStart(event: ReactDragEvent<HTMLElement>): void;
  onDragEnd(): void;
};

export type WorkbenchSideViewPlacement = 'before' | 'after' | 'inside' | 'inside-before' | 'inside-after';
type WorkbenchSideViewLayout = Readonly<Record<WorkbenchSide, readonly WorkbenchSideViewGroup[]>>;

const WORKBENCH_SIDE_LAYOUT_KEY = 'mixdog.desktop.workbench-side-view-layout.v1';
/** The rail order and the pane-scoped right side replace every earlier
 *  placement rule, so one shot drops the stored arrangement instead of
 *  patching it (user: 기본값 내 설정값도 바꿔주고). */
const PANE_BOUND_RIGHT_MIGRATION_KEY = 'mixdog.desktop.workbench-side-view-layout.pane-bound-right.v1';
const ALL_VIEW_IDS: readonly WorkbenchSideViewId[] = [
  'sessions',
  'projects',
  'workflows',
  'extensions',
  'schedules',
  'webhooks',
  'session-diff',
  'browser',
  'terminal',
  'agents',
  'search',
  'source-control',
  'pull-requests',
];

/** The left rail carries Project-wide destinations, including Source Control.
 *  The right side belongs to the PANE (user: 오른쪽 사이드탭은 이제 PANE
 *  종속이라): session Diff and session-owned surfaces lead, while legacy
 *  Pull Requests remains available behind its feature flag. */
const DEFAULT_WORKBENCH_SIDE_VIEW_LAYOUT: WorkbenchSideViewLayout = {
  left: [
    ['sessions'],
    ['agents'],
    ['schedules'],
    ['projects'],
    ['workflows'],
    ['extensions'],
    ['source-control'],
    ['search'],
    ['webhooks'],
  ],
  right: [['session-diff'], ['browser'], ['terminal'], ['pull-requests']],
};

export function isViewId(value: unknown): value is WorkbenchSideViewId {
  return ALL_VIEW_IDS.includes(value as WorkbenchSideViewId);
}

/**
 * Where a view the stored layout never carried belongs: ahead of the first
 * group that already holds a default view following it. A side stored before
 * those views existed (for example, an older sparse phone layout) therefore
 * rebuilds in DEFAULT order instead of collecting every missing view behind
 * whatever it happened to store.
 */
function defaultSlotIndex(
  groups: readonly WorkbenchSideViewGroup[],
  defaultOrder: readonly WorkbenchSideViewId[],
  id: WorkbenchSideViewId
): number {
  const rank = defaultOrder.indexOf(id);
  const index = groups.findIndex((group) => group.some((member) => defaultOrder.indexOf(member) > rank));
  return index < 0 ? groups.length : index;
}

export function normalizeWorkbenchSideViewLayout(
  value: unknown,
  available: readonly WorkbenchSideViewId[] = ALL_VIEW_IDS
): WorkbenchSideViewLayout {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const allowed = new Set(available);
  const seen = new Set<WorkbenchSideViewId>();
  // The right side belongs to the pane and cannot be rearranged, so only the
  // views that ship there may stay there. A stored placement from before a
  // view moved rails (Source Control, Search…) re-seats on the left in default
  // order instead of lingering on the right forever (user: 소스컨트롤은 왼쪽
  // 사이드탭으로 이동해야하고).
  const paneBound = new Set(DEFAULT_WORKBENCH_SIDE_VIEW_LAYOUT.right.flat());
  const normalizeSide = (side: WorkbenchSide): WorkbenchSideViewId[][] => {
    const groups: WorkbenchSideViewId[][] = [];
    const rawGroups = Array.isArray(record[side]) ? record[side] : [];
    for (const rawGroup of rawGroups) {
      if (!Array.isArray(rawGroup)) continue;
      const group: WorkbenchSideViewId[] = [];
      for (const id of rawGroup) {
        if (!isViewId(id) || !allowed.has(id) || seen.has(id)) continue;
        if (side === 'right' && !paneBound.has(id)) continue;
        seen.add(id);
        group.push(id);
      }
      if (group.length) groups.push(group);
    }
    return groups;
  };
  const left = normalizeSide('left');
  const right = normalizeSide('right');
  for (const side of ['left', 'right'] as const) {
    const defaultOrder: WorkbenchSideViewId[] = [];
    for (const group of DEFAULT_WORKBENCH_SIDE_VIEW_LAYOUT[side]) defaultOrder.push(...group);
    const target = side === 'left' ? left : right;
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
  id: WorkbenchSideViewId
): { side: WorkbenchSide; index: number } | null {
  for (const side of ['left', 'right'] as const) {
    const index = layout[side].findIndex((group) => group.includes(id));
    if (index >= 0) return { side, index };
  }
  return null;
}

/**
 * Rearranging is a LEFT-side gesture only (user: 이제 오른쪽 사이드탭으로는
 * 이동불가하게하고 왼쪽에서만 이동가능하게). The right side ships with the
 * views its pane drives, so a move that starts there or lands there is a no-op.
 */
function movableWithinLeft(
  layout: WorkbenchSideViewLayout,
  sourceId: WorkbenchSideViewId,
  targetSide: WorkbenchSide
): boolean {
  return targetSide === 'left' && locateGroup(layout, sourceId)?.side === 'left';
}

/** Seat the moved members on the target side: inside the group holding
 *  `targetRoot` for the `inside*` placements, beside that group otherwise, and
 *  at the end when the move left no target to land against. */
function insertMovedMembers(
  next: { left: WorkbenchSideViewId[][]; right: WorkbenchSideViewId[][] },
  targetSide: WorkbenchSide,
  targetRoot: WorkbenchSideViewId | null,
  members: WorkbenchSideViewId[],
  placement: WorkbenchSideViewPlacement
): void {
  const targetIndex = targetRoot ? next[targetSide].findIndex((group) => group.includes(targetRoot)) : -1;
  if (!targetRoot || targetIndex < 0) {
    next[targetSide].push(members);
    return;
  }
  if (placement === 'inside' || placement === 'inside-before' || placement === 'inside-after') {
    const targetGroup = next[targetSide][targetIndex];
    const targetViewIndex = targetGroup.indexOf(targetRoot);
    const insertIndex = placement === 'inside-before' ? targetViewIndex : targetViewIndex + 1;
    targetGroup.splice(insertIndex, 0, ...members);
  } else {
    next[targetSide].splice(targetIndex + (placement === 'after' ? 1 : 0), 0, members);
  }
}

export function moveWorkbenchSideGroup(
  layout: WorkbenchSideViewLayout,
  sourceRoot: WorkbenchSideViewId,
  targetSide: WorkbenchSide,
  targetRoot: WorkbenchSideViewId | null,
  placement: WorkbenchSideViewPlacement
): WorkbenchSideViewLayout {
  const source = locateGroup(layout, sourceRoot);
  if (!source || layout[source.side][source.index][0] !== sourceRoot) return layout;
  if (!movableWithinLeft(layout, sourceRoot, targetSide)) return layout;
  if (targetRoot && layout[source.side][source.index].includes(targetRoot)) return layout;
  const next = mutableLayout(layout);
  const [sourceGroup] = next[source.side].splice(source.index, 1);
  insertMovedMembers(next, targetSide, targetRoot, sourceGroup, placement);
  return next;
}

export function moveWorkbenchSideView(
  layout: WorkbenchSideViewLayout,
  sourceId: WorkbenchSideViewId,
  targetSide: WorkbenchSide,
  targetRoot: WorkbenchSideViewId | null,
  placement: WorkbenchSideViewPlacement
): WorkbenchSideViewLayout {
  const source = locateGroup(layout, sourceId);
  if (!source) return layout;
  if (targetRoot === sourceId) return layout;
  if (!movableWithinLeft(layout, sourceId, targetSide)) return layout;
  const next = mutableLayout(layout);
  next[source.side][source.index] = next[source.side][source.index].filter((id) => id !== sourceId);
  if (next[source.side][source.index].length === 0) next[source.side].splice(source.index, 1);
  insertMovedMembers(next, targetSide, targetRoot, [sourceId], placement);
  return next;
}

/** The left drawer's home destination: Agents whenever the rail carries it
 *  (user: 재부팅하면 에이전트 디폴트로 — 세션이 선택되어 있음), regardless of
 *  where a stored rail order happens to place it. */
const LEFT_HOME_VIEW: WorkbenchSideViewId = 'agents';

/**
 * First active view per side. No last-visited view survives a reload (user:
 * 좌·우·하단 도크 전부 첫 메뉴로 초기화) — the dock tab and the bottom panel
 * drop their persisted selection for the same reason — so every reconnect
 * lands on one predictable entry point per edge: the left opens on Agents
 * when present (else its leading group), the right on the group that leads
 * it. A side that holds nothing has no active view.
 */
export function initialActiveWorkbenchSideViews(
  layout: WorkbenchSideViewLayout
): Record<WorkbenchSide, WorkbenchSideViewId | null> {
  const leftHome = layout.left.find((group) => group[0] === LEFT_HOME_VIEW)?.[0];
  return {
    left: leftHome ?? layout.left[0]?.[0] ?? null,
    right: layout.right[0]?.[0] ?? null,
  };
}

/**
 * Every stored placement predates the pane-scoped right side, so patching one
 * shape at a time can no longer land the new arrangement. This drops the stored
 * value once — the defaults then apply to existing installs exactly as they do
 * to a fresh profile — and leaves later hand-arranged left rails untouched.
 */
export function discardLayoutForPaneBoundRight(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  value: unknown
): unknown {
  if (storage.getItem(PANE_BOUND_RIGHT_MIGRATION_KEY) === '1') return value;
  storage.setItem(PANE_BOUND_RIGHT_MIGRATION_KEY, '1');
  storage.removeItem(WORKBENCH_SIDE_LAYOUT_KEY);
  return null;
}

function readLayout(): unknown {
  try {
    return discardLayoutForPaneBoundRight(
      window.localStorage,
      JSON.parse(window.localStorage.getItem(WORKBENCH_SIDE_LAYOUT_KEY) || 'null')
    );
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
  const availableKey = available.join('\0');
  const [stored, setStored] = useState<WorkbenchSideViewLayout>(() =>
    normalizeWorkbenchSideViewLayout(readLayout(), available)
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: availableKey is the content signature of available, so an equal list does not recompute the layout
  const layout = useMemo(() => normalizeWorkbenchSideViewLayout(stored, available), [availableKey, stored]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: availableKey is the content signature of available, so an equal list keeps commit stable
  const commit = useCallback(
    (update: (current: WorkbenchSideViewLayout) => WorkbenchSideViewLayout) => {
      setStored((current) => {
        const next = update(normalizeWorkbenchSideViewLayout(current, available));
        persistLayout(next);
        return next;
      });
    },
    [availableKey]
  );
  const moveGroup = useCallback(
    (
      sourceRoot: WorkbenchSideViewId,
      targetSide: WorkbenchSide,
      targetRoot: WorkbenchSideViewId | null,
      placement: WorkbenchSideViewPlacement
    ) => commit((current) => moveWorkbenchSideGroup(current, sourceRoot, targetSide, targetRoot, placement)),
    [commit]
  );
  const moveView = useCallback(
    (
      sourceId: WorkbenchSideViewId,
      targetSide: WorkbenchSide,
      targetRoot: WorkbenchSideViewId | null,
      placement: WorkbenchSideViewPlacement
    ) => commit((current) => moveWorkbenchSideView(current, sourceId, targetSide, targetRoot, placement)),
    [commit]
  );
  const sideOf = useCallback(
    (id: WorkbenchSideViewId): WorkbenchSide => locateGroup(layout, id)?.side ?? 'left',
    [layout]
  );
  const groupFor = useCallback(
    (id: WorkbenchSideViewId): WorkbenchSideViewGroup =>
      layout.left.find((group) => group.includes(id)) ?? layout.right.find((group) => group.includes(id)) ?? [id],
    [layout]
  );
  return { layout, moveGroup, moveView, sideOf, groupFor };
}
