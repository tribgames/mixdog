/**
 * The resident worker processes the pool has started and not yet seen exit:
 * what counts against capacity, and what a shutdown waits on.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export function createResidentWorkers() {
  const workers = new Set<ChildProcessWithoutNullStreams>();
  /** Killed optional workers that gave their slot to a session: still awaited
   *  at shutdown, no longer counted against capacity. */
  const yielded = new WeakSet<ChildProcessWithoutNullStreams>();

  /** An exited worker keeps its slot until its `exit` event arrives, and a
   * confirmed session release can outrun that event. Dead children are pruned
   * before the limit is judged so a finished session never blocks the next. */
  function liveCount(): number {
    for (const child of workers) {
      if (child.exitCode !== null || child.signalCode !== null) workers.delete(child);
    }
    return [...workers].filter((child) => !yielded.has(child)).length;
  }

  function pids(): number[] {
    return [...workers]
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => Number(child.pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  /** Resolves true once no resident worker is alive; false at the deadline. */
  function waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        if (pids().length === 0) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, 100).unref?.();
      };
      check();
    });
  }

  return {
    add: (child: ChildProcessWithoutNullStreams) => void workers.add(child),
    delete: (child: ChildProcessWithoutNullStreams) => void workers.delete(child),
    yieldSlot: (child: ChildProcessWithoutNullStreams) => void yielded.add(child),
    liveCount,
    pids,
    waitForExit,
  };
}
