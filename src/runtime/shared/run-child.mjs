// One child process run to completion, its output collected — the body of
// the off-thread runners (git-runner-worker.mjs, process-runner-worker.mjs).
// Starting a child process is a synchronous native call (CreateProcess on
// Windows, amplified by on-access scanning and seconds long under load), so
// those workers spawn here instead of on the host event loop.
// Resolves to { code, stdout, stderr }; rejects with code ETIMEDOUT after
// timeoutMs (the child is killed), EMAXBUFFER once stdout+stderr exceed
// maxBytes, or the spawn error itself.
import { spawn } from 'node:child_process';
import { spawnTreeKill } from '../agent/orchestrator/mcp/child-tree.mjs';

/** Kills `child` with everything it started. On Windows a plain kill ends only
 *  the child itself: `git` there is a launcher whose git.exe (and the alias,
 *  hook or filter it runs) would live on, still holding the output pipes.
 *  Settles once the kill was attempted (on Windows: once the tree kill finished). */
export function killChildTree(child) {
  if (process.platform === 'win32' && child.pid && child.exitCode === null) {
    // The shared pass kills `child` itself once it ends or runs out of time.
    const pass = spawnTreeKill([child.pid], { root: child });
    if (!pass) return Promise.resolve();
    return new Promise((resolve) => {
      pass.once('error', resolve).once('exit', resolve);
    });
  }
  try {
    child.kill();
  } catch {}
  return Promise.resolve();
}

/** Worker threads that start children side by side. One thread spawns one
 *  child at a time, and each spawn blocks it for 40–250 ms (more under load);
 *  a status, a review and their merge-base reads from several busy sessions
 *  queued behind each other for seconds. Process creation is the OS's work,
 *  not CPU: a few threads overlap it. */
export const CHILD_SPAWN_WORKERS = 4;
/** How long a worker beyond the first may sit without a request before it is
 *  retired: long enough that a poll cycle's burst finds it warm, short enough
 *  that a quiet daemon holds one thread, as before the pool. */
export const CHILD_SPAWN_IDLE_EXIT_MS = 30_000;

/**
 * {@link runChild} for a worker thread serving a request posted at `sentAt`
 * (Date.now() of the posting thread): the result also carries
 * `timing: { queueMs, spawnMs }` — the request's wait for this thread behind
 * earlier requests' synchronous spawns, and its own child's process creation.
 * A failed run (timeout, spawn error, output limit) rejects with the same
 * `timing` on its error.
 */
export async function runChildTimed(request, sentAt) {
  const queueMs = Date.now() - sentAt;
  let spawnMs = 0;
  const timing = () => ({ queueMs, spawnMs });
  try {
    const result = await runChild({
      ...request,
      spawnChild: (...args) => {
        const started = Date.now();
        try {
          return spawn(...args);
        } finally {
          spawnMs += Date.now() - started;
        }
      },
    });
    return { ...result, timing: timing() };
  } catch (error) {
    throw Object.assign(error, { timing: timing() });
  }
}

/** The child has exited (an exit code or the signal that ended it). */
const childEnded = (child) => child.exitCode !== null || child.signalCode !== null;

// How long an exited child's pipes may stay open before its output is taken
// as complete. On Windows a process another thread of this process creates at
// the same moment (a long-lived server, say) can inherit this child's pipe
// ends and hold them open for its whole life, so 'close' would never come;
// what the child wrote before exiting is already in the pipes.
export const EXIT_DRAIN_MS = 1_000;

/**
 * `waitForExitMs` (> 0): a timeout rejects only once the killed child has
 * exited, or after that many more ms; the error then carries `pid` and
 * `childExited` (false: it outlived the wait). 0 (default): the timeout
 * rejects as soon as the kill was sent.
 * `killTree` (default true): a timeout kills the child's whole tree. false:
 * only the child, directly — for the process-table and tree-kill helpers,
 * whose own tree kill would be one more pass on the same stuck table read.
 */
export function runChild({
  command,
  args,
  cwd,
  input,
  env,
  timeoutMs,
  maxBytes,
  stdoutEncoding = 'utf8',
  waitForExitMs = 0,
  killTree = true,
  // Tests only: a stand-in for child_process.spawn (in-process callers; not serializable).
  spawnChild = spawn,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hasInput = (typeof input === 'string' || ArrayBuffer.isView(input)) && input.length > 0;
    const child = spawnChild(command, args, {
      cwd,
      ...(env ? { env } : {}),
      windowsHide: true,
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let stdinError = null;
    let settled = false;
    let timedOut = false;
    let drainTimer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const exited = new Promise((resolve) => child.once('exit', resolve));
    // timeoutMs 0: no deadline (the caller's own work bounds the child).
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            const error = new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`);
            error.code = 'ETIMEDOUT';
            timedOut = true;
            let killed = Promise.resolve();
            if (killTree) killed = killChildTree(child);
            else {
              try {
                child.kill();
              } catch {}
            }
            if (!(waitForExitMs > 0)) {
              finish(error);
              return;
            }
            let bound;
            const wait = new Promise((resolve) => {
              bound = setTimeout(resolve, waitForExitMs);
            });
            void Promise.race([Promise.all([exited, killed]), wait]).then(() => {
              clearTimeout(bound);
              error.pid = child.pid ?? null;
              error.childExited = childEnded(child);
              finish(error);
            });
          }, timeoutMs)
        : null;
    const collect = (chunks, chunk) => {
      // Once a timeout terminates the child, it alone settles: later output
      // (or an overflow) neither settles early nor grows the buffers.
      if (timedOut) return;
      const next = Buffer.from(chunk);
      outputBytes += next.length;
      if (outputBytes > maxBytes) {
        const error = new Error(`${command} ${args.join(' ')} exceeded ${maxBytes} output bytes`);
        error.code = 'EMAXBUFFER';
        try {
          child.kill();
        } catch {}
        finish(error);
        return;
      }
      chunks.push(next);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.on('error', (error) => {
      // An error while a timeout terminates the child (a failed kill) is the timeout's.
      if (!timedOut) finish(error);
    });
    const complete = (code) => {
      // A timed-out child's close is the timeout's to report.
      if (timedOut) return;
      const result = {
        code: Number(code ?? 1),
        // 'base64' keeps non-UTF-8 bytes (a replayable patch) intact across the thread hop.
        stdout: Buffer.concat(stdout).toString(stdoutEncoding === 'base64' ? 'base64' : 'utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      // A failed stdin write only matters when the child otherwise reported success.
      if (stdinError && result.code === 0) {
        finish(stdinError);
        return;
      }
      finish(null, result);
    };
    child.once('close', complete);
    child.once('exit', (code) => {
      drainTimer = setTimeout(() => {
        child.stdout.destroy?.();
        child.stderr.destroy?.();
        complete(code);
      }, EXIT_DRAIN_MS);
    });
    if (child.stdin) {
      // A short-lived child can close before stdin is flushed. Keep that
      // transport race inside this promise instead of an unhandled EPIPE.
      child.stdin.on('error', (error) => {
        stdinError = error;
      });
      child.stdin.end(input);
    }
  });
}
