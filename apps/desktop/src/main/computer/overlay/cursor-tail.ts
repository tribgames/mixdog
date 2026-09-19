import type { ComputerUseCursorPresentation } from './model';

/** A pointer that stopped moving fades after this idle period while its session stays alive. */
const CURSOR_IDLE_HIDE_MS = 20_000;

/** Visual-only grace period: never retains execution, targets, or input authority. */
export function createCursorTail(
  changed: () => void,
  holdMs = 1500,
  idleHideMs = CURSOR_IDLE_HIDE_MS,
  now: () => number = Date.now
) {
  const retained = new Map<string, ComputerUseCursorPresentation>();
  const expiry = new Map<string, ReturnType<typeof setTimeout>>();
  const idle = new Map<string, ReturnType<typeof setTimeout>>();
  let latestForegroundEventId = 0;
  const clearIdle = (sessionId: string) => {
    const timer = idle.get(sessionId);
    if (timer) clearTimeout(timer);
    idle.delete(sessionId);
  };
  const remove = (sessionId: string) => {
    const timer = expiry.get(sessionId);
    if (timer) clearTimeout(timer);
    expiry.delete(sessionId);
    retained.delete(sessionId);
    clearIdle(sessionId);
  };
  const clear = () => {
    for (const timer of expiry.values()) clearTimeout(timer);
    for (const timer of idle.values()) clearTimeout(timer);
    expiry.clear();
    idle.clear();
    retained.clear();
  };
  const idleFor = (cursor: ComputerUseCursorPresentation): number => {
    if (idleHideMs <= 0 || !Number.isFinite(cursor.updatedAt)) return Number.POSITIVE_INFINITY;
    return cursor.updatedAt + idleHideMs - now();
  };
  return {
    update(
      current: ComputerUseCursorPresentation[],
      interrupted: boolean,
      modes?: ReadonlyMap<string, 'background' | 'foreground'>
    ) {
      if (interrupted) {
        clear();
        return [];
      }
      current = current.filter((cursor) => !modes || modes.get(cursor.sessionId) === cursor.mode);
      // An idle pointer hides outright: it already had its full visible period.
      current = current.filter((cursor) => {
        const remaining = idleFor(cursor);
        if (remaining > 0) return true;
        remove(cursor.sessionId);
        return false;
      });
      for (const [id, cursor] of retained) {
        if (modes && modes.get(id) !== cursor.mode) remove(id);
      }
      const foreground = current.reduce<ComputerUseCursorPresentation | undefined>(
        (latest, cursor) =>
          cursor.mode === 'foreground' && (!latest || cursor.eventId > latest.eventId) ? cursor : latest,
        undefined
      );
      if (foreground && foreground.eventId > latestForegroundEventId) {
        latestForegroundEventId = foreground.eventId;
        // Only foreground traces share the physical pointer. Virtual pointers are independent.
        for (const [id, cursor] of retained) {
          if (cursor.mode === 'foreground' && id !== foreground.sessionId) remove(id);
        }
      }
      current = current.filter(
        (cursor) =>
          cursor.mode === 'background' || (cursor === foreground && cursor.eventId === latestForegroundEventId)
      );
      const live = new Set(current.map((cursor) => cursor.sessionId));
      for (const cursor of current) {
        const timer = expiry.get(cursor.sessionId);
        if (timer) clearTimeout(timer);
        expiry.delete(cursor.sessionId);
        const previous = retained.get(cursor.sessionId);
        retained.set(cursor.sessionId, cursor);
        if (previous?.eventId !== cursor.eventId || !idle.has(cursor.sessionId)) {
          clearIdle(cursor.sessionId);
          const remaining = idleFor(cursor);
          if (Number.isFinite(remaining)) {
            const idleTimer = setTimeout(() => {
              idle.delete(cursor.sessionId);
              changed();
            }, remaining);
            idleTimer.unref?.();
            idle.set(cursor.sessionId, idleTimer);
          }
        }
      }
      for (const id of retained.keys()) {
        if (live.has(id) || expiry.has(id)) continue;
        const timer = setTimeout(() => {
          expiry.delete(id);
          retained.delete(id);
          clearIdle(id);
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
