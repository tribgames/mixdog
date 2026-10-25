// Navigation that arrives from OUTSIDE the running app: a tapped push
// notification. The service worker focuses an existing window and names the
// session over postMessage, launches one at <scope>?session=… when nothing was
// running, and parks the tap either way. All three land here, and each is
// consumed exactly once.
import { useEffect, useRef } from 'react';

import type { DesktopApi } from '../shared/contract';
import { subscribeNativeNotificationActions } from './native-push-bridge';
import {
  claimNotificationClick,
  clearNotificationClick,
  routeNotificationTap,
  type NotificationTap,
  type PushHostEnvironment,
} from './push-notification-bridge';

const PUSH_OPEN_SESSION_MESSAGE = 'mixdog:open-session';
/** A tapped notification is about the newest reply: the pane showing that
 *  session returns to its latest row even when it was already open and the
 *  reader had scrolled up (a fresh entry anchors at the end on its own). */
export const NOTIFICATION_JUMP_LATEST_EVENT = 'mixdog:notification-jump-latest';

function requestJumpToLatest(sessionId: string): void {
  if (typeof window === 'undefined' || !sessionId) return;
  window.dispatchEvent(new window.CustomEvent(NOTIFICATION_JUMP_LATEST_EVENT, { detail: sessionId }));
}

export function usePushNotificationNavigation({
  ready,
  openSession,
  desktopReady,
  focusDesktopSession,
  switchHost = (url) => window.location.assign(url),
  hostEnvironment,
  hasSession,
}: {
  /** The catalog has to exist before a session id can resolve to a tab. */
  ready: boolean;
  openSession(sessionId: string): void;
  /** Desktop clicks need the restored pane layout, not the session catalog. */
  desktopReady: boolean;
  /** Reveals the session's open tab; false when none is open. */
  focusDesktopSession(sessionId: string): boolean;
  /** Moves this app to another paired PC's route (the PC switcher's way). */
  switchHost?(url: string): void;
  /** Test seam for the paired-PC lookup (push-notification-bridge.ts). */
  hostEnvironment?: PushHostEnvironment;
  /** Whether the loaded catalog still has the session; absent = open anything. */
  hasSession?(sessionId: string): boolean;
}): void {
  // A tap names the PC that sent it: open it here only when that is the PC
  // this page drives, otherwise move to that PC's route, which opens it.
  // Routing never waits for THIS PC's catalog: this PC may never become ready
  // (its pairing is gone, it is offline), and a tap from another PC must still
  // reach that PC. Only opening a session on this PC waits.
  const routeRef = useRef({ switchHost, hostEnvironment });
  routeRef.current = { switchHost, hostEnvironment };
  const hasSessionRef = useRef(hasSession);
  hasSessionRef.current = hasSession;
  const openRef = useRef((sessionId: string) => openSession(sessionId));
  openRef.current = (sessionId: string) => {
    // A session the loaded catalog no longer has (deleted since the
    // notification) is consumed here: the window is already forward, and
    // opening it would only make an empty "Untitled session" tab.
    if (hasSessionRef.current && !hasSessionRef.current(sessionId)) return;
    openSession(sessionId);
    requestJumpToLatest(sessionId);
  };
  const readyRef = useRef(ready);
  readyRef.current = ready;
  // A session for this PC that lands before the catalog exists waits here
  // instead of being dropped on the floor.
  const deferred = useRef('');
  const deferredDesktop = useRef('');
  const openHere = (sessionId: string): void => {
    // A newer tap replaces a desktop click still waiting for the panes.
    deferredDesktop.current = '';
    if (readyRef.current) openRef.current(sessionId);
    else deferred.current = sessionId;
  };
  const deliver = (tap: NotificationTap): void => {
    const route = routeNotificationTap(tap, routeRef.current.hostEnvironment);
    if (route.action === 'open') openHere(route.sessionId);
    else if (route.action === 'switch') routeRef.current.switchHost?.(route.url);
  };
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;
  // A conversation whose tab is not open (a bot chat or room never opened this
  // run, a closed task or sub-agent session) is opened like any other tap, once
  // the catalog can resolve it.
  const focusDesktop = (sessionId: string): void => {
    // The newest accepted click wins: an older one still waiting for the
    // catalog must not open over it later.
    deferred.current = '';
    if (focusDesktopSession(sessionId)) requestJumpToLatest(sessionId);
    else openHere(sessionId);
  };
  const desktopRef = useRef({ ready: desktopReady, focus: focusDesktop });
  desktopRef.current = { ready: desktopReady, focus: focusDesktop };

  // Listening does NOT wait for readiness: the worker posts the instant it
  // focuses this window, which on a phone is routinely before the app has
  // finished rebuilding itself.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; sessionId?: unknown; hostId?: unknown } | null;
      if (!data || data.type !== PUSH_OPEN_SESSION_MESSAGE) return;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
      if (!sessionId) return;
      const tap = { sessionId, hostId: typeof data.hostId === 'string' ? data.hostId : '' };
      // This document is handling the tap, so the worker's parked copy must
      // not reopen it on a later launch.
      void clearNotificationClick();
      deliverRef.current(tap);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  // The phone app's native shell reports taps (and Allow / Deny, resolved by
  // the bridge) the same way the worker does: by naming the session.
  useEffect(
    () =>
      subscribeNativeNotificationActions(({ sessionId }) => {
        // The native bridge already matched the action to this page's host.
        openHere(sessionId);
      }),
    []
  );

  // A desktop click reveals the session's tab when it is open and opens the
  // session otherwise. It is judged when handled (after pane restoration), not
  // when it arrived, and never takes the phone's host-routing path.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const api = (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
    return api?.onNotificationOpenSession?.((sessionId) => {
      if (!sessionId) return;
      if (desktopRef.current.ready) desktopRef.current.focus(sessionId);
      else {
        deferred.current = '';
        deferredDesktop.current = sessionId;
      }
    });
  }, []);

  useEffect(() => {
    if (!desktopReady) return;
    const held = deferredDesktop.current;
    deferredDesktop.current = '';
    if (held) desktopRef.current.focus(held);
  }, [desktopReady]);

  // A launch from a tap (the URL) or a tap only the worker remembers (parked)
  // is routed at once, before this PC's catalog exists.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const sessionId = url.searchParams.get('session') || '';
    if (sessionId) {
      const hostId = url.searchParams.get('host') || '';
      // Dropped from the address bar before navigating: a later reload must not
      // yank the user back to the session this notification was about.
      url.searchParams.delete('session');
      url.searchParams.delete('host');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      void clearNotificationClick();
      deliverRef.current({ sessionId, hostId });
      return;
    }
    // Neither route delivered it: the phone rebuilt the app around the tap and
    // the worker's parked copy is the only surviving record.
    void claimNotificationClick().then((parked) => {
      if (parked) deliverRef.current(parked);
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    const held = deferred.current;
    deferred.current = '';
    if (held) openRef.current(held);
  }, [ready]);
}
