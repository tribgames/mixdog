export type RemoteConnectionState = "connecting" | "connected" | "reconnecting";

export const REMOTE_CONNECTION_STATE_EVENT = "mixdog:remote-connection-state";

/** Manual retry from the connection chip. The shim reconnects on it exactly as
 *  it does on a foreground wake, so a user never has to wait out the backoff. */
export const REMOTE_WAKE_EVENT = "mixdog:remote-wake";

export function shouldRunRemoteHeartbeat(
  visibilityState: DocumentVisibilityState,
): boolean {
  return visibilityState === "visible";
}

function isRemoteConnectionState(value: unknown): value is RemoteConnectionState {
  return value === "connecting" || value === "connected" || value === "reconnecting";
}

export function currentRemoteConnectionState(): RemoteConnectionState | null {
  if (typeof document === "undefined") return null;
  const value = document.documentElement.dataset.mixdogRemoteConnection;
  return isRemoteConnectionState(value) ? value : null;
}

export function setRemoteConnectionState(state: RemoteConnectionState): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (currentRemoteConnectionState() === state) return;
  document.documentElement.dataset.mixdogRemoteConnection = state;
  window.dispatchEvent(new window.Event(REMOTE_CONNECTION_STATE_EVENT));
}

export function clearRemoteConnectionState(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (currentRemoteConnectionState() === null) return;
  delete document.documentElement.dataset.mixdogRemoteConnection;
  window.dispatchEvent(new window.Event(REMOTE_CONNECTION_STATE_EVENT));
}

export function subscribeRemoteConnectionState(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(REMOTE_CONNECTION_STATE_EVENT, listener);
  return () => window.removeEventListener(REMOTE_CONNECTION_STATE_EVENT, listener);
}
