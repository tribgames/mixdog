// Mutable proxy state shared by the memory-runtime-proxy modules: one object
// so discovery, spawn, registration and the RPC surface see the same port
// cache and child handle instead of closing over factory-level variables.
export function createMemoryProxyState() {
  return {
    // Last port a health probe confirmed; null as soon as anything suggests
    // the published port is stale.
    portCache: null,
    // In-flight start() so concurrent callers share one fork + ready wait.
    startPromise: null,
    // The daemon child THIS proxy forked; null once it exits or is released.
    child: null,
    nextCallId: 1,
    // { reason, at } — cached deterministic spawn crash (crash-loop guard).
    crashState: null,
    // Port this proxy pid is registered with, so the shared daemon can reap
    // itself once every client deregisters. Re-registers when the daemon
    // respawns on a new port.
    registeredWithPort: null,
  };
}
