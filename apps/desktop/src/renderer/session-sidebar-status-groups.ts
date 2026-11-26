import type { SessionAttention } from '../shared/session-attention';

/** The sidebar groups a session joins for its status, ahead of 최근 and the
 *  project folders: 확인 필요 (it waits on the user's approval or answer, it
 *  failed, or it holds a turn the user has not seen) and 작업 중 (a turn is in
 *  flight, or its agent waits on background work it handed off). */
export type SidebarStatusGroup = 'needs' | 'working';
/** The groups that take a session out of the list it would rest in (최근 or
 *  its project folder): 즐겨찾기 its favourites first, then the status groups. */
export const PLACING_GROUPS = ['favorites', 'needs', 'working'] as const;
export type SidebarPlacingGroup = (typeof PLACING_GROUPS)[number];

export function sidebarStatusGroup(attention: SessionAttention | ''): SidebarStatusGroup | '' {
  switch (attention) {
    case 'needs-you':
    case 'asking':
    case 'failed':
    case 'unread':
      return 'needs';
    case 'running':
    case 'waiting':
      return 'working';
    default:
      return '';
  }
}

export interface SidebarStatusPlacement {
  favorites: readonly string[];
  needs: readonly string[];
  working: readonly string[];
  /** Every session one of these groups shows. */
  placed: ReadonlySet<string>;
}

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

function placedGroup(placement: SidebarStatusPlacement, sessionId: string): SidebarPlacingGroup | '' {
  return PLACING_GROUPS.find((group) => placement[group].includes(sessionId)) ?? '';
}

/** Which of `rows` (the unarchived sessions, newest first) a placing group
 *  shows, whatever their project: a favourite stays in 즐겨찾기 with its own
 *  mark, any other session with a status joins its status group. A hidden
 *  group takes none, so its sessions stay where they rest. A `held` session
 *  (one being renamed) keeps the group it had in `previous`. `previous` comes
 *  back while nothing moved. */
export function placeStatusSessions(
  rows: readonly { id: string; favorite?: boolean }[],
  attentionOf: (sessionId: string) => SessionAttention | '',
  shown: ReadonlySet<SidebarPlacingGroup>,
  previous?: SidebarStatusPlacement,
  held?: ReadonlySet<string>
): SidebarStatusPlacement {
  const placed: Record<SidebarPlacingGroup, string[]> = { favorites: [], needs: [], working: [] };
  for (const row of rows) {
    const kept = previous && held?.has(row.id) ? placedGroup(previous, row.id) : undefined;
    const live = row.favorite && shown.has('favorites') ? 'favorites' : sidebarStatusGroup(attentionOf(row.id));
    const group = kept !== undefined && (kept === '' || shown.has(kept)) ? kept : live;
    if (group && shown.has(group)) placed[group].push(row.id);
  }
  if (previous && PLACING_GROUPS.every((group) => sameIds(previous[group], placed[group]))) return previous;
  return { ...placed, placed: new Set(PLACING_GROUPS.flatMap((group) => placed[group])) };
}

/** The rows of a list that rest there: none a placing group shows, none
 *  listed `elsewhere` (최근 leaves project sessions to their folders). */
export function restingRows<T extends { id: string }>(
  rows: readonly T[],
  placement: SidebarStatusPlacement,
  elsewhere?: ReadonlyMap<string, unknown>
): T[] {
  return rows.filter((row) => !placement.placed.has(row.id) && !elsewhere?.has(row.id));
}
