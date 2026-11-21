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
