import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { noteBrowserRemoteViewer } from './browser-remote-drive';
import { releaseSessionDiff } from './session-diff-cache';
import { releaseFullToolOutputs } from './tool-full-output';
import { useSessionBrowserSurfaces } from './session-browser-surfaces';
import {
  withSessionDiff,
  withSessionPanelView,
  withSessionSideSurface,
  type SessionSidePanelView,
  type SessionSideSurface,
} from './session-side-surface-policy';
import { useSessionTerminalSurfaces } from './session-terminal-surfaces';
import {
  readRoutinesTilePreference,
  routinesTileOpenAfter,
  withRoutinesPanelDefault,
  writeRoutinesTileOpen,
} from './routines-tile';
import { routineOwners } from './routines-model';
import { OPEN_AGENT_PANEL_EVENT } from './agent-panel-tab';
import { useMobileRemoteSurface } from './mobile-surface';
import { record } from './record-utils';
import { useSidebarReferences } from './sidebar-reference-cache';
import type { PaneSideDockDiff } from './pane-side-dock';

const ROUTINE_OWNER_KEYS = ['channelSetup'] as const;

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

  const setSessionSideSurface = useCallback((sessionId: string, surface: SessionSideSurface | null) => {
    if (surface === 'browser') browserAutoRevealSuppressed.current.delete(sessionId);
    setSessionSideSurfaces((current) => withSessionSideSurface(current, sessionId, surface));
  }, []);

  const hideBrowserSurface = useCallback((sessionId: string) => {
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

  // The Routines tile preference (routines-tile.ts): every home thread shows
  // it while open; opening, switching or closing a home thread's panel sets it.
  // Before the user sets it, only homes of agents owning a routine show it.
  // The phone never fills it in: there the dock is a full-screen sheet, so a
  // contact tap must land on the chat and the tile opens only from the
  // thread header's own button.
  const phone = useMobileRemoteSurface();
  const [routinesTile, setRoutinesTile] = useState(readRoutinesTilePreference);
  const { values: routineReferences } = useSidebarReferences(
    window.mixdogDesktop,
    ROUTINE_OWNER_KEYS,
    !phone && routinesTile === null
  );
  const owners = useMemo(() => routineOwners(record(routineReferences.channelSetup)), [routineReferences]);
  const setSessionPanelView = useCallback((sessionId: string, view: SessionSidePanelView | null) => {
    const tileOpen = routinesTileOpenAfter(sessionId, view);
    if (tileOpen !== null) {
      writeRoutinesTileOpen(tileOpen);
      setRoutinesTile(tileOpen ? 'open' : 'closed');
    }
    setSessionPanelViews((current) => withSessionPanelView(current, sessionId, view));
  }, []);
  // "프로필 보기" and the agent's name in its tab open that thread's panel.
  useEffect(() => {
    const open = (event: Event) => {
      const sessionId = String((event as CustomEvent<{ sessionId?: unknown }>).detail?.sessionId || '');
      if (sessionId) setSessionPanelView(sessionId, 'routines');
    };
    window.addEventListener(OPEN_AGENT_PANEL_EVENT, open);
    return () => window.removeEventListener(OPEN_AGENT_PANEL_EVENT, open);
  }, [setSessionPanelView]);
  const displayedPanelViews = useMemo(
    () => (phone ? sessionPanelViews : withRoutinesPanelDefault(sessionPanelViews, routinesTile, owners)),
    [phone, sessionPanelViews, routinesTile, owners]
  );

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
      releaseFullToolOutputs(sessionId);
      browserSurfaces.release(sessionId);
      terminalSurfaces.release(sessionId);
    },
    [browserSurfaces, terminalSurfaces]
  );

  useEffect(
    () =>
      window.mixdogDesktop?.onBrowserRemoteViewerChanged?.((change) => {
        noteBrowserRemoteViewer(change);
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
    browserAutoRevealSuppressed,
    dismissBrowserSurface,
    hideBrowserSurface,
    pendingBrowserAutoReveal,
    releaseDeletedSessionSurfaces,
    sessionDiffs,
    sessionPanelViews: displayedPanelViews,
    sessionSideSurfaces,
    setSessionDiff,
    setSessionPanelView,
    setSessionSideSurface,
    terminalSurfaces,
  };
}
