// Counter of changes to what the agent config is built from. It moves on this
// process's own writes (config, OAuth credential files, the selected provider
// account, an auth binding; secrets through the keychain cache's change event),
// on another process's config or secret write applied by the config-change
// pass, and on the config snapshot's file-watch events and the exact expiry
// timer. The snapshot compares it on every read (no I/O); a listener hears
// every move. Dependency-free so the writers can import it without a cycle
// through shared/config.mjs.
let epoch = 0;
const listeners = new Set();

export function configInputEpoch() {
  return epoch;
}

export function bumpConfigInputEpoch() {
  epoch += 1;
  for (const listener of [...listeners]) {
    try {
      listener(epoch);
    } catch {}
  }
}

/** `listener(epoch)` runs on every bump, inside the writer's call: it must
 *  only note the change (schedule work), never read config synchronously. */
export function subscribeConfigInputEpoch(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
