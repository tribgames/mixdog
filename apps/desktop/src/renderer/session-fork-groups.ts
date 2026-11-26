import type { DesktopSessionSummary } from '../shared/contract';
import { commitVisibleOrder } from './session-order';

/** One top-level sidebar entry: an original session and the forks (inherited
 *  sessions) that belong under it, oldest fork first. `forks` is empty for an
 *  ordinary row. */
export interface ForkGroup {
  session: DesktopSessionSummary;
  forks: DesktopSessionSummary[];
}

/** How a row takes part in a fork group: the original (with its expansion) or
 *  the n-th fork (1-based creation order). */
export type ForkRowRole =
  | { kind: 'root'; expanded: boolean }
  | { kind: 'child'; n: number; rootId: string; last: boolean };

/** Root of `row`: the first ancestor, following `inheritedFromSessionId`,
 *  that is present in the same list. A fork whose source is absent is its own
 *  root, so it renders as a normal row. */
function rootOf(row: DesktopSessionSummary, byId: ReadonlyMap<string, DesktopSessionSummary>) {
  const seen = new Set([row.id]);
  let current = row;
  for (;;) {
    const parent = current.inheritedFromSessionId ? byId.get(current.inheritedFromSessionId) : undefined;
    if (!parent || seen.has(parent.id)) return current;
    seen.add(parent.id);
    current = parent;
  }
}

function creationTime(row: DesktopSessionSummary) {
  return Number(row.createdAt) || row.updatedAt;
}

/** Groups forks under their root original, keeping the list's order: a group
 *  sits where its first member does, so an activity-ordered list puts it at the
 *  member with the most recent activity. Entries are taken until `visibleCount`
 *  rows are covered; a group is never cut. */
export function groupForkRows(rows: readonly DesktopSessionSummary[], visibleCount = rows.length): ForkGroup[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const groups = new Map<string, ForkGroup>();
  const entries: ForkGroup[] = [];
  for (const row of rows) {
    const root = rootOf(row, byId);
    let group = groups.get(root.id);
    if (!group) {
      group = { session: root, forks: [] };
      groups.set(root.id, group);
      entries.push(group);
    }
    if (row !== root) group.forks.push(row);
  }
  for (const group of entries) {
    group.forks.sort((left, right) => creationTime(left) - creationTime(right) || left.id.localeCompare(right.id));
  }
  const visible: ForkGroup[] = [];
  let covered = 0;
  for (const group of entries) {
    if (covered >= visibleCount) break;
    visible.push(group);
    covered += 1 + group.forks.length;
  }
  return visible;
}

const groupIds = (group: ForkGroup) => [group.session.id, ...group.forks.map((fork) => fork.id)];

/** Ids a drag can reorder in a list: one per visible group (its original), so
 *  a group moves as a unit and forks are never drop targets of their own. */
export function visibleForkRootIds(rows: readonly DesktopSessionSummary[], visibleCount: number): string[] {
  return groupForkRows(rows, visibleCount).map((group) => group.session.id);
}

/** The list's full session order after the user reordered its visible groups
 *  (`nextRootIds`, originals only): every group keeps its forks right after its
 *  original, and groups paged out keep their place below. Rendering this order
 *  groups identically to what the user dropped. */
export function commitForkGroupOrder(
  rows: readonly DesktopSessionSummary[],
  visibleCount: number,
  nextRootIds: readonly string[]
): string[] {
  const visible = groupForkRows(rows, visibleCount);
  const byRoot = new Map(visible.map((group) => [group.session.id, group]));
  const nextVisible = nextRootIds.flatMap((id) => {
    const group = byRoot.get(id);
    return group ? groupIds(group) : [];
  });
  return commitVisibleOrder(groupForkRows(rows).flatMap(groupIds), visible.flatMap(groupIds).length, nextVisible);
}
