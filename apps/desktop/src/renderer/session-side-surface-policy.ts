import {
  PANE_DOCK_BROWSER_SURFACE,
  PANE_DOCK_DIFF_SURFACE,
  PANE_DOCK_TERMINAL_SURFACE,
  type PaneSideDockDiff,
  type PaneSideDockEntry,
} from "./pane-side-dock";
import { navigationKey } from "./text-format";

export type SessionSideSurface =
  | typeof PANE_DOCK_BROWSER_SURFACE
  | typeof PANE_DOCK_TERMINAL_SURFACE;

export function withSessionSideSurface(
  current: ReadonlyMap<string, SessionSideSurface>,
  sessionId: string,
  surface: SessionSideSurface | null,
): ReadonlyMap<string, SessionSideSurface> {
  const cleanSessionId = sessionId.trim();
  if (!cleanSessionId) return current;
  if (surface === null) {
    if (!current.has(cleanSessionId)) return current;
    const next = new Map(current);
    next.delete(cleanSessionId);
    return next;
  }
  if (current.get(cleanSessionId) === surface) return current;
  const next = new Map(current);
  next.set(cleanSessionId, surface);
  return next;
}

/** The Session Diff rows' open file, per session: it never enters the pane's
 *  own dock entry, so another session in the same pane sees the pane exactly
 *  as it was (closed stays closed) and the diff column returns with its
 *  session (user: 세션 종속이라 다른 쪽으로 넘어가면 그 세션 기본값으로). */
export function withSessionDiff(
  current: ReadonlyMap<string, PaneSideDockDiff>,
  sessionId: string,
  diff: PaneSideDockDiff | null,
): ReadonlyMap<string, PaneSideDockDiff> {
  const cleanSessionId = sessionId.trim();
  if (!cleanSessionId) return current;
  if (diff === null) {
    if (!current.has(cleanSessionId)) return current;
    const next = new Map(current);
    next.delete(cleanSessionId);
    return next;
  }
  const existing = current.get(cleanSessionId);
  if (existing && navigationKey(existing) === navigationKey(diff)) return current;
  const next = new Map(current);
  next.set(cleanSessionId, diff);
  return next;
}

/** Session-owned classic panel views: today only the Session Diff list. The
 *  browser and terminal ride `SessionSideSurface` above; the diff FILE rides
 *  `withSessionDiff`. The list used to live in the pane entry itself, so it
 *  leaked across sessions in the same pane (user: 다른 세션으로 넘어가면 그
 *  세션 기본값으로 — 안 열려 있었으면 닫아줘야). */
export type SessionSidePanelView = "session-diff";

export function withSessionPanelView(
  current: ReadonlyMap<string, SessionSidePanelView>,
  sessionId: string,
  view: SessionSidePanelView | null,
): ReadonlyMap<string, SessionSidePanelView> {
  const cleanSessionId = sessionId.trim();
  if (!cleanSessionId) return current;
  if (view === null) {
    if (!current.has(cleanSessionId)) return current;
    const next = new Map(current);
    next.delete(cleanSessionId);
    return next;
  }
  if (current.get(cleanSessionId) === view) return current;
  const next = new Map(current);
  next.set(cleanSessionId, view);
  return next;
}

/**
 * Session-owned surfaces override the pane's remembered panel only for their
 * own session. A pane-local (git) diff stays in front until it closes; a
 * session's own diff rides in front of that session only.
 */
export function sessionSideDockEntryForSession(
  entry: PaneSideDockEntry,
  sessionId: string,
  surface: SessionSideSurface | null,
  sessionDiff: PaneSideDockDiff | null = null,
  sessionPanelView: SessionSidePanelView | null = null,
): PaneSideDockEntry {
  // A session diff persisted into the pane entry by an older build belongs to
  // no pane: drop it so the session map below is the only owner.
  const base = entry.surface === PANE_DOCK_DIFF_SURFACE && entry.diff?.source === "session"
    ? { ...entry, surface: "", diff: null }
    : entry;
  if (sessionId && sessionDiff) {
    if (base.open && base.surface === PANE_DOCK_DIFF_SURFACE && base.diff
      && navigationKey(base.diff) === navigationKey(sessionDiff)) return base;
    return { ...base, open: true, surface: PANE_DOCK_DIFF_SURFACE, diff: sessionDiff };
  }
  if (base.surface === PANE_DOCK_DIFF_SURFACE) return base;
  if (sessionId && surface) {
    if (base.open && base.surface === surface) return base;
    return { ...base, open: true, surface };
  }
  // A session-owned panel view (the Session Diff list) rides only its own
  // session, exactly like the browser/terminal surfaces above: switching
  // back restores it even when the pane's remembered view moved on.
  if (sessionId && sessionPanelView) {
    if (base.open && base.surface === "" && base.view === sessionPanelView) return base;
    return { ...base, open: true, surface: "", view: sessionPanelView };
  }
  if (base.surface !== PANE_DOCK_BROWSER_SURFACE
    && base.surface !== PANE_DOCK_TERMINAL_SURFACE) {
    // A session-owned view never leaks across sessions: a pane showing
    // Session Diff for one session folds for a session that never opened it
    // (user: 거기 안 열려 있었으면 닫아줘야).
    if (sessionId && base.view === "session-diff") {
      if (!base.open && base.surface === "") return base;
      return { ...base, open: false, surface: "" };
    }
    return base;
  }
  return { ...base, open: false, surface: "" };
}
