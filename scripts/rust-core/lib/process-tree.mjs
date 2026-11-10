// Starting a process and ending the WHOLE tree it grew, on Windows and on POSIX. A deadline that ends only the direct
// child leaves what it started (cargo's compilers and test binaries, an exec's tools) running.
import { spawn } from 'node:child_process';

const WINDOWS = process.platform === 'win32';
// taskkill and the process listing are processes of their own and can hang like any other: their answers have a deadline too.
const KILL_DEADLINE_MS = 30_000;

/** `spawn`, but on POSIX the child leads its own process group so the group can be ended with it. */
export function spawnTree(program, args, options = {}) {
  const child = spawn(program, args, { ...options, detached: !WINDOWS });
  // Taken before the spawn returns; a process created before this instant cannot be the child's descendant.
  child.treeStartedAt = Date.now() - 2000;
  return child;
}

const gone = (child) => child.exitCode !== null || child.signalCode !== null;

/** One program under a deadline, its stdout captured: `{ code, stdout, stderr }`; rejects on a deadline or a start failure. */
function capture(program, args, deadlineMs, what) {
  return new Promise((resolveRun, reject) => {
    const proc = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${what} did not answer within ${deadlineMs}ms`));
    }, deadlineMs);
    proc.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${what}: ${error.message}`));
    });
    proc.once('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

/**
 * Windows keeps a process's parent id after the parent has exited, so the descendants of a dead child are still found by
 * walking parent ids from its pid. A pid reused later has a creation time after the child's start; those are not ours.
 */
async function windowsDescendants(rootPid, startedAt, deadlineMs) {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }';
  const listing = await capture('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], deadlineMs, 'the process listing');
  if (listing.code !== 0) throw new Error(`the process listing exited ${listing.code}: ${listing.stderr.trim().slice(0, 300)}`);
  const rows = listing.stdout.split(/\r?\n/).map((line) => line.trim().split(' ').map(Number)).filter((r) => r.length === 3 && r.every(Number.isFinite));
  const found = [];
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const [pid, ppid, created] of rows) {
      if (ppid === parent && pid !== parent && created >= startedAt && !found.includes(pid)) {
        found.push(pid);
        queue.push(pid);
      }
    }
  }
  return found;
}

/**
 * Ends `child` and every process it started, whether or not the child itself is still alive, and answers
 * `{ killed }`: the pids ended on Windows, the process group id (negative) on POSIX. A child that never started has
 * nothing to end. Rejects when the kill itself fails or does not answer in time: an unended tree is its own error.
 * @param {import('node:child_process').ChildProcess} child started by `spawnTree`
 */
export async function endTree(child, { deadlineMs = KILL_DEADLINE_MS } = {}) {
  if (!child.pid) return { killed: [] };
  if (!WINDOWS) {
    // The group outlives its leader: killing it by id reaches descendants after the leader has exited.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code === 'ESRCH') return { killed: [] };
      throw new Error(`could not end the process group of pid ${child.pid}: ${error.message}`);
    }
    return { killed: [-child.pid] };
  }
  const targets = await windowsDescendants(child.pid, child.treeStartedAt ?? 0, deadlineMs);
  if (!gone(child)) targets.unshift(child.pid);
  if (!targets.length) return { killed: [] };
  const answer = await capture('taskkill', [...targets.flatMap((pid) => ['/PID', String(pid)]), '/T', '/F'], deadlineMs, `taskkill of the process tree of pid ${child.pid}`);
  // 128: no such process, a tree member that ended by itself between the listing and the kill.
  if (answer.code === 0 || (answer.code === 128 && gone(child))) return { killed: targets };
  throw new Error(`taskkill of the process tree of pid ${child.pid} exited ${answer.code}: ${answer.stderr.trim().slice(0, 300)}`);
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
        const { killed } = await endTree(child);
        reject(new Error(`${message} (ended: ${killed.length ? killed.join(', ') : 'nothing was left running'})`));
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
