import { useEffect, useRef } from 'react';

import { onBrowserPageRevealRequested } from './browser-page-request';

import type { DesktopBrowserOpenRequest } from '../shared/contract';
import {
  browserSurfaceRequestShouldReveal,
  browserSurfaceRevealPlan,
  type SessionBrowserPaneOwner,
} from './session-browser-policy';
import type { useSessionPaneSurfaces } from './use-session-pane-surfaces';

type BrowserSurfaceRequests = {
  owners: readonly SessionBrowserPaneOwner[];
  focusedLeafId: string;
  surfaces: Pick<
    ReturnType<typeof useSessionPaneSurfaces>,
    | 'browserSurfaces'
    | 'pendingBrowserAutoReveal'
    | 'setSessionSideSurface'
    | 'hideBrowserSurface'
    | 'browserAutoRevealSuppressed'
  >;
  prefetch(): Promise<unknown>;
  select(leafId: string, surface: 'browser'): void;
};

/** Visibility requests (the user's click, a takeover hand-off, an agent
 *  hide) never release the persistent browser root. Agent work alone sends
 *  none: the panel never opens by itself during a turn. */
export function useAgentBrowserSurfaceRequests(options: BrowserSurfaceRequests) {
  const { owners, focusedLeafId, surfaces, prefetch, select } = options;
  const { browserSurfaces, pendingBrowserAutoReveal, setSessionSideSurface, hideBrowserSurface } = surfaces;
  const handleRequest = (request: DesktopBrowserOpenRequest) => {
    const sessionId = String(request?.sessionId || '').trim();
    if (!sessionId) return;
    if (request.hide === true) {
      hideBrowserSurface(sessionId);
      return;
    }
    // A takeover needs the user on the page, even one whose panel they closed.
    if (request.handoff === true) surfaces.browserAutoRevealSuppressed.current.delete(sessionId);
    if (browserSurfaceRequestShouldReveal(request) && surfaces.browserAutoRevealSuppressed.current.has(sessionId)) {
      pendingBrowserAutoReveal.current.delete(sessionId);
      return;
    }
    void prefetch().catch(() => {});
    browserSurfaces.ensure(sessionId);
    if (!browserSurfaceRequestShouldReveal(request)) return;
    setSessionSideSurface(sessionId, 'browser');
    const plan = browserSurfaceRevealPlan(owners, sessionId, focusedLeafId);
    if (plan.leafId) {
      pendingBrowserAutoReveal.current.delete(sessionId);
      select(plan.leafId, 'browser');
    } else {
      pendingBrowserAutoReveal.current.add(sessionId);
    }
  };
  const requestRef = useRef(handleRequest);
  requestRef.current = handleRequest;
  useEffect(
    () =>
      window.mixdogDesktop?.onBrowserOpenRequested?.((request) => {
        requestRef.current(request);
      }),
    []
  );
  // A page card in the transcript: the user asked for the pane, so a panel
  // they closed earlier opens again and the layout change is theirs to keep.
  // An agent's hand-off (visualize) respects that closed panel instead.
  useEffect(
    () =>
      onBrowserPageRevealRequested(({ sessionId, agent }) => {
        if (!agent) surfaces.browserAutoRevealSuppressed.current.delete(sessionId);
        requestRef.current({ sessionId });
      }),
    [surfaces.browserAutoRevealSuppressed]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs on owner/focus/select changes; the ref sets are read at run time
  useEffect(() => {
    for (const sessionId of pendingBrowserAutoReveal.current) {
      if (surfaces.browserAutoRevealSuppressed.current.has(sessionId)) {
        pendingBrowserAutoReveal.current.delete(sessionId);
        continue;
      }
      const plan = browserSurfaceRevealPlan(owners, sessionId, focusedLeafId);
      if (!plan.leafId) continue;
      pendingBrowserAutoReveal.current.delete(sessionId);
      select(plan.leafId, 'browser');
    }
  }, [owners, focusedLeafId, pendingBrowserAutoReveal, select]);
}
