// Test support: identify a process by its pid together with its start time, read when it was first seen, and prove a tree
// gone by a structured query bounded by a deadline. Nothing here ends a process by a pid alone: a pid can be reused once its
// process has exited, so a kill compares the start time first.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { helperPath } from './process-tree.mjs';

const run = promisify(execFile);
const WINDOWS = process.platform === 'win32';
const POWERSHELL = ['-NoProfile', '-NonInteractive', '-Command'];

async function powershell(script, timeout) {
  try {
    return (await run('powershell.exe', [...POWERSHELL, `$ProgressPreference = 'SilentlyContinue'; ${script}`], { timeout, windowsHide: true })).stdout.trim();
  } catch (error) {
    throw new Error(`process query failed: ${error.stderr?.trim() || error.message}`);
  }
}

// PowerShell: the process of `pid`, or exit 0 with no output when there is none (ArgumentException); any other failure is an error.
const WIN_FIND = (pid) => `try { $p = [System.Diagnostics.Process]::GetProcessById(${Number(pid)}) } catch [System.ArgumentException] { exit 0 }`;

const startTimeQuery = (pid) =>
  WINDOWS
    ? ['powershell.exe', [...POWERSHELL, `$ProgressPreference = 'SilentlyContinue'; ${WIN_FIND(pid)}; $p.StartTime.ToFileTimeUtc()`]]
    : ['ps', ['-o', 'lstart=', '-p', String(pid)]];

/** The start time of the process with `pid` as an opaque string, or null when there is no such process. */
export async function startTimeOf(pid) {
  const [file, args] = startTimeQuery(pid);
  try {
    return (await run(file, args, { timeout: 60_000, windowsHide: true })).stdout.trim() || null;
  } catch (error) {
    if (!WINDOWS && error.code === 1) return null; // ps: no such process
    throw new Error(`process query failed: ${error.stderr?.trim() || error.message}`);
  }
}

/** `startTimeOf`, blocking: for a script that must record its children before it goes on (a CommonJS preload). */
export function startTimeOfSync(pid) {
  const [file, args] = startTimeQuery(pid);
  try {
    return execFileSync(file, args, { timeout: 60_000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null;
  } catch (error) {
    if (!WINDOWS && error.status === 1) return null;
    throw new Error(`process query failed: ${error.stderr?.trim() || error.message}`);
  }
}
/** Ends the process only while it is still the one first seen (same pid and start time); true when it was ended. */
export async function endIfSame({ pid, start }) {
  if (start === null) return false;
  if (WINDOWS) {
    return (await powershell(`${WIN_FIND(pid)}; if ([string]$p.StartTime.ToFileTimeUtc() -ne '${start}') { exit 0 }; $p.Kill(); if (-not $p.WaitForExit(30000)) { throw 'pid ${pid} did not exit within 30 s' }; 'ended'`, 60_000)) === 'ended';
  }
  if ((await startTimeOf(pid)) !== start) return false;
  process.kill(pid, 'SIGKILL');
  return true;
}

/** The pids carrying the tree mark (POSIX; the helper reads the same environment mark it ends by). */
export async function treeMembers(mark) {
  const { stdout } = await run(helperPath(), ['--members', mark], { timeout: 60_000 });
  return stdout.split(/\r?\n/).filter(Boolean).map(Number);
}

/**
 * Rejects unless every member recorded when first seen is gone within `deadlineMs`. Windows: the exit of each recorded
 * process (a pid that now has another start time is gone too). POSIX: the mark sweep finds nothing, queried until it does.
 * @param {{ mark: string, members: { pid: number, start: string|null }[] }} tree
 */
export async function assertTreeGone({ mark, members }, deadlineMs = 30_000) {
  const stop = Date.now() + deadlineMs;
  if (WINDOWS) {
    for (const { pid, start } of members) {
      if (start === null) continue;
      const left = Math.max(1, stop - Date.now());
      const answer = await powershell(`${WIN_FIND(pid)}; if ([string]$p.StartTime.ToFileTimeUtc() -ne '${start}') { exit 0 }; if ($p.WaitForExit(${left})) { exit 0 } else { 'running' }`, left + 30_000);
      if (answer === 'running') throw new Error(`pid ${pid} (start ${start}) is still running ${deadlineMs}ms after its tree was ended`);
    }
    return;
  }
  let left = await treeMembers(mark);
  while (left.length && Date.now() < stop) left = await treeMembers(mark);
  if (left.length) throw new Error(`processes marked ${mark} are still running ${deadlineMs}ms after their tree was ended: pid ${left.join(', ')}`);
}

/** The pids of the processes running the executable at `path`. */
export async function pidsOfExecutable(path) {
  if (WINDOWS) {
    const wql = path.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    const stdout = await powershell(`Get-CimInstance Win32_Process -Filter "ExecutablePath='${wql.replaceAll('"', '""')}'" | ForEach-Object { $_.ProcessId }`, 60_000);
    return stdout.split(/\r?\n/).filter(Boolean).map(Number);
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,args='], { timeout: 60_000 });
  return stdout.split('\n').map((line) => line.trim().match(/^(\d+) (.*)$/)).filter((m) => m && (m[2] === path || m[2].startsWith(`${path} `))).map((m) => Number(m[1]));
}