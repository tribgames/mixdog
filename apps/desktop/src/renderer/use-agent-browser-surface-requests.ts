import { useEffect, useRef } from 'react';

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
    | 'beginTemporaryBrowserSurface'
    | 'browserAutoRevealSuppressed'
  >;
  prefetch(): Promise<unknown>;
  select(leafId: string, surface: 'browser'): void;
  temporarySelect?(leafId: string, surface: 'browser'): () => void;
};

/** Agent visibility requests never release the persistent browser root. */
export function useAgentBrowserSurfaceRequests(options: BrowserSurfaceRequests) {
  const { owners, focusedLeafId, surfaces, prefetch, select } = options;
  const { browserSurfaces, pendingBrowserAutoReveal, setSessionSideSurface, hideBrowserSurface } = surfaces;
  const temporary = useRef(
    new Map<
      string,
      {
        turnId: number;
        releaseSurface(): void;
        releaseDock?: () => void;
      }
    >()
  );
  const reveal = (sessionId: string, leafId: string) => {
    const entry = temporary.current.get(sessionId);
    if (entry && options.temporarySelect) {
      entry.releaseDock ??= options.temporarySelect(leafId, 'browser');
    } else select(leafId, 'browser');
  };
  const handleRequest = (request: DesktopBrowserOpenRequest) => {
    const sessionId = String(request?.sessionId || '').trim();
    if (!sessionId) return;
    if (request.retainTurnId !== undefined) {
      if (temporary.current.get(sessionId)?.turnId === request.retainTurnId) {
        // Keep the visible state, but discard the old restoration baseline so
        // a later task cannot fold a browser the user has taken over.
        temporary.current.delete(sessionId);
      }
      return;
    }
    if (request.restoreTurnId !== undefined) {
      const entry = temporary.current.get(sessionId);
      if (entry?.turnId !== request.restoreTurnId) return;
      temporary.current.delete(sessionId);
      pendingBrowserAutoReveal.current.delete(sessionId);
      entry.releaseSurface();
      entry.releaseDock?.();
      return;
    }
    if (request.hide === true) {
      const entry = temporary.current.get(sessionId);
      temporary.current.delete(sessionId);
      entry?.releaseSurface();
      entry?.releaseDock?.();
      hideBrowserSurface(sessionId);
      return;
    }
    if (browserSurfaceRequestShouldReveal(request) && surfaces.browserAutoRevealSuppressed.current.has(sessionId)) {
      pendingBrowserAutoReveal.current.delete(sessionId);
      return;
    }
    void prefetch().catch(() => {});
    browserSurfaces.ensure(sessionId);
    if (!browserSurfaceRequestShouldReveal(request)) return;
    if (Number.isSafeInteger(request.temporaryTurnId) && Number(request.temporaryTurnId) > 0) {
      const turnId = Number(request.temporaryTurnId);
      const entry = temporary.current.get(sessionId);
      if (entry && entry.turnId > turnId) return;
      if (entry) entry.turnId = turnId;
      else
        temporary.current.set(sessionId, {
          turnId,
          releaseSurface: surfaces.beginTemporaryBrowserSurface(sessionId),
        });
    } else {
      // Explicit open is a handoff, so the user's new layout is retained.
      temporary.current.delete(sessionId);
      setSessionSideSurface(sessionId, 'browser');
    }
    const plan = browserSurfaceRevealPlan(owners, sessionId, focusedLeafId);
    if (plan.leafId) {
      pendingBrowserAutoReveal.current.delete(sessionId);
      reveal(sessionId, plan.leafId);
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
  useEffect(() => {
    for (const sessionId of pendingBrowserAutoReveal.current) {
      if (surfaces.browserAutoRevealSuppressed.current.has(sessionId)) {
        pendingBrowserAutoReveal.current.delete(sessionId);
        continue;
      }
      const plan = browserSurfaceRevealPlan(owners, sessionId, focusedLeafId);
      if (!plan.leafId) continue;
      pendingBrowserAutoReveal.current.delete(sessionId);
      reveal(sessionId, plan.leafId);
    }
  }, [owners, focusedLeafId, pendingBrowserAutoReveal, select]);
}
