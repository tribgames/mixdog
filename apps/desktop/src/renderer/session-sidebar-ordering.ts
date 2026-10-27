// The sidebar's ordering projection: which sessions list, in activity order,
// as sorted id lists. It reads only the fields below, so a catalog change that
// leaves them alone (a new title, preview...) keeps the projection as is.
import {
  roomIdOfSession,
  roomMemberOfSession,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { DesktopSessionSummary } from '../shared/contract';
import { listsAsSession } from './session-sidebar-agents';
import { isAutomationRow } from './session-sidebar-sections';

export interface SessionOrderingProjection {
  /** The sessions the projection was computed from; compared field-wise next time. */
  source: readonly DesktopSessionSummary[];
  hasSessionSurface: boolean;
  showAgents: boolean;
  contactHomeIds: ReadonlySet<string> | null;
  /** Listed task/project sessions, activity-desc. */
  allIds: readonly string[];
  favoriteIds: readonly string[];
  activityIds: readonly string[];
}

/** Every session field the filters and the sort below read. */
function sameOrderingFields(left: DesktopSessionSummary, right: DesktopSessionSummary): boolean {
  return (
    left.id === right.id &&
    left.agentSession === right.agentSession &&
    left.agentHome === right.agentHome &&
    left.archived === right.archived &&
    left.classification === right.classification &&
    left.favorite === right.favorite &&
    left.sourceType === right.sourceType &&
    left.activityAt === right.activityAt &&
    left.updatedAt === right.updatedAt
  );
}

function sameOrdering(previous: SessionOrderingProjection, sessions: readonly DesktopSessionSummary[]): boolean {
  if (previous.source.length !== sessions.length) return false;
  for (let index = 0; index < sessions.length; index += 1) {
    const before = previous.source[index] as DesktopSessionSummary;
    const after = sessions[index] as DesktopSessionSummary;
    if (before !== after && !sameOrderingFields(before, after)) return false;
  }
  return true;
}

export function projectSessionOrdering(
  sessions: readonly DesktopSessionSummary[],
  hasSessionSurface: boolean,
  showAgents: boolean,
  contactHomeIds: ReadonlySet<string> | null,
  previous?: SessionOrderingProjection
): SessionOrderingProjection {
  if (
    previous &&
    previous.hasSessionSurface === hasSessionSurface &&
    previous.showAgents === showAgents &&
    previous.contactHomeIds === contactHomeIds &&
    sameOrdering(previous, sessions)
  ) {
    return previous;
  }
  const listed = !hasSessionSurface
    ? []
    : sessions
        .filter((session) => showAgents || !session.agentSession)
        // A live contact's home thread is its row on the Agents pane; an
        // archived one, or one whose agent is no contact (anymore), lists here.
        .filter((session) => listsAsSession(session, contactHomeIds))
        // So is a group room (its row sits under the contacts) and,
        // always, a room member's own session.
        .filter((session) => !roomIdOfSession(session.id) || session.archived)
        .filter((session) => !roomMemberOfSession(session.id))
        .filter((session) => session.classification === 'task' || session.classification === 'project')
        .sort((left, right) => {
          const leftActivityAt = Number(left.activityAt) || left.updatedAt;
          const rightActivityAt = Number(right.activityAt) || right.updatedAt;
          return rightActivityAt - leftActivityAt || left.id.localeCompare(right.id);
        });
  const idsOf = (rows: readonly DesktopSessionSummary[]) => rows.map((session) => session.id);
  return {
    source: sessions,
    hasSessionSurface,
    showAgents,
    contactHomeIds,
    allIds: idsOf(listed),
    favoriteIds: idsOf(listed.filter((session) => session.favorite && !session.archived && !isAutomationRow(session))),
    activityIds: idsOf(listed.filter((session) => !session.archived && !session.favorite && !isAutomationRow(session))),
  };
}

/** The current rows for an id list, so a changed title still renders. */
export function rowsOfIds(
  ids: readonly string[],
  byId: ReadonlyMap<string, DesktopSessionSummary>
): DesktopSessionSummary[] {
  return ids.map((id) => byId.get(id) as DesktopSessionSummary);
}
