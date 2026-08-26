import { WifiOff } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { t } from "./i18n";
import {
  currentRemoteConnectionState,
  REMOTE_WAKE_EVENT,
  subscribeRemoteConnectionState,
} from "./remote-connection-state";

// Every foreground return costs a short reconnect gap (socket recycle, relay
// dial, E2EE handshake). That blip is NOT an outage and gets NO surface at all
// (user: 백그라운드 갔다오니 디스커넥트 창). Only a gap that outlives this
// threshold is treated as disconnected, and a restored connection drops the
// overlay and starts this window over from zero.
const DISCONNECTED_AFTER_MS = 10_000;

export function RemoteConnectionBanner() {
  const state = useSyncExternalStore(
    subscribeRemoteConnectionState,
    currentRemoteConnectionState,
    () => null,
  );
  const [disconnected, setDisconnected] = useState(false);
  useEffect(() => {
    setDisconnected(false);
    if (state !== "reconnecting") return () => {};
    const timer = window.setTimeout(() => setDisconnected(true), DISCONNECTED_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  if (state !== "reconnecting" || !disconnected) return null;

  // No wording on purpose: the dim layer and the glyph ARE the message, and the
  // layer exists to block input against a desktop that cannot answer it. A tap
  // retries at once instead of waiting out the remaining reconnect backoff.
  return <button type="button" className="remote-connection-overlay"
    aria-label={t("Retry")}
    onClick={() => window.dispatchEvent(new Event(REMOTE_WAKE_EVENT))}>
    <WifiOff aria-hidden="true" />
  </button>;
}
