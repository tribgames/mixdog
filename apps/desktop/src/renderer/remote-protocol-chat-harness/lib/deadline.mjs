// One hard deadline for a whole run. Nothing in the harness sleeps to synchronise: every wait is on an event, a
// readiness file or a process exit, and `race` ends the run with what was last seen if that event never comes.
export class HangError extends Error {
  constructor(waitingFor, seen, deadlineMs) {
    super(`HANG: still waiting for ${waitingFor} after the ${deadlineMs} ms deadline.\nlast seen:\n${seen}`);
    this.name = 'HangError';
    this.waitingFor = waitingFor;
  }
}

/** `seen()` returns the human-readable "last seen" text (last event, last stderr lines, ...). */
export function createDeadline(deadlineMs, seen) {
  let label = 'start';
  let timer;
  const hang = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HangError(label, seen(), deadlineMs)), deadlineMs);
  });
  hang.catch(() => {});
  return {
    /** Waits for `promise`; `waitingFor` names it in the hang report. */
    race(promise, waitingFor) {
      label = waitingFor;
      return Promise.race([promise, hang]);
    },
    clear: () => clearTimeout(timer),
  };
}

/** A promise with its resolvers, for "wait until this event fires". */
export function latch() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
