/** A main-process message that may arrive before the renderer has subscribed
 *  (a notification click that just rebuilt or reloaded the window). With no
 *  listener the newest value is held and handed to the next subscriber; the
 *  older ones are superseded by it. */
export function createHeldChannel<T>() {
  const listeners = new Set<(value: T) => void>();
  let held: { value: T } | null = null;
  return {
    push(value: T): void {
      if (listeners.size === 0) {
        held = { value };
        return;
      }
      for (const listener of [...listeners]) listener(value);
    },
    subscribe(listener: (value: T) => void): () => void {
      listeners.add(listener);
      const queued = held;
      held = null;
      if (queued) listener(queued.value);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
