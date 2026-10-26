import { useEffect, useRef } from 'react';

import { onBrowserPageRevealRequested } from './browser-page-request';
import { clearBorrowedBrowserTab, showBorrowedBrowserTab } from './browser-pane-borrowed-tab';
import { moveChildSurfacePeek, recordChildSurfacePeek } from './child-surface-peeks';

import type { DesktopBrowserOpenRequest } from '../shared/contract';
import {
  browserSurfaceRequestShouldReveal,
  surfaceOwnerChain,
  surfaceRevealTarget,
  surfaceSessionName,
  type SessionBrowserPaneOwner,
  type SurfaceOwnerSources,
} from './session-browser-policy';
import type { PendingBrowserPage, useSessionPaneSurfaces } from './use-session-pane-surfaces';

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
  /** The ownership records reveals climb, read when a reveal runs. */
  ownerSources?: () => SurfaceOwnerSources;
  prefetch(): Promise<unknown>;
  select(leafId: string, surface: 'browser'): void;
};

const NO_OWNER_SOURCES: SurfaceOwnerSources = { sessions: [], pool: [] };

/** The page an agent's `open` (or a takeover) showed, and how its owner
 *  conversation names the session. */
type RevealedPage = NonNullable<PendingBrowserPage>;

const detailText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Visibility requests (the user's click, a takeover hand-off, an agent
 *  hide) never release the persistent browser root. Agent work alone sends
 *  none: the panel never opens by itself during a turn. A child session's
 *  reveal (a sub-agent, a bot's task session, a room member) opens in the
 *  dock of the conversation of its owner chain on screen, and that owner
 *  conversation gets the child's peek line. */
export function useAgentBrowserSurfaceRequests(options: BrowserSurfaceRequests) {
  const { owners, focusedLeafId, surfaces, prefetch, select } = options;
  const { browserSurfaces, pendingBrowserAutoReveal, setSessionSideSurface, hideBrowserSurface } = surfaces;
  const ownerSources = options.ownerSources ?? (() => NO_OWNER_SOURCES);
  /** Reveals `sessionId`'s browser where its chain is on screen; false when
   *  it cannot yet (the reveal then waits for the user to return). Another
   *  conversation of the chain shows a child's page the one way the
   *  transcript line does: as that page's borrowed tab in its own panel
   *  (browser-pane-borrowed-tab), so only a reveal naming its page can. */
  const reveal = (sessionId: string, chain: readonly string[], page: RevealedPage | null, park: boolean): boolean => {
    const target = surfaceRevealTarget(owners, chain, focusedLeafId);
    const own = target.leafId !== null && target.sessionId === sessionId;
    const borrowed = !own && target.leafId !== null && page !== null;
    const host = borrowed ? target.sessionId : sessionId;
    const done = () => pendingBrowserAutoReveal.current.delete(sessionId);
    if (surfaces.browserAutoRevealSuppressed.current.has(host)) {
      done();
      return true;
    }
    if (borrowed && page) {
      showBorrowedBrowserTab(host, { ownerSessionId: sessionId, ownerName: page.ownerName, tabId: page.tabId });
      setSessionSideSurface(host, 'browser');
      moveChildSurfacePeek(sessionId, 'browser', host);
    } else if (own || park) {
      // An agent's own page: the panel shows it, not a page it borrowed.
      if (own && page) clearBorrowedBrowserTab(sessionId);
      setSessionSideSurface(sessionId, 'browser');
    }
    if (!target.leafId || !(own || borrowed)) return false;
    done();
    select(target.leafId, 'browser');
    return true;
  };
  /** `ipc`: the host's request (agent work), as opposed to a transcript
   *  page request. `userAsked`: the user pressed for the pane. */
  const handleRequest = (request: DesktopBrowserOpenRequest, ipc: boolean, userAsked: boolean) => {
    const sessionId = String(request?.sessionId || '').trim();
    if (!sessionId) return;
    if (request.hide === true) {
      hideBrowserSurface(sessionId);
      return;
    }
    const sources = ownerSources();
    const chain = surfaceOwnerChain(sessionId, sources);
    const target = surfaceRevealTarget(owners, chain, focusedLeafId);
    const shouldReveal = browserSurfaceRequestShouldReveal(request);
    const failed = detailText(request.error);
    const tabId = detailText(request.tabId);
    const childName = surfaceSessionName(sessionId, sources);
    const page = tabId ? { tabId, ownerName: childName } : null;
    // The conversation whose panel the reveal opens (reveal below).
    const host = target.leafId && (target.sessionId === sessionId || page) ? target.sessionId : sessionId;
    // An agent's open from a child session the user is not looking at leaves
    // its line where the reveal goes: the nearest conversation of the chain
    // on screen, else the authoritative owner (a deferred reveal moves it on
    // arrival). A failed open: its reason, no 보기.
    const peekOwner = target.leafId ? target.sessionId : (chain.at(-1) ?? sessionId);
    if (ipc && shouldReveal && chain.length > 1 && peekOwner !== sessionId && (failed || page)) {
      recordChildSurfacePeek(peekOwner, {
        childSessionId: sessionId,
        childName,
        surface: 'browser',
        title: detailText(request.title),
        tabId,
        failed,
        at: Date.now(),
      });
    }
    if (failed) return;
    // A takeover needs the user on the page, even one whose panel they
    // closed; so does the user's own press.
    if (request.handoff === true || userAsked) {
      surfaces.browserAutoRevealSuppressed.current.delete(sessionId);
      surfaces.browserAutoRevealSuppressed.current.delete(host);
    }
    if (shouldReveal && surfaces.browserAutoRevealSuppressed.current.has(host)) {
      pendingBrowserAutoReveal.current.delete(sessionId);
      return;
    }
    void prefetch().catch(() => {});
    browserSurfaces.ensure(sessionId);
    if (!shouldReveal) return;
    if (!reveal(sessionId, chain, page, true)) pendingBrowserAutoReveal.current.set(sessionId, page);
  };
  const requestRef = useRef(handleRequest);
  requestRef.current = handleRequest;
  useEffect(
    () =>
      window.mixdogDesktop?.onBrowserOpenRequested?.((request) => {
        requestRef.current(request, true, false);
      }),
    []
  );
  // A page card in the transcript: the user asked for the pane, so a panel
  // they closed earlier opens again and the layout change is theirs to keep.
  // An agent's hand-off (visualize) respects that closed panel instead.
  useEffect(
    () =>
      onBrowserPageRevealRequested(({ sessionId, agent }) => {
        requestRef.current({ sessionId }, false, !agent);
      }),
    []
  );
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  const sourcesRef = useRef(ownerSources);
  sourcesRef.current = ownerSources;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs on owner/focus/select changes; the ref sets are read at run time
  useEffect(() => {
    for (const [sessionId, page] of [...pendingBrowserAutoReveal.current]) {
      revealRef.current(sessionId, surfaceOwnerChain(sessionId, sourcesRef.current()), page, false);
    }
  }, [owners, focusedLeafId, pendingBrowserAutoReveal, select]);
}
