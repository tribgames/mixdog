import type { DesktopRemoteBrowserControl } from "../shared/contract";

/** Serialize human input without tying every keystroke to a new screenshot.
 * Each action keeps the document/frame the user was looking at when it was
 * queued. A failed or uncertain action is never replayed. */
export function createRemoteBrowserInputQueue(options: {
  send(input: DesktopRemoteBrowserControl): Promise<void>;
  failure(message: string): void;
  settled(): void;
}) {
  let tail = Promise.resolve();
  let pending = 0;
  let generation = 0;
  let active = true;

  return {
    activate() { active = true; },
    dispose() { active = false; generation += 1; },
    enqueue(input: DesktopRemoteBrowserControl): Promise<void> {
      if (!active) return Promise.resolve();
      if (pending >= 128) {
        options.failure("Remote Browser Use input is busy; input was not sent.");
        return Promise.resolve();
      }
      const admitted = generation;
      pending += 1;
      const work = tail.then(async () => {
        if (!active || admitted !== generation) return;
        await options.send(input);
      });
      tail = work.catch((error) => {
        if (!active || admitted !== generation) return;
        generation += 1;
        const message = error instanceof Error ? error.message : String(error);
        options.failure(`${message} Pending input was not sent.`);
      }).finally(() => {
        pending -= 1;
        if (active) options.settled();
      });
      return tail;
    },
  };
}
