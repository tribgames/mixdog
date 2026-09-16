import { useCallback, useEffect, useRef, useState } from 'react';

import { releaseSessionDiff } from './session-diff-cache';
import { useSessionBrowserSurfaces } from './session-browser-surfaces';
import {
  withSessionDiff,
  withSessionPanelView,
  withSessionSideSurface,
  type SessionSidePanelView,
  type SessionSideSurface,
} from './session-side-surface-policy';
import { useSessionTerminalSurfaces } from './session-terminal-surfaces';
import type { PaneSideDockDiff } from './pane-side-dock';

export function useSessionPaneSurfaces() {
  const browserSurfaces = useSessionBrowserSurfaces();
  const terminalSurfaces = useSessionTerminalSurfaces();
  const [sessionSideSurfaces, setSessionSideSurfaces] = useState<ReadonlyMap<string, SessionSideSurface>>(
    () => new Map()
  );
  const [sessionPanelViews, setSessionPanelViews] = useState<ReadonlyMap<string, SessionSidePanelView>>(
    () => new Map()
  );
  const [sessionDiffs, setSessionDiffs] = useState<ReadonlyMap<string, PaneSideDockDiff>>(() => new Map());
  const pendingBrowserAutoReveal = useRef(new Set<string>());
  const browserAutoRevealSuppressed = useRef(new Set<string>());
  const surfaceRevisions = useRef(new Map<string, number>());

  const setSessionSideSurface = useCallback((sessionId: string, surface: SessionSideSurface | null) => {
    if (surface === 'browser') browserAutoRevealSuppressed.current.delete(sessionId);
    surfaceRevisions.current.set(sessionId, (surfaceRevisions.current.get(sessionId) ?? 0) + 1);
    setSessionSideSurfaces((current) => withSessionSideSurface(current, sessionId, surface));
  }, []);

  const beginTemporaryBrowserSurface = useCallback((sessionId: string) => {
    const revision = (surfaceRevisions.current.get(sessionId) ?? 0) + 1;
    surfaceRevisions.current.set(sessionId, revision);
    let previous: SessionSideSurface | null = null;
    setSessionSideSurfaces((current) => {
      previous = current.get(sessionId) ?? null;
      return withSessionSideSurface(current, sessionId, 'browser');
    });
    return () => {
      if (surfaceRevisions.current.get(sessionId) !== revision) return;
      surfaceRevisions.current.set(sessionId, revision + 1);
      pendingBrowserAutoReveal.current.delete(sessionId);
      setSessionSideSurfaces((current) =>
        current.get(sessionId) === 'browser' ? withSessionSideSurface(current, sessionId, previous) : current
      );
    };
  }, []);

  const hideBrowserSurface = useCallback((sessionId: string) => {
    surfaceRevisions.current.set(sessionId, (surfaceRevisions.current.get(sessionId) ?? 0) + 1);
    pendingBrowserAutoReveal.current.delete(sessionId);
    setSessionSideSurfaces((current) =>
      current.get(sessionId) === 'browser' ? withSessionSideSurface(current, sessionId, null) : current
    );
  }, []);

  const dismissBrowserSurface = useCallback(
    (sessionId: string) => {
      browserAutoRevealSuppressed.current.add(sessionId);
      hideBrowserSurface(sessionId);
    },
    [hideBrowserSurface]
  );

  const setSessionPanelView = useCallback((sessionId: string, view: SessionSidePanelView | null) => {
    setSessionPanelViews((current) => withSessionPanelView(current, sessionId, view));
  }, []);

  const setSessionDiff = useCallback((sessionId: string, diff: PaneSideDockDiff | null) => {
    setSessionDiffs((current) => withSessionDiff(current, sessionId, diff));
  }, []);

  const releaseDeletedSessionSurfaces = useCallback(
    (sessionId: string) => {
      browserAutoRevealSuppressed.current.delete(sessionId);
      pendingBrowserAutoReveal.current.delete(sessionId);
      setSessionSideSurfaces((current) => withSessionSideSurface(current, sessionId, null));
      setSessionDiffs((current) => withSessionDiff(current, sessionId, null));
      setSessionPanelViews((current) => withSessionPanelView(current, sessionId, null));
      releaseSessionDiff(sessionId);
      browserSurfaces.release(sessionId);
      terminalSurfaces.release(sessionId);
    },
    [browserSurfaces, terminalSurfaces]
  );

  useEffect(
    () =>
      window.mixdogDesktop?.onBrowserRemoteViewerChanged?.((change) => {
        browserSurfaces.setRemoteViewed(String(change?.sessionId || ''), change?.active === true);
      }),
    [browserSurfaces]
  );

  useEffect(
    () =>
      window.mixdogDesktop?.onBrowserSessionReleased?.((sessionId, reason) => {
        if (reason !== 'unloaded') hideBrowserSurface(sessionId);
        browserSurfaces.release(sessionId);
      }),
    [browserSurfaces, hideBrowserSurface]
  );

  return {
    browserSurfaces,
    beginTemporaryBrowserSurface,
    browserAutoRevealSuppressed,
    dismissBrowserSurface,
    hideBrowserSurface,
    pendingBrowserAutoReveal,
    releaseDeletedSessionSurfaces,
    sessionDiffs,
    sessionPanelViews,
    sessionSideSurfaces,
    setSessionDiff,
    setSessionPanelView,
    setSessionSideSurface,
    terminalSurfaces,
  };
}
