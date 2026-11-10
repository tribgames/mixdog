// Run git children from a small shared pool of worker threads so the synchronous native
// process creation never stalls the host event loop. Results carry the exit
// code; callers decide what a non-zero exit means.
import { SHARE_ENV } from 'node:worker_threads';
import { gitVerb } from './git-launch.mjs';
import { notePhase, timePhase } from './slow-span.mjs';
import { CHILD_SPAWN_IDLE_EXIT_MS, CHILD_SPAWN_WORKERS } from './run-child.mjs';
import { createWorkerRequestPool } from './worker-requests.mjs';

// SHARE_ENV: children inherit the live process environment, exactly as a
// spawn from this thread would.
const requestGit = createWorkerRequestPool(new URL('./git-runner-worker.mjs', import.meta.url), {
  size: CHILD_SPAWN_WORKERS,
  idleExitMs: CHILD_SPAWN_IDLE_EXIT_MS,
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
  return timePhase(`git.${gitVerb(args)}`, async () => {
    // The worker's account of this child (run-child.mjs runChildTimed), on a
    // failed one too: its error carries it.
    const note = (timing) => {
      if (!timing) return;
      notePhase('spawn-queue', timing.queueMs);
      notePhase('spawn', timing.spawnMs);
    };
    try {
      const result = await requestGit({
        args,
        cwd,
        input,
        env,
        timeoutMs,
        maxBytes,
        stdoutEncoding,
        waitForExitMs,
        sentAt: Date.now(),
      });
      note(result.timing);
      return result;
    } catch (error) {
      note(error?.timing);
      throw error;
    }
  });
}
