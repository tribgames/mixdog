/** Time a Browser Use command spends waiting for the person (an approval
 *  card) is not the page being slow. The command's ceiling (command.ts
 *  COMMAND_TIMEOUT_MS) stands still while any such wait is open and runs again
 *  when the last one closes; cancelling the command still ends it at once. */
export interface UserWait {
  /** Open one wait; the returned release (idempotent) closes it. */
  begin(): () => void;
}

export interface UserWaitClock extends UserWait {
  readonly waiting: boolean;
  /** `listener(true)` when the first wait opens and `listener(false)` when the
   *  last one closes; returns the unsubscribe. */
  subscribe(listener: (waiting: boolean) => void): () => void;
}

export function createUserWait(): UserWaitClock {
  let open = 0;
  const listeners = new Set<(waiting: boolean) => void>();
  const announce = (waiting: boolean) => {
    for (const listener of [...listeners]) listener(waiting);
  };
  return {
    get waiting() {
      return open > 0;
    },
    begin() {
      open += 1;
      if (open === 1) announce(true);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        open -= 1;
        if (open === 0) announce(false);
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
