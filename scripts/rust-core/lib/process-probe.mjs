// Test support: read-only process queries. A process is identified by its pid together with the start time read when it was
// first seen, and nothing here signals a number: ending a process is the tree helper's work, on a handle it owns.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { helperPath } from './process-tree.mjs';

const run = promisify(execFile);
const WINDOWS = process.platform === 'win32';
const POWERSHELL = ['-NoProfile', '-NonInteractive', '-Command'];

// `script` is fixed text. A value that came from outside (a path, a start time) travels in `values` as PROBE_<NAME>
// environment variables and is read there as `$env:PROBE_<NAME>`: it is data to the script and never parsed as PowerShell.
async function powershell(script, timeout, values = {}) {
  const env = { ...process.env, ...Object.fromEntries(Object.entries(values).map(([name, value]) => [`PROBE_${name}`, String(value)])) };
  try {
    return (await run('powershell.exe', [...POWERSHELL, `$ProgressPreference = 'SilentlyContinue'; ${script}`], { timeout, windowsHide: true, env })).stdout.trim();
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
/**
 * Rejects unless every recorded process is gone within `deadlineMs`. A process is identified by pid together with the start
 * time read when it was first seen, so a pid that now belongs to another process counts as gone. Windows: waits on the
 * recorded process's own exit. POSIX: one query after the tree helper exited (it signals the group before it exits); a
 * zombie is dead. Nothing here ends anything.
 * @param {{ pid: number, start: string|null }[]} members
 */
export async function assertTreeGone(members, deadlineMs = 30_000) {
  const stop = Date.now() + deadlineMs;
  for (const { pid, start } of members) {
    if (start === null) continue;
    if (WINDOWS) {
      const left = Math.max(1, stop - Date.now());
      const answer = await powershell(`${WIN_FIND(pid)}; if ([string]$p.StartTime.ToFileTimeUtc() -ne $env:PROBE_START) { exit 0 }; if ($p.WaitForExit(${Math.trunc(left)})) { exit 0 } else { 'running' }`, left + 30_000, { START: start });
      if (answer === 'running') throw new Error(`pid ${pid} (start ${start}) is still running ${deadlineMs}ms after its tree was ended`);
      continue;
    }
    const { stdout } = await run('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], { timeout: 60_000 }).catch((error) => {
      if (error.code === 1) return { stdout: '' };
      throw new Error(`process query failed: ${error.stderr?.trim() || error.message}`);
    });
    const row = stdout.trim();
    if (row && !row.startsWith('Z') && row.slice(row.indexOf(' ')).trim() === start) throw new Error(`pid ${pid} (start ${start}) is still running after its tree was ended`);
  }
}

/** The processes whose executable path (Windows) or command line (POSIX) lies inside `dir`: a read, nothing is signalled. */
export async function processesInside(dir) {
  if (WINDOWS) {
    // WQL LIKE: the directory with a trailing separator, its backslash and quote escaped, its wildcards made literal.
    const script = String.raw`$d = $env:PROBE_DIR.TrimEnd('\', '/') + '\'; $q = $d.Replace('\', '\\').Replace("'", "\'").Replace('%', '[%]').Replace('_', '[_]'); Get-CimInstance Win32_Process -Filter "ExecutablePath LIKE '$q%'" | ForEach-Object { "$($_.ProcessId)` + '`' + String.raw`t$($_.ExecutablePath)" }`;
    const stdout = await powershell(script, 60_000, { DIR: dir });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => ({ pid: Number(line.split('\t')[0]), what: line.split('\t')[1] }));
  }
  const { stdout } = await run('ps', ['-A', '-ww', '-o', 'pid=,args='], { timeout: 60_000 });
  return stdout.split('\n').map((line) => line.trim().match(/^(\d+) (.*)$/)).filter((m) => m && m[2].includes(dir)).map((m) => ({ pid: Number(m[1]), what: m[2] }));
}

/**
 * A run's own directory must hold no running process once its core is stopped (what escaped the tree's group is the core's
 * Postgres, which the core's own shutdown ends). Anything found is ended through the helper, which verifies it inside `dir`
 * on the handle it terminates (never macOS: reported only) and then fails the run naming every one found.
 */
export async function assertNothingInside(dir) {
  const found = await processesInside(dir);
  if (!found.length) return;
  const notes = [];
  for (const { pid, what } of found) {
    try {
      await run(helperPath(), ['--end-inside', dir, String(pid)], { timeout: 60_000, windowsHide: true });
      notes.push(`pid ${pid} (${what}) was left running and has been ended`);
    } catch (error) {
      notes.push(`pid ${pid} (${what}) is left running and was not ended (${error.code === 4 ? 'no verified handle on this system' : String(error.stderr).trim() || error.message})`);
    }
  }
  throw new Error(`processes of the run outlived it inside ${dir}: ${notes.join('; ')}`);
}
/** The pids of the processes running the executable at `path`. */
export async function pidsOfExecutable(path) {
  if (WINDOWS) {
    const script = String.raw`$q = $env:PROBE_PATH.Replace('\', '\\').Replace("'", "\'"); Get-CimInstance Win32_Process -Filter "ExecutablePath='$q'" | ForEach-Object { $_.ProcessId }`;
    const stdout = await powershell(script, 60_000, { PATH: path });
    return stdout.split(/\r?\n/).filter(Boolean).map(Number);
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,args='], { timeout: 60_000 });
  return stdout.split('\n').map((line) => line.trim().match(/^(\d+) (.*)$/)).filter((m) => m && (m[2] === path || m[2].startsWith(`${path} `))).map((m) => Number(m[1]));
}