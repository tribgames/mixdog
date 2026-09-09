import { useEffect, useRef } from "react";

import type { DesktopBrowserOpenRequest } from "../shared/contract";
import {
  browserSurfaceRequestShouldReveal,
  browserSurfaceRevealPlan,
  type SessionBrowserPaneOwner,
} from "./session-browser-policy";
import type { useSessionPaneSurfaces } from "./use-session-pane-surfaces";

type BrowserSurfaceRequests = {
  owners: readonly SessionBrowserPaneOwner[];
  focusedLeafId: string;
  surfaces: Pick<ReturnType<typeof useSessionPaneSurfaces>,
    "browserSurfaces" | "pendingBrowserAutoReveal" | "setSessionSideSurface" | "hideBrowserSurface">;
  prefetch(): Promise<unknown>;
  select(leafId: string, surface: "browser"): void;
};

/** Agent visibility requests never release the persistent browser root. */
export function useAgentBrowserSurfaceRequests(options: BrowserSurfaceRequests) {
  const { owners, focusedLeafId, surfaces, prefetch, select } = options;
  const { browserSurfaces, pendingBrowserAutoReveal, setSessionSideSurface, hideBrowserSurface } = surfaces;
  const handleRequest = (request: DesktopBrowserOpenRequest) => {
    const sessionId = String(request?.sessionId || "").trim();
    if (!sessionId) return;
    if (request.hide === true) {
      hideBrowserSurface(sessionId);
      return;
    }
    void prefetch().catch(() => {});
    browserSurfaces.ensure(sessionId);
    if (!browserSurfaceRequestShouldReveal(request)) return;
    setSessionSideSurface(sessionId, "browser");
    const plan = browserSurfaceRevealPlan(owners, sessionId, focusedLeafId);
    if (plan.leafId) {
      pendingBrowserAutoReveal.current.delete(sessionId);
      select(plan.leafId, "browser");
    } else {
      pendingBrowserAutoReveal.current.add(sessionId);
    }
  };
  const requestRef = useRef(handleRequest);
  requestRef.current = handleRequest;
  useEffect(() => window.mixdogDesktop?.onBrowserOpenRequested?.((request) => {
    requestRef.current(request);
  }), []);
  useEffect(() => {
    for (const sessionId of pendingBrowserAutoReveal.current) {
      const plan = browserSurfaceRevealPlan(owners, sessionId, focusedLeafId);
      if (!plan.leafId) continue;
      pendingBrowserAutoReveal.current.delete(sessionId);
      select(plan.leafId, "browser");
    }
  }, [owners, focusedLeafId, pendingBrowserAutoReveal, select]);
}
