import {
  PANE_DOCK_BROWSER_SURFACE,
  PANE_DOCK_DIFF_SURFACE,
  PANE_DOCK_FILE_SURFACE,
  PANE_DOCK_FILES_SURFACE,
  PANE_DOCK_TERMINAL_SURFACE,
  type PaneSideDockDiff,
  type PaneSideDockEntry,
  paneDockForeign,
  paneDockRestored,
  paneLocalSurface,
} from './pane-side-dock';
import { navigationKey } from './text-format';

export type SessionSideSurface = typeof PANE_DOCK_BROWSER_SURFACE | typeof PANE_DOCK_TERMINAL_SURFACE;

/** Another session's surface a session's dock shows: a child session's
 *  browser or terminal revealed in the conversation that owns it. */
export type SessionSurfaceSource = { sessionId: string; surface: SessionSideSurface };

/** The session whose `surface` the dock of `sessionId` shows: a child's when
 *  one was revealed there for that surface, else its own. */
export function sessionSurfaceSessionFor(
  sources: ReadonlyMap<string, SessionSurfaceSource>,
  sessionId: string,
  surface: SessionSideSurface
): string {
  const source = sources.get(sessionId);
  return source?.surface === surface ? source.sessionId : sessionId;
}

export const SESSION_DOCK_SURFACES_KEY = 'mixdog.desktop.session-dock-surfaces.v1';

/** An upgrade from the pane-keyed store: the sessions whose terminal it held
 *  open, read as the restored workspace shows them (the session each pane
 *  shows owns that pane's stored terminal). Closing wrote `open:false`, so a
 *  terminal closed on purpose stays closed. */
export function legacyTerminalSessions(
  owners: readonly { leafId: string; sessionId: string | null }[],
  entryFor: (leafId: string) => Pick<PaneSideDockEntry, 'open' | 'surface'>
): string[] {
  const sessions = new Set<string>();
  for (const { leafId, sessionId } of owners) {
    const entry = entryFor(leafId);
    if (sessionId && entry.open && entry.surface === PANE_DOCK_TERMINAL_SURFACE) sessions.add(sessionId);
  }
  return [...sessions];
}

type StoredSessionSurface = { surface: typeof PANE_DOCK_TERMINAL_SURFACE; source?: string };

/** What a reload brings back, keyed by the session that owns the dock: its
 *  terminal (its own, or the child's it shows). A browser is not restored:
 *  its pages do not survive a restart, and an empty panel would come back. */
export function storableSessionSurfaces(
  surfaces: ReadonlyMap<string, SessionSideSurface>,
  sources: ReadonlyMap<string, SessionSurfaceSource>
): Record<string, StoredSessionSurface> {
  const stored: Record<string, StoredSessionSurface> = {};
  for (const [sessionId, surface] of surfaces) {
    if (surface !== PANE_DOCK_TERMINAL_SURFACE) continue;
    const source = sources.get(sessionId);
    stored[sessionId] = source?.surface === surface ? { surface, source: source.sessionId } : { surface };
  }
  return stored;
}

/** The session surface maps a stored value restores; empty for anything else. */
export function restoredSessionSurfaces(value: unknown): {
  surfaces: Map<string, SessionSideSurface>;
  sources: Map<string, SessionSurfaceSource>;
} {
  const surfaces = new Map<string, SessionSideSurface>();
  const sources = new Map<string, SessionSurfaceSource>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { surfaces, sources };
  for (const [sessionId, entry] of Object.entries(value as Record<string, unknown>)) {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    if (!sessionId.trim() || record?.surface !== PANE_DOCK_TERMINAL_SURFACE) continue;
    surfaces.set(sessionId, PANE_DOCK_TERMINAL_SURFACE);
    const source = typeof record.source === 'string' ? record.source.trim() : '';
    if (source && source !== sessionId)
      sources.set(sessionId, { sessionId: source, surface: PANE_DOCK_TERMINAL_SURFACE });
  }
  return { surfaces, sources };
}

/** Immutable per-session map update: `null` removes the session's entry, and
 *  an unchanged value (per `same`) hands back the current map identity. */
function withSessionEntry<T>(
  current: ReadonlyMap<string, T>,
  sessionId: string,
  value: T | null,
  same: (existing: T, next: T) => boolean = Object.is
): ReadonlyMap<string, T> {
  const cleanSessionId = sessionId.trim();
  if (!cleanSessionId) return current;
  if (value === null) {
    if (!current.has(cleanSessionId)) return current;
    const next = new Map(current);
    next.delete(cleanSessionId);
    return next;
  }
  const existing = current.get(cleanSessionId);
  if (existing !== undefined && same(existing, value)) return current;
  const next = new Map(current);
  next.set(cleanSessionId, value);
  return next;
}

export function withSessionSideSurface(
  current: ReadonlyMap<string, SessionSideSurface>,
  sessionId: string,
  surface: SessionSideSurface | null
): ReadonlyMap<string, SessionSideSurface> {
  return withSessionEntry(current, sessionId, surface);
}

export function withSessionSurfaceSource(
  current: ReadonlyMap<string, SessionSurfaceSource>,
  sessionId: string,
  source: SessionSurfaceSource | null
): ReadonlyMap<string, SessionSurfaceSource> {
  return withSessionEntry(
    current,
    sessionId,
    source,
    (left, right) => left.sessionId === right.sessionId && left.surface === right.surface
  );
}

