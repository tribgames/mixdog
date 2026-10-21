// The Routines tile: the right-dock view an agent's home thread shows beside
// the chat. It exists only on home threads; whether it is open is ONE
// persisted preference for every home thread, set by its tab-bar toggle.
// Until the user sets it, the tile opens by itself only on the home of an
// agent that owns at least one routine.
import {
  agentIdOfHomeSession,
  isAgentHomeSessionId,
} from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomIdOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { SessionSidePanelView } from './session-side-surface-policy';
import type { WorkbenchSideViewGroup } from './workbench-side-view-layout';

const ROUTINES_TILE_KEY = 'mixdog.desktop.routines-tile-open.v1';

/** 'open' / 'closed' once the user toggled the tile; null before that. */
export type RoutinesTilePreference = 'open' | 'closed' | null;

export function readRoutinesTilePreference(): RoutinesTilePreference {
  try {
    const value = window.localStorage.getItem(ROUTINES_TILE_KEY);
    return value === 'open' || value === 'closed' ? value : null;
  } catch {
    return null;
  }
}

export function writeRoutinesTileOpen(open: boolean): void {
  try {
    window.localStorage.setItem(ROUTINES_TILE_KEY, open ? 'open' : 'closed');
  } catch {
    // The preference degrades to this window's lifetime.
  }
}

/** The pane's right-side groups for the session it shows: the Routines view
 *  only for an agent's home thread, the room panel only for a group room. */
export function paneRightGroupsFor(
  groups: readonly WorkbenchSideViewGroup[],
  sessionId: string
): readonly WorkbenchSideViewGroup[] {
  const home = isAgentHomeSessionId(sessionId);
  const room = Boolean(roomIdOfSession(sessionId));
  return groups.filter((group) => (home || !group.includes('routines')) && (room || !group.includes('room')));
}

/** An agent-mode chat's header toggles: its info panel (the profile, or the
 *  room's info), Visualize and the browser the bot works in. The terminal
 *  stays off it; Changes too, as the chat's changes card opens the diff. */
export function agentChatStripGroups(groups: readonly WorkbenchSideViewGroup[]): readonly WorkbenchSideViewGroup[] {
  return groups.filter(
    (group) =>
      group.includes('routines') || group.includes('room') || group.includes('visualize') || group.includes('browser')
  );
}

/** A coding pane's header toggles: Visualize in the Changes slot (it opens the
 *  turn's outputs), then the coding docks. The changes card and Source
 *  Control open Changes. */
export function codingStripGroups(groups: readonly WorkbenchSideViewGroup[]): readonly WorkbenchSideViewGroup[] {
  return groups.filter((group) => !group.includes('session-diff'));
}

/** Per-session panel views with the Routines tile filled in for every home
 *  thread that picked no other view: all of them once the user opened the
 *  tile, none once they closed it, and before either only the homes of agents
 *  in `routineOwners`. */
export function withRoutinesPanelDefault(
  views: ReadonlyMap<string, SessionSidePanelView>,
  preference: RoutinesTilePreference,
  routineOwners: ReadonlySet<string>
): ReadonlyMap<string, SessionSidePanelView> {
  if (preference === 'closed') return views;
  const shows = (sessionId: string) =>
    isAgentHomeSessionId(sessionId) && (preference === 'open' || routineOwners.has(agentIdOfHomeSession(sessionId)));
  const merged = new Map(views);
  const get = (sessionId: string) => views.get(sessionId) ?? (shows(sessionId) ? ('routines' as const) : undefined);
  return Object.assign(merged, { get });
}

/** The tile preference after a panel change on `sessionId`; null when the
 *  change does not touch it (another session kind). */
export function routinesTileOpenAfter(sessionId: string, view: SessionSidePanelView | null): boolean | null {
  return isAgentHomeSessionId(sessionId) ? view === 'routines' : null;
}
