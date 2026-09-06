export const MAX_COMPUTER_WORKERS = 8;

import type { ChildProcess } from 'node:child_process';

export async function waitForComputerWorkerExit(child: ChildProcess | undefined, timeoutMs = 1_000): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const finish = (confirmed: boolean) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(confirmed);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

/** Counts live processes, including retiring workers and the warm spare. */
export function assertComputerWorkerCapacity(live: number, maximum = MAX_COMPUTER_WORKERS): void {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 32) {
    throw new Error('invalid_worker_limit: maxWorkers must be an integer from 1 to 32');
  }
  if (live >= maximum) {
    throw new Error(
      `computer_capacity_exhausted: ${maximum} workers are still live; release an idle session before retrying`,
    );
  }
}
