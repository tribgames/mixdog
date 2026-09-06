import {
  normalizeRemoteRelayOrigin,
  readRemoteDeviceId,
  REMOTE_PAIRING_STORAGE_KEYS,
} from "./remote-pairing-recovery";

/** Cache provenance only, never authentication. Legacy unscoped data remains
 * readable on desktop but is never migrated into an unknown remote device. */
export function catalogStorageScope(): string {
  if (typeof window === "undefined") return "desktop";
  const location = window.location;
  const routed = /^\/d\/([^/]+)(?:\/|$)/.exec(location?.pathname || "")?.[1];
  if (!routed && !/^https?:$/.test(location?.protocol || "")) return "desktop";
  let device = routed || "";
  let server = location?.origin || "";
  try {
    device ||= readRemoteDeviceId(location?.pathname || "", typeof document === "undefined" ? "" : document.cookie)
      || window.localStorage.getItem(REMOTE_PAIRING_STORAGE_KEYS.device) || "";
    server = normalizeRemoteRelayOrigin(window.localStorage.getItem(REMOTE_PAIRING_STORAGE_KEYS.server) || "")
      || server;
  } catch { /* unavailable storage: the route remains authoritative */ }
  return `remote:${server}:${device || "unpaired"}`;
}

export function catalogStorageKey(key: string, scope = catalogStorageScope()): string {
  return scope === "desktop" ? key : `${key}:scope:${encodeURIComponent(scope)}`;
}
