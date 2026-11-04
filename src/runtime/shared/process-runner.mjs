// Run short helper processes from a small shared pool of worker threads, so their
// synchronous native process creation never stalls the host event loop. A
// daemon profile under heavy agent load measured single PowerShell spawns
// blocking the daemon's loop for up to 7 s each. Separate from the git
// runner's worker: a slow helper start never queues a git child behind it.
import { SHARE_ENV } from 'node:worker_threads';
import { CHILD_SPAWN_IDLE_EXIT_MS, CHILD_SPAWN_WORKERS, runChild } from './run-child.mjs';
import { createWorkerRequestPool } from './worker-requests.mjs';

// Created on first use. A bundled copy of this module (the desktop service's
// CommonJS bundle) has no module URL and no worker file beside it: there the
// child is started on the calling thread, exactly as before.
let requestProcess = null;
function processClient() {
  if (requestProcess !== null) return requestProcess;
  try {
    // SHARE_ENV: children inherit the live process environment, exactly as a
    // spawn from this thread would.
    requestProcess = createWorkerRequestPool(new URL('./process-runner-worker.mjs', import.meta.url), {
      size: CHILD_SPAWN_WORKERS,
      idleExitMs: CHILD_SPAWN_IDLE_EXIT_MS,
      env: SHARE_ENV,
    });
  } catch {
    requestProcess = false;
  }
  return requestProcess;
}

/**
 * Resolves to { code, stdout, stderr } (a non-zero exit is the caller's to
 * judge), plus `timing: { queueMs, spawnMs }` when the worker ran it: its wait
 * for the worker thread and its own process creation. Rejects with code ETIMEDOUT after timeoutMs (the child is killed,
 * with its tree unless `killTree` is false; 0 sets no deadline),
 * EMAXBUFFER once stdout+stderr exceed maxBytes, or the spawn error itself.
 */
export function runProcessOffThread(
  command,
  args,
  { cwd, input = '', env = null, timeoutMs, maxBytes, killTree = true }
) {
  const request = processClient();
  const payload = { command, args, cwd, input, env, timeoutMs, maxBytes, killTree, sentAt: Date.now() };
  return request ? request(payload) : runChild(payload);
}
