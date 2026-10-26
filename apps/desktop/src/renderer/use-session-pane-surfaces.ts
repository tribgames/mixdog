import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { noteBrowserRemoteViewer } from './browser-remote-drive';
import { releaseSessionDiff } from './session-diff-cache';
import { releaseFullToolOutputs } from './tool-full-output';
import { useSessionBrowserSurfaces } from './session-browser-surfaces';
import {
  restoredSessionSurfaces,
  SESSION_DOCK_SURFACES_KEY,
  storableSessionSurfaces,
  withSessionDiff,
  withSessionPanelView,
  withSessionSideSurface,
  withSessionSurfaceSource,
  type SessionSidePanelView,
  type SessionSideSurface,
  type SessionSurfaceSource,
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
import { clearBorrowedBrowserTab, releaseBorrowedBrowserTabsOf } from './browser-pane-borrowed-tab';
import { forgetChildSurfacePages } from './child-surface-peeks';

const ROUTINE_OWNER_KEYS = ['channelSetup'] as const;

/** A dock view an agent reveal (or the agent panel event) left for a session
 *  no pane shows yet: selected in its pane once one shows it, in front of
 *  that session's own file tabs or diff. */
export type PendingDockReveal = 'terminal' | 'visualize' | 'routines';

/** The page a waiting browser reveal named (its session-local id, and how
 *  the owner conversation names the session); null when it named none. */
export type PendingBrowserPage = { tabId: string; ownerName: string } | null;

/** The stored session surfaces; `stored` is false before this build ever
 *  wrote them (an upgrade: the pane-keyed terminals migrate, useAppSideDocks). */
function readStoredSessionSurfaces() {
  try {
    const raw = window.localStorage.getItem(SESSION_DOCK_SURFACES_KEY);
    return { ...restoredSessionSurfaces(JSON.parse(raw || 'null')), stored: raw !== null };
  } catch {
    return { ...restoredSessionSurfaces(null), stored: false };
  }
}

/** Hosts whose dock shows `sessionId`'s terminal, with it dropped. */
function withoutSourceHosts(
  surfaces: ReadonlyMap<string, SessionSideSurface>,
  sources: ReadonlyMap<string, SessionSurfaceSource>,
  sessionId: string
): ReadonlyMap<string, SessionSideSurface> {
  let next = surfaces;
  for (const [host, source] of sources) {
    if (source.sessionId !== sessionId) continue;
    if (next.get(host) === source.surface) next = withSessionSideSurface(next, host, null);
  }
  return next;
}

export function useSessionPaneSurfaces() {
  const browserSurfaces = useSessionBrowserSurfaces();
  const terminalSurfaces = useSessionTerminalSurfaces();
  // Dock surfaces persist by the session that owns the dock (a pane shows
  // whichever session is in front), so a reload gives each session its own.
  const [restoredSurfaces] = useState(readStoredSessionSurfaces);
  const [sessionSideSurfaces, setSessionSideSurfaces] = useState<ReadonlyMap<string, SessionSideSurface>>(
    () => restoredSurfaces.surfaces
  );
  const [sessionSurfaceSources, setSessionSurfaceSources] = useState<ReadonlyMap<string, SessionSurfaceSource>>(
    () => restoredSurfaces.sources
  );
  // Sessions whose panel view opened after their browser/terminal: it shows,
  // the browser/terminal staying behind it (sessionSideDockEntryForSession).
  const [panelViewFronts, setPanelViewFronts] = useState<ReadonlySet<string>>(() => new Set());
  const setPanelViewFront = useCallback((sessionId: string, front: boolean) => {
    setPanelViewFronts((current) => {
      if (current.has(sessionId) === front) return current;
      const next = new Set(current);
      if (front) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);
  const [sessionPanelViews, setSessionPanelViews] = useState<ReadonlyMap<string, SessionSidePanelView>>(
    () => new Map()
  );
  const [sessionDiffs, setSessionDiffs] = useState<ReadonlyMap<string, PaneSideDockDiff>>(() => new Map());
  // A browser reveal waiting for its session's chain to be on screen, with
  // the page it named: one entry, so a hide, a suppression or a deletion
  // drops the page with it.
  const pendingBrowserAutoReveal = useRef(new Map<string, PendingBrowserPage>());
  const browserAutoRevealSuppressed = useRef(new Set<string>());
  const pendingDockReveals = useRef(new Map<string, PendingDockReveal>());
  const [dockRevealTick, setDockRevealTick] = useState(0);

  // Until an upgrade's pane-keyed terminals migrated, nothing is written: the
  // new key's absence is what tells a later start to migrate them.
  const [surfacesMigrated, setSurfacesMigrated] = useState(restoredSurfaces.stored);
  /** An upgrade: the sessions whose terminal the old pane-keyed dock store
   *  held open (session-side-surface-policy legacyTerminalSessions) get it
   *  back, and the session-keyed store takes over. */
  const migrateLegacyTerminals = useCallback((sessionIds: readonly string[]) => {
    setSessionSideSurfaces((current) => {
      let next = current;
      for (const sessionId of sessionIds) next = withSessionSideSurface(next, sessionId, 'terminal');
      return next;
    });
    setSurfacesMigrated(true);
  }, []);
  useEffect(() => {
    if (!surfacesMigrated) return;
    try {
      window.localStorage.setItem(
        SESSION_DOCK_SURFACES_KEY,
        JSON.stringify(storableSessionSurfaces(sessionSideSurfaces, sessionSurfaceSources))
      );
    } catch {
      // The surfaces stay for this renderer's lifetime.
    }
  }, [surfacesMigrated, sessionSideSurfaces, sessionSurfaceSources]);

  const queueDockReveal = useCallback((sessionId: string, view: PendingDockReveal | null) => {
    if (view) pendingDockReveals.current.set(sessionId, view);
    else pendingDockReveals.current.delete(sessionId);
    setDockRevealTick((tick) => tick + 1);
  }, []);

  /** The session's own browser/terminal (or none): any child surface its
   *  dock showed gives way. */
  const setSessionSideSurface = useCallback(
    (sessionId: string, surface: SessionSideSurface | null) => {
      if (surface === 'browser') browserAutoRevealSuppressed.current.delete(sessionId);
      setPanelViewFront(sessionId, false);
      setSessionSurfaceSources((current) => withSessionSurfaceSource(current, sessionId, null));
      setSessionSideSurfaces((current) => withSessionSideSurface(current, sessionId, surface));
    },
    [setPanelViewFront]
  );

  /** A child session's terminal revealed in the dock of `hostSessionId`, the
   *  conversation of its owner chain on screen. (A child's browser page shows
   *  there as a borrowed tab instead: use-agent-browser-surface-requests.) */
  const showSessionSurface = useCallback(
    (hostSessionId: string, sourceSessionId: string, surface: 'terminal') => {
      if (hostSessionId === sourceSessionId) {
        setSessionSideSurface(hostSessionId, surface);
        return;
      }
      setPanelViewFront(hostSessionId, false);
      setSessionSurfaceSources((current) =>
        withSessionSurfaceSource(current, hostSessionId, { sessionId: sourceSessionId, surface })
      );
      setSessionSideSurfaces((current) => withSessionSideSurface(current, hostSessionId, surface));
    },
    [setSessionSideSurface, setPanelViewFront]
  );

  const sourcesRef = useRef(sessionSurfaceSources);
  sourcesRef.current = sessionSurfaceSources;
  /** Folds `sessionId`'s browser: its own dock's, and every owner's dock
   *  showing its page. Every conversation borrowing one of its pages forgets
   *  it (browser-pane-borrowed-tab), whatever its dock shows now; only the
   *  docks on that browser fold. */
  const hideBrowserSurface = useCallback((sessionId: string) => {
    pendingBrowserAutoReveal.current.delete(sessionId);
    const borrowers = releaseBorrowedBrowserTabsOf(sessionId);
    setSessionSideSurfaces((current) => {
      let next = current.get(sessionId) === 'browser' ? withSessionSideSurface(current, sessionId, null) : current;
      for (const host of borrowers) {
        if (next.get(host) === 'browser') next = withSessionSideSurface(next, host, null);
      }
      return next;
    });
  }, []);

  const dismissBrowserSurface = useCallback(
    (sessionId: string) => {
      browserAutoRevealSuppressed.current.add(sessionId);
      // The viewer's own dock closing also drops the page it borrowed, so it
      // reopens on its own browser (every dock close path ends here).
      clearBorrowedBrowserTab(sessionId);
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
  /** `agent`: an agent's reveal (visualize) put the view there, not the
   *  user, so the Routines tile preference stays as the user left it.
   *  `front`: the view opens in front of the session's browser/terminal,
   *  which stays (the latest explicit open wins). */
  const setSessionPanelView = useCallback(
    (sessionId: string, view: SessionSidePanelView | null, options?: { agent?: boolean; front?: boolean }) => {
      const tileOpen = options?.agent ? null : routinesTileOpenAfter(sessionId, view);
      if (tileOpen !== null) {
        writeRoutinesTileOpen(tileOpen);
        setRoutinesTile(tileOpen ? 'open' : 'closed');
      }
      setPanelViewFront(sessionId, Boolean(view && options?.front));
      setSessionPanelViews((current) => withSessionPanelView(current, sessionId, view));
    },
    [setPanelViewFront]
  );
  // "프로필 보기" and the agent's name in its tab open that thread's panel,
  // in front of the thread's own file tabs, now or once a pane shows it.
  useEffect(() => {
    const open = (event: Event) => {
      const sessionId = String((event as CustomEvent<{ sessionId?: unknown }>).detail?.sessionId || '');
      if (!sessionId) return;
      setSessionPanelView(sessionId, 'routines');
      queueDockReveal(sessionId, 'routines');
    };
    window.addEventListener(OPEN_AGENT_PANEL_EVENT, open);
    return () => window.removeEventListener(OPEN_AGENT_PANEL_EVENT, open);
  }, [setSessionPanelView, queueDockReveal]);
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
      pendingDockReveals.current.delete(sessionId);
      // Owners showing the deleted session's surfaces fold them too; every
      // borrowed page of it is forgotten, on screen or not.
      const borrowers = releaseBorrowedBrowserTabsOf(sessionId);
      clearBorrowedBrowserTab(sessionId);
      forgetChildSurfacePages(sessionId);
      setSessionSideSurfaces((current) => {
        let next = withoutSourceHosts(withSessionSideSurface(current, sessionId, null), sourcesRef.current, sessionId);
        for (const host of borrowers) {
          if (next.get(host) === 'browser') next = withSessionSideSurface(next, host, null);
        }
        return next;
      });
      setSessionSurfaceSources((current) => {
        let next = withSessionSurfaceSource(current, sessionId, null);
        for (const [host, source] of next) {
          if (source.sessionId === sessionId) next = withSessionSurfaceSource(next, host, null);
        }
        return next;
      });
      setSessionDiffs((current) => withSessionDiff(current, sessionId, null));
      setSessionPanelViews((current) => withSessionPanelView(current, sessionId, null));
      setPanelViewFront(sessionId, false);
      releaseSessionDiff(sessionId);
      releaseFullToolOutputs(sessionId);
      browserSurfaces.release(sessionId);
      terminalSurfaces.release(sessionId);
    },
    [browserSurfaces, terminalSurfaces, setPanelViewFront]
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
    pendingDockReveals,
    dockRevealTick,
    queueDockReveal,
    releaseDeletedSessionSurfaces,
    sessionDiffs,
    sessionPanelViews: displayedPanelViews,
    sessionSideSurfaces,
    sessionSurfaceSources,
    surfacesMigrated,
    migrateLegacyTerminals,
    panelViewFronts,
    setSessionDiff,
    setSessionPanelView,
    setSessionSideSurface,
    showSessionSurface,
    terminalSurfaces,
  };
}
