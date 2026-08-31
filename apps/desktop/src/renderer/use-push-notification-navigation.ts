// Navigation that arrives from OUTSIDE the running app: a tapped push
// notification. The service worker focuses an existing window and names the
// session over postMessage, launches one at <scope>?session=… when nothing was
// running, and parks the tap either way. All three land here, and each is
// consumed exactly once.
import { useEffect, useRef } from "react";

import { claimNotificationClick, clearNotificationClick } from "./push-notification-bridge";

export const PUSH_OPEN_SESSION_MESSAGE = "mixdog:open-session";

export function usePushNotificationNavigation({ ready, openSession }: {
  /** The catalog has to exist before a session id can resolve to a tab. */
  ready: boolean;
  openSession(sessionId: string): void;
}): void {
  const openRef = useRef(openSession);
  openRef.current = openSession;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  // A tap that lands before the catalog exists waits here instead of being
  // dropped on the floor.
  const deferred = useRef("");

  // Listening does NOT wait for readiness: the worker posts the instant it
  // focuses this window, which on a phone is routinely before the app has
  // finished rebuilding itself.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return undefined;
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; sessionId?: unknown } | null;
      if (!data || data.type !== PUSH_OPEN_SESSION_MESSAGE) return;
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
      if (!sessionId) return;
      // This document is handling the tap, so the worker's parked copy must
      // not reopen it on a later launch.
      void clearNotificationClick();
      if (readyRef.current) openRef.current(sessionId);
      else deferred.current = sessionId;
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const held = deferred.current;
    deferred.current = "";
    if (held) {
      openRef.current(held);
      return;
    }
    const url = new URL(window.location.href);
    const sessionId = url.searchParams.get("session") || "";
    if (sessionId) {
      // Dropped from the address bar before navigating: a later reload must not
      // yank the user back to the session this notification was about.
      url.searchParams.delete("session");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      void clearNotificationClick();
      openRef.current(sessionId);
      return;
    }
    // Neither route delivered it: the phone rebuilt the app around the tap and
    // the worker's parked copy is the only surviving record.
    void claimNotificationClick().then((parked) => {
      if (parked) openRef.current(parked);
    });
  }, [ready]);
}
