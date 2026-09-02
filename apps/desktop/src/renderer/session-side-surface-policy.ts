import {
  PANE_DOCK_BROWSER_SURFACE,
  PANE_DOCK_DIFF_SURFACE,
  PANE_DOCK_TERMINAL_SURFACE,
  type PaneSideDockEntry,
} from "./pane-side-dock";

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

/**
 * Session-owned surfaces override the pane's remembered panel only for their
 * own session. A pane-local diff stays in front until it closes.
 */
export function sessionSideDockEntryForSession(
  entry: PaneSideDockEntry,
  sessionId: string,
  surface: SessionSideSurface | null,
): PaneSideDockEntry {
  if (entry.surface === PANE_DOCK_DIFF_SURFACE) return entry;
  if (sessionId && surface) {
    if (entry.open && entry.surface === surface) return entry;
    return { ...entry, open: true, surface };
  }
  if (entry.surface !== PANE_DOCK_BROWSER_SURFACE
    && entry.surface !== PANE_DOCK_TERMINAL_SURFACE) return entry;
  return { ...entry, open: false, surface: "" };
}
