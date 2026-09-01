import type { DesktopBrowserOpenRequest } from "../shared/contract";
import {
  PANE_DOCK_BROWSER_SURFACE,
  PANE_DOCK_DIFF_SURFACE,
  type PaneSideDockEntry,
} from "./pane-side-dock";

export type SessionBrowserPaneOwner = {
  leafId: string;
  sessionId: string | null;
};

export type SessionBrowserRevealPlan = {
  leafId: string | null;
};

export function browserSurfaceRequestShouldReveal(
  request: DesktopBrowserOpenRequest,
): boolean {
  return request.reveal !== false;
}

/**
 * A foreground Browser Use request reveals beside a visible owner. A hidden
 * owner stays parked until the user returns to it. Duplicate views prefer the
 * focused pane.
 */
export function browserSurfaceRevealPlan(
  owners: readonly SessionBrowserPaneOwner[],
  sessionId: string,
  focusedLeafId: string,
): SessionBrowserRevealPlan {
  const matching = owners.filter((owner) => owner.sessionId === sessionId);
  const leafId = matching.find((owner) => owner.leafId === focusedLeafId)?.leafId
    ?? matching[0]?.leafId
    ?? null;
  return { leafId };
}

export function withBrowserSessionRevealed(
  current: ReadonlySet<string>,
  sessionId: string,
  revealed: boolean,
): ReadonlySet<string> {
  const cleanSessionId = sessionId.trim();
  if (!cleanSessionId || current.has(cleanSessionId) === revealed) return current;
  const next = new Set(current);
  if (revealed) next.add(cleanSessionId);
  else next.delete(cleanSessionId);
  return next;
}

/**
 * Browser selection follows its session while the surrounding panel/diff
 * selection remains pane-scoped. An explicit diff temporarily stays above a
 * remembered Browser and closing it restores that session's Browser.
 */
export function browserDockEntryForSession(
  entry: PaneSideDockEntry,
  sessionId: string,
  revealed: boolean,
): PaneSideDockEntry {
  if (entry.surface === PANE_DOCK_DIFF_SURFACE) return entry;
  const surface = sessionId && revealed
    ? PANE_DOCK_BROWSER_SURFACE
    : entry.surface === PANE_DOCK_BROWSER_SURFACE ? "" : entry.surface;
  return surface === entry.surface ? entry : { ...entry, surface };
}
