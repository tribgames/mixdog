// The process-wide durable-write barrier. A session close drains only its own
// writes (lifecycle/teardown.mjs), so the process that owns the runtimes runs
// this once they are closed, right before it exits: the daemon's shutdown and
// the REPL's runtime close.
import { drainConfigWrites } from '../../runtime/shared/config.mjs';
import { drainSessionConfigWrites } from '../config-lifecycle/config-writers.mjs';
import { flushAllIndexWrites } from '../services/agent-tool/index-write-queue.mjs';

/** Every index queue and every config write of the process on disk, writes
 *  started while it waits included. Each drain runs even when another fails;
 *  the first failure is rethrown. */
export async function drainProcessWrites() {
  const results = [];
  for (const drain of [flushAllIndexWrites, drainSessionConfigWrites, drainConfigWrites]) {
    results.push(...(await Promise.allSettled([drain()])));
  }
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}