function sameNavigationTarget(left: PaneSideDockDiff, right: PaneSideDockDiff): boolean {
  return navigationKey(left) === navigationKey(right);
}

/** The Session Diff rows' open file, per session: it never enters the pane's
 *  own dock entry, so another session in the same pane sees the pane exactly
 *  as it was (closed stays closed) and the diff column returns with its
 *  session. */
export function withSessionDiff(
  current: ReadonlyMap<string, PaneSideDockDiff>,
  sessionId: string,
  diff: PaneSideDockDiff | null
): ReadonlyMap<string, PaneSideDockDiff> {
  return withSessionEntry(current, sessionId, diff, sameNavigationTarget);
}

/** Session-owned classic panel views: today only the Session Diff list. The
 *  browser and terminal ride `SessionSideSurface` above; the diff FILE rides
 *  `withSessionDiff`. The list is session-owned, never kept on the pane entry,
 *  so it cannot leak across sessions in the same pane. */
export type SessionSidePanelView = 'session-diff' | 'visualize' | 'routines' | 'room';

export const isSessionSidePanelView = (view: unknown): view is SessionSidePanelView =>
  view === 'session-diff' || view === 'visualize' || view === 'routines' || view === 'room';

/** `view` when the tab's own right-side groups (paneRightGroupsFor) hold it,
 *  else null: a view remembered for another session kind (Routines off a
 *  home thread, the room panel off a room) is neither stored nor shown, so
 *  the dock never falls back to an unrelated first view. */
export function sessionPanelViewIn(
  groups: readonly (readonly string[])[],
  view: SessionSidePanelView | null | undefined
): SessionSidePanelView | null {
  return view && groups.some((group) => group.includes(view)) ? view : null;
}

export function withSessionPanelView(
  current: ReadonlyMap<string, SessionSidePanelView>,
  sessionId: string,
  view: SessionSidePanelView | null
): ReadonlyMap<string, SessionSidePanelView> {
  return withSessionEntry(current, sessionId, view);
}

/** The pane entry as the tab `sessionId` sees it: file tabs, a Files tree or
 *  a git diff in front belong to the session they were brought up beside
 *  (`owner`). Any other tab of the pane — another session, a bot chat, a
 *  draft — sees the dock as if closed; the owner gets it back as it was. */
export function paneDockEntryForSession(entry: PaneSideDockEntry, sessionId: string): PaneSideDockEntry {
  const restored = paneDockRestored(entry, sessionId);
  if (restored !== entry || !paneDockForeign(entry, sessionId)) return restored;
  // Any other tab sees the front parked for it (a pane-level view another
  // tab opened), else the dock closed.
  const parked = entry.parked && !paneLocalSurface(entry.parked.surface) ? entry.parked : null;
  return { ...entry, open: parked?.open ?? false, surface: parked?.surface ?? '' };
}

/**
 * Session-owned surfaces override the pane's remembered panel only for their
 * own session. A pane-local (git) diff stays in front of its own session
 * until it closes; a session's own diff rides in front of that session only.
 * `panelViewInFront`: the session's panel view was opened after its
 * browser/terminal (an agent's visualize open), so it shows while the
 * browser/terminal stays behind it — the latest explicit open wins.
 */
export function sessionSideDockEntryForSession(
  entry: PaneSideDockEntry,
  sessionId: string,
  surface: SessionSideSurface | null,
  sessionDiff: PaneSideDockDiff | null = null,
  sessionPanelView: SessionSidePanelView | null = null,
  panelViewInFront = false
): PaneSideDockEntry {
  // A session diff persisted into the pane entry by an older build belongs to
  // no pane: drop it so the session map below is the only owner.
  const base = paneDockEntryForSession(
    entry.surface === PANE_DOCK_DIFF_SURFACE && entry.diff?.source === 'session'
      ? { ...entry, surface: '', diff: null }
      : entry,
    sessionId
  );
  if (sessionId && sessionDiff) {
    if (
      base.open &&
      base.surface === PANE_DOCK_DIFF_SURFACE &&
      base.diff &&
      navigationKey(base.diff) === navigationKey(sessionDiff)
    )
      return base;
    return { ...base, open: true, surface: PANE_DOCK_DIFF_SURFACE, diff: sessionDiff };
  }
  if (
    base.surface === PANE_DOCK_DIFF_SURFACE ||
    base.surface === PANE_DOCK_FILE_SURFACE ||
    base.surface === PANE_DOCK_FILES_SURFACE
  )
    return base;
  if (sessionId && surface && !(sessionPanelView && panelViewInFront)) {
    if (base.open && base.surface === surface) return base;
    return { ...base, open: true, surface };
  }
  // A session-owned panel view (the Session Diff list) rides only its own
  // session, exactly like the browser/terminal surfaces above: switching
  // back restores it even when the pane's remembered view moved on.
  if (sessionId && sessionPanelView) {
    if (base.open && base.surface === '' && base.view === sessionPanelView) return base;
    return { ...base, open: true, surface: '', view: sessionPanelView };
  }
  if (base.surface !== PANE_DOCK_BROWSER_SURFACE && base.surface !== PANE_DOCK_TERMINAL_SURFACE) {
    // A session-owned view never leaks across sessions: a pane showing
    // Session Diff for one session folds for a session that never opened it,
    // and for a pane with no session behind it (a New Task draft).
    if (isSessionSidePanelView(base.view)) {
      if (!base.open && base.surface === '') return base;
      return { ...base, open: false, surface: '' };
    }
    return base;
  }
  return { ...base, open: false, surface: '' };
}
