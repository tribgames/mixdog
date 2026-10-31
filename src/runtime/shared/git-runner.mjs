// Run git children from one shared worker thread so the synchronous native
// process creation never stalls the host event loop. Results carry the exit
// code; callers decide what a non-zero exit means.
import { SHARE_ENV } from 'node:worker_threads';
import { createWorkerRequestClient } from './worker-requests.mjs';

// SHARE_ENV: children inherit the live process environment, exactly as a
// spawn from this thread would.
const requestGit = createWorkerRequestClient(new URL('./git-runner-worker.mjs', import.meta.url), {
  env: SHARE_ENV,
});

/**
 * Resolves to { code, stdout, stderr }. Rejects with code ETIMEDOUT after
 * timeoutMs (the child is killed), EMAXBUFFER once stdout+stderr exceed
 * maxBytes, or the spawn error itself. `stdoutEncoding: 'base64'` returns the
 * exact stdout bytes base64-encoded instead of decoded as UTF-8.
 * `waitForExitMs`: a timeout rejects only once the killed child exited (or
 * after that bound), with `childExited` and `pid` on the error (run-child.mjs).
 */
export function runGitOffThread(
  args,
  { cwd, input = '', env = null, timeoutMs, maxBytes, stdoutEncoding = 'utf8', waitForExitMs = 0 }
) {
  return requestGit({ args, cwd, input, env, timeoutMs, maxBytes, stdoutEncoding, waitForExitMs });
}
