'use strict';
// Post-exit descendant observation for the shell runner.
//
// The question this module answers is "did the command leave anything
// RUNNING?", and it answers it by looking at PROCESSES — never at the command
// text. Nothing here parses, classifies or rewrites a single byte of what the
// caller typed; the shell receives the command exactly as written and the
// decision is taken afterwards from what the operating system reports.
//
// Evidence per platform, both produced by the existing spawn infrastructure:
//   POSIX  — native/mixdog-spawn spawns every shell with `process_group(0)`,
//            so the command owns a process group whose id is the shell pid.
//            Once the shell has exited and been reaped, ANY remaining member
//            of that group is a descendant it left behind, and one signal to
//            the negative pgid reaches all of them.
//   win32  — there is no process group to signal, but the shell's stdout and
//            stderr pipes are INHERITED by its descendants: if they are still
//            held when the shell process itself has exited, something of this
//            command is alive. That observation gates a single batched
//            process-table read (shared with mcp/child-tree.mjs) which names
//            the survivors that are still linked to the shell pid.
import { collectDescendantProcesses, killProcessTrees } from '../../mcp/child-tree.mjs';

const isWin = process.platform === 'win32';

// The spawn server waits up to 2 s for the shell's stdio pumps to drain after
// the root process exits and then reports the exit regardless (main.rs
// run_spawn). A close that lands at/after this threshold therefore means the
// pipes were STILL held by another process at that deadline, not that draining
// was slow — a normal command closes within milliseconds of its exit.
export const STDIO_HELD_AFTER_EXIT_MS = 1_500;

// Windows attaches a console host to the hidden console the shell runs in. It
// is a real child of the shell and it lives exactly as long as console clients
// remain, which makes it a liveness WITNESS for descendants that pid-level
// tracking can no longer reach — but it is never a kill target: terminating it
// leaves the actual worker running (verified) and would only destroy the
// witness.
const CONSOLE_HOST = /^conhost\.exe$/i;

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists but is not ours to signal. ESRCH: gone.
    return error?.code === 'EPERM';
  }
}

function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Observe what the finished command left running.
 *
 *  Returns null when nothing is left (the normal case — the caller then
 *  reports a plain completion), or a handle describing the survivors:
 *    groupPid   POSIX process group that still has members
 *    killPids   pids a cancellation can signal directly
 *    watchPids  pids whose liveness answers "is this task still running?"
 *    reachable  false when survivors are observable but no longer addressable
 *               by pid (Windows re-parents nothing: a process whose parent
 *               exited keeps a dangling parent id, so an intermediate that
 *               already exited breaks the link). */
export async function probeShellDescendants({ pid, stdioHeld = false } = {}) {
  const root = Number(pid) || 0;
  if (root <= 0) return null;
  if (!isWin) {
    if (!groupAlive(root)) return null;
    return { groupPid: root, killPids: [], watchPids: [], reachable: true };
  }
  if (!stdioHeld) return null;
  const found = await collectDescendantProcesses(root).catch(() => []);
  const live = found.filter((entry) => pidAlive(entry.pid));
  if (live.length === 0) return null;
  const killPids = live.filter((entry) => !CONSOLE_HOST.test(entry.name)).map((entry) => entry.pid);
  return {
    groupPid: null,
    killPids,
    watchPids: live.map((entry) => entry.pid),
    reachable: killPids.length > 0,
  };
}

/** True while the observed survivors are still running. */
export function descendantsAlive(handle) {
  if (!handle) return false;
  if (handle.groupPid) return groupAlive(handle.groupPid);
  return handle.watchPids.some((pid) => pidAlive(pid));
}

/** Resolve once every observed survivor has exited. Poll-based on purpose:
 *  these processes are not our children any more, so there is no exit event to
 *  subscribe to — only their liveness can be observed. */
export async function waitForShellDescendants(handle, { pollMs = 1_000, signal = null } = {}) {
  while (descendantsAlive(handle)) {
    if (signal?.aborted) return false;
    await delay(pollMs);
  }
  return true;
}

/** Terminate the survivors. POSIX signals the whole process group, so the kill
 *  is complete by construction; Windows kills every reachable tree and then
 *  RE-OBSERVES, so the caller reports what actually died instead of what was
 *  signalled. */
export async function killShellDescendants(handle) {
  if (!handle) return { terminated: true, survivors: [] };
  if (handle.groupPid) {
    try { process.kill(-handle.groupPid, 'SIGTERM'); } catch { /* already gone */ }
    await delay(200);
    if (groupAlive(handle.groupPid)) {
      try { process.kill(-handle.groupPid, 'SIGKILL'); } catch { /* already gone */ }
      await delay(100);
    }
    return { terminated: !groupAlive(handle.groupPid), survivors: [] };
  }
  await killProcessTrees(handle.killPids).catch(() => {});
  const survivors = handle.watchPids.filter((pid) => pidAlive(pid));
  return { terminated: survivors.length === 0, survivors };
}
