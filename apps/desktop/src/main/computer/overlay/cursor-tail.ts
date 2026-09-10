import type { ComputerUseCursorPresentation } from './model';

/** Visual-only grace period: never retains execution, targets, or input authority. */
export function createCursorTail(changed: () => void, holdMs = 1500) {
  const retained = new Map<string, ComputerUseCursorPresentation>();
  const expiry = new Map<string, ReturnType<typeof setTimeout>>();
  let latestEventId = 0;
  const clear = () => {
    for (const timer of expiry.values()) clearTimeout(timer);
    expiry.clear();
    retained.clear();
  };
  return {
    update(current: ComputerUseCursorPresentation[], interrupted: boolean, excluded?: ReadonlySet<string>) {
      const newest = current.reduce<ComputerUseCursorPresentation | undefined>(
        (latest, cursor) => !latest || cursor.eventId > latest.eventId ? cursor : latest, undefined);
      if (newest && newest.eventId > latestEventId) {
        latestEventId = newest.eventId;
        // Only one physical pointer exists. A newer session owns its feedback too.
        if (!retained.has(newest.sessionId)) clear();
      }
      current = newest && newest.eventId === latestEventId && !excluded?.has(newest.sessionId)
        ? [newest] : [];
      if (interrupted) { clear(); return []; }
      for (const id of excluded ?? []) {
        const timer = expiry.get(id);
        if (timer) clearTimeout(timer);
        expiry.delete(id);
        retained.delete(id);
      }
      const live = new Set(current.map(cursor => cursor.sessionId));
      for (const cursor of current) {
        const timer = expiry.get(cursor.sessionId);
        if (timer) clearTimeout(timer);
        expiry.delete(cursor.sessionId);
        retained.set(cursor.sessionId, cursor);
      }
      for (const id of retained.keys()) {
        if (live.has(id) || expiry.has(id)) continue;
        const timer = setTimeout(() => {
          expiry.delete(id);
          retained.delete(id);
          changed();
        }, holdMs);
        timer.unref?.();
        expiry.set(id, timer);
      }
      return [...retained.values()];
    },
    dispose: clear,
  };
}
