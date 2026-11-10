// Starting a process and ending the WHOLE tree it grew, on Windows and on POSIX. A deadline that ends only the direct
// child leaves what it started (cargo's compilers and test binaries, an exec's tools) running.
import { spawn } from 'node:child_process';

const WINDOWS = process.platform === 'win32';
// taskkill is a process of its own and can hang like any other: its answer has a deadline too.
const KILL_DEADLINE_MS = 30_000;

/** `spawn`, but on POSIX the child leads its own process group so the group can be ended with it. */
export function spawnTree(program, args, options = {}) {
  return spawn(program, args, { ...options, detached: !WINDOWS });
}

const gone = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Ends `child` and every process it started, and answers once that is done. A child that has already exited, or
 * never started, has nothing to end. Rejects when the kill itself fails or does not answer in time: an unended
 * tree is its own error, never swallowed.
 * @param {import('node:child_process').ChildProcess} child started by `spawnTree`
 */
export function endTree(child, { deadlineMs = KILL_DEADLINE_MS } = {}) {
  if (!child.pid || gone(child)) return Promise.resolve();
  if (!WINDOWS) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') return Promise.reject(new Error(`could not end the process group of pid ${child.pid}: ${error.message}`));
    }
    return Promise.resolve();
  }
  return new Promise((resolveKill, reject) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    killer.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      killer.kill();
      reject(new Error(`taskkill of the process tree of pid ${child.pid} did not answer within ${deadlineMs}ms`));
    }, deadlineMs);
    killer.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`could not run taskkill for pid ${child.pid}: ${error.message}`));
    });
    killer.once('close', (code) => {
      clearTimeout(timer);
      // 128: no such process, which is a tree that ended by itself between the check and the kill.
      if (code === 0 || (code === 128 && gone(child))) resolveKill();
      else reject(new Error(`taskkill of the process tree of pid ${child.pid} exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

/**
 * One command to its exit under a deadline: answers `{ status, stdout, stderr }`. At the deadline, or when the child
 * cannot start, the tree is ended and the run rejects with `label` in the message; a failed kill is appended as its
 * own error. `inherit` passes the child's stdio through instead of capturing it.
 */
export function runTree(program, args, { label, cwd, env, deadlineMs, inherit = false, shell = false }) {
  return new Promise((resolveRun, reject) => {
    const child = spawnTree(program, args, { cwd, env, shell, windowsHide: true, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    // Once the tree is being ended, the child's own close is the kill working, not an answer.
    let ending = false;
    const fail = async (message) => {
      ending = true;
      try {
        await endTree(child);
        reject(new Error(message));
      } catch (error) {
        reject(new Error(`${message}; ${error.message}`));
      }
    };
    const deadline = setTimeout(() => fail(`${label} did not finish within ${deadlineMs}ms and was ended\n${stderr.slice(-600)}`), deadlineMs);
    child.once('error', (error) => {
      clearTimeout(deadline);
      fail(`${label} could not run: ${error.message}`);
    });
    child.once('close', (status) => {
      if (ending) return;
      clearTimeout(deadline);
      resolveRun({ status, stdout, stderr });
    });
  });
}
