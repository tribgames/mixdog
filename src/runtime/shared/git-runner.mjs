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
 * maxBytes, or the spawn error itself.
 */
export function runGitOffThread(args, { cwd, input = '', env = null, timeoutMs, maxBytes }) {
  return requestGit({ args, cwd, input, env, timeoutMs, maxBytes });
}
