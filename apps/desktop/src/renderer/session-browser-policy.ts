import type { DesktopBrowserOpenRequest } from "../shared/contract";

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
