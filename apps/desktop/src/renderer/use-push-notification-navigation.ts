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

export function usePushNotificationNavigation({
  ready,
  openSession,
  desktopReady,
  focusDesktopSession,
  switchHost = (url) => window.location.assign(url),
  hostEnvironment,
}: {
  /** The catalog has to exist before a session id can resolve to a tab. */
  ready: boolean;
  openSession(sessionId: string): void;
  /** Desktop clicks need the restored pane layout, not the session catalog. */
  desktopReady: boolean;
  focusDesktopSession(sessionId: string): void;
  /** Moves this app to another paired PC's route (the PC switcher's way). */
  switchHost?(url: string): void;
  /** Test seam for the paired-PC lookup (push-notification-bridge.ts). */
  hostEnvironment?: PushHostEnvironment;
}): void {
  // A tap names the PC that sent it: open it here only when that is the PC
  // this page drives, otherwise move to that PC's route, which opens it.
  // Routing never waits for THIS PC's catalog: this PC may never become ready
  // (its pairing is gone, it is offline), and a tap from another PC must still
  // reach that PC. Only opening a session on this PC waits.
  const routeRef = useRef({ switchHost, hostEnvironment });
  routeRef.current = { switchHost, hostEnvironment };
  const openRef = useRef((sessionId: string) => openSession(sessionId));
  openRef.current = (sessionId: string) => openSession(sessionId);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  // A session for this PC that lands before the catalog exists waits here
  // instead of being dropped on the floor.
  const deferred = useRef('');
  const openHere = (sessionId: string): void => {
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
  const desktopRef = useRef({ ready: desktopReady, focus: focusDesktopSession });
  desktopRef.current = { ready: desktopReady, focus: focusDesktopSession };
  const deferredDesktop = useRef('');

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

  // Desktop clicks reveal only tabs that still exist when the click is handled.
  // Do not route a queued desktop click through the phone's open-session path.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const api = (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
    return api?.onNotificationOpenSession?.((sessionId) => {
      if (!sessionId) return;
      if (desktopRef.current.ready) desktopRef.current.focus(sessionId);
      else deferredDesktop.current = sessionId;
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
