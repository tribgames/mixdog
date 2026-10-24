import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DesktopOrchestrationMode } from '../shared/contract';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';

// The orchestration mode a New Task composer inherits: the CONFIGURED default
// (`getConfiguredOrchestrationMode`), never the active session's own mode
// (`getOrchestrationMode` answers for whichever session is open). The config is
// global, so it needs no per-project key. It is read once and shared by every
// composer, so a freshly mounted menu (a New Task tab switch) renders its value
// in the first frame. It stays current through this store's own writes and the
// host's ORCHESTRATION_MODE_EVENT, published only when the configured value
// itself changes (any writer: settings UI, the setup tool, another window).
let current: DesktopOrchestrationMode | null = null;
/** The last refresh failed (or the link may have missed an event): `current`,
 *  if any, is kept on screen but read again on the next mount, event or
 *  reconnect. Separate from `current`, which a failure must not clear. */
let dirty = false;
/** A host that rejects `getConfiguredOrchestrationMode` (older than this
 *  store): its composers read `getOrchestrationMode` once per mount, as before. */
let legacyHost = false;
/** Bumped by every write and event: a read that began before the latest bump
 *  describes an older config and is read again. */
let generation = 0;
let reading: Promise<void> | null = null;
let stopWatching: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function publish(mode: DesktopOrchestrationMode): void {
  dirty = false;
  if (mode === current) return;
  current = mode;
  notify();
}

/** The mode was configured (here, or announced by the host): every open
 *  composer shows it now. */
export function publishInheritedOrchestrationMode(mode: DesktopOrchestrationMode): void {
  generation += 1;
  publish(mode);
}

/** The host does not know the capability (an older daemon or desktop host). */
function isUnsupportedCapability(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bcapability is unavailable\b|session action getConfiguredOrchestrationMode is unavailable/.test(message);
}

function readConfiguredMode(): Promise<void> {
  reading ??= (async () => {
    try {
      for (;;) {
        const started = generation;
        const result = await window.mixdogDesktop.invokeCapability<DesktopOrchestrationMode>({
          capability: 'getConfiguredOrchestrationMode',
          args: [],
        });
        if (started === generation) {
          publish(result.value);
          return;
        }
      }
    } catch (error) {
      if (isUnsupportedCapability(error)) {
        legacyHost = true;
        dirty = false;
      } else {
        dirty = true;
      }
      notify();
    } finally {
      reading = null;
    }
  })();
  return reading;
}

function reconnected(): void {
  // Events published while the link was down were missed.
  generation += 1;
  dirty = true;
  if (!legacyHost) void readConfiguredMode();
}

/** Follow the host for the life of the window, mounted or not, so a value
 *  cached while no composer is open is never stale on the next mount. */
function watchConfig(): void {
  if (stopWatching) return;
  const unsubscribe = window.mixdogDesktop?.subscribeOrchestrationModeChanged?.((change) =>
    publishInheritedOrchestrationMode(change.mode)
  );
  window.addEventListener(REMOTE_CONNECTION_READY_EVENT, reconnected);
  stopWatching = () => {
    unsubscribe?.();
    window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, reconnected);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The mode a composer without its own mode shows; `wanted` (it has none)
 *  starts watching the host and reads whenever nothing good is cached. */
export function useInheritedOrchestrationMode(wanted: boolean): DesktopOrchestrationMode | null {
  const shared = useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  );
  const legacy = useSyncExternalStore(
    subscribe,
    () => legacyHost,
    () => false
  );
  const [own, setOwn] = useState<DesktopOrchestrationMode | null>(null);
  useEffect(() => {
    if (!wanted) return undefined;
    if (!legacy) {
      watchConfig();
      if (current === null || dirty) void readConfiguredMode();
      return undefined;
    }
    // The pre-store behavior, exactly: this composer asks once per mount.
    let cancelled = false;
    void window.mixdogDesktop
      .invokeCapability<DesktopOrchestrationMode>({ capability: 'getOrchestrationMode', args: [] })
      .then((result) => {
        if (!cancelled) setOwn(result.value);
      })
      .catch(() => {
        // Keep the unknown control disabled; do not claim an unconfirmed mode.
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, legacy]);
  return legacy ? own : shared;
}

export function _resetInheritedOrchestrationModeForTest(): void {
  stopWatching?.();
  stopWatching = null;
  current = null;
  dirty = false;
  legacyHost = false;
  generation = 0;
  reading = null;
  listeners.clear();
}
