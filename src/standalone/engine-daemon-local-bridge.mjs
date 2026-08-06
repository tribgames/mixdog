const LOCAL_ENGINE_BRIDGE_KEY = Symbol.for('mixdog.engine-daemon.local-bridge.v1');

/** Return the daemon-process-local session bridge, when this module is running
 * inside the singleton backend process. External TUI/Electron clients never
 * see this registry and keep using the authenticated loopback transport. */
export function engineDaemonLocalBridge() {
  return globalThis[LOCAL_ENGINE_BRIDGE_KEY] ?? null;
}

export function installEngineDaemonLocalBridge(bridge) {
  if (!bridge || typeof bridge.attach !== 'function') {
    throw new TypeError('engine daemon local bridge is invalid');
  }
  globalThis[LOCAL_ENGINE_BRIDGE_KEY] = bridge;
  return () => {
    if (globalThis[LOCAL_ENGINE_BRIDGE_KEY] === bridge) {
      delete globalThis[LOCAL_ENGINE_BRIDGE_KEY];
    }
  };
}
