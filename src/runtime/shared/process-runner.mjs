// Run short helper processes from one shared worker thread, so their
// synchronous native process creation never stalls the host event loop. A
// daemon profile under heavy agent load measured single PowerShell spawns
// blocking the daemon's loop for up to 7 s each. Separate from the git
// runner's worker: a slow helper start never queues a git child behind it.
import { SHARE_ENV } from 'node:worker_threads';
import { runChild } from './run-child.mjs';
import { createWorkerRequestClient } from './worker-requests.mjs';

// Created on first use. A bundled copy of this module (the desktop service's
// CommonJS bundle) has no module URL and no worker file beside it: there the
// child is started on the calling thread, exactly as before.
let requestProcess = null;
function processClient() {
  if (requestProcess !== null) return requestProcess;
  try {
    // SHARE_ENV: children inherit the live process environment, exactly as a
    // spawn from this thread would.
    requestProcess = createWorkerRequestClient(new URL('./process-runner-worker.mjs', import.meta.url), {
      env: SHARE_ENV,
    });
  } catch {
    requestProcess = false;
  }
  return requestProcess;
}

/**
 * Resolves to { code, stdout, stderr } (a non-zero exit is the caller's to
 * judge). Rejects with code ETIMEDOUT after timeoutMs (the child is killed;
 * 0 sets no deadline),
 * EMAXBUFFER once stdout+stderr exceed maxBytes, or the spawn error itself.
 */
export function runProcessOffThread(command, args, { cwd, input = '', env = null, timeoutMs, maxBytes }) {
  const request = processClient();
  const payload = { command, args, cwd, input, env, timeoutMs, maxBytes };
  return request ? request(payload) : runChild(payload);
}
