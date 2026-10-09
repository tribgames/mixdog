import type { ComputerUseCursorPresentation } from './model';

/** Visual-only grace period: never retains execution, targets, or input authority. */
export function createCursorTail(changed: () => void, holdMs = 1500) {
  const retained = new Map<string, ComputerUseCursorPresentation>();
  const expiry = new Map<string, ReturnType<typeof setTimeout>>();
  let latestForegroundEventId = 0;
  const clearExpiry = (sessionId: string) => {
    const timer = expiry.get(sessionId);
    if (timer) clearTimeout(timer);
    expiry.delete(sessionId);
  };
  const remove = (sessionId: string) => {
    clearExpiry(sessionId);
    retained.delete(sessionId);
  };
  const clear = () => {
    for (const timer of expiry.values()) clearTimeout(timer);
    expiry.clear();
    retained.clear();
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
        clearExpiry(cursor.sessionId);
        retained.set(cursor.sessionId, cursor);
      }
      for (const [id, held] of retained) {
        if (live.has(id)) continue;
        // A session still using the computer keeps its last cursor between commands.
        if (modes && modes.get(id) === held.mode) {
          clearExpiry(id);
          continue;
        }
        if (expiry.has(id)) continue;
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
