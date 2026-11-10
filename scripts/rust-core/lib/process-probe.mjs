// Test support: prove a process absent by waiting for its exit, not by guessing from one probe. A probe that cannot
// answer (the query fails, or the process outlives the deadline) is an error, never "gone".
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const WINDOWS = process.platform === 'win32';

/** Resolves when no process has pid `pid` (it exited within `deadlineMs`, or was never there); rejects when it is still running then. */
export async function waitGone(pid, deadlineMs = 30_000) {
  const seconds = Math.ceil(deadlineMs / 1000);
  try {
    if (WINDOWS) {
      const script = `try { Wait-Process -Id ${Number(pid)} -Timeout ${seconds} -ErrorAction Stop; exit 0 } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }`;
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: deadlineMs + 15_000, windowsHide: true });
    } else {
      // tail --pid returns when the process is gone, at once for one that is not there.
      await run('tail', [`--pid=${Number(pid)}`, '-f', '/dev/null'], { timeout: deadlineMs });
    }
  } catch (error) {
    throw new Error(`pid ${pid} is still running or could not be queried after ${deadlineMs}ms: ${error.stderr?.trim() || error.message}`);
  }
}

/** Ends pid `pid` if it is running (it was started by the test that calls this) and waits for its exit. */
export async function endAndWait(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await waitGone(pid);
}

/** The pids of the processes running the executable at `path`. */
export async function pidsOfExecutable(path) {
  if (WINDOWS) {
    const wql = path.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    const script = `Get-CimInstance Win32_Process -Filter "ExecutablePath='${wql.replaceAll('"', '""')}'" | ForEach-Object { $_.ProcessId }`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 60_000, windowsHide: true });
    return stdout.split(/\r?\n/).filter(Boolean).map(Number);
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,args='], { timeout: 60_000 });
  return stdout.split('\n').map((line) => line.trim().match(/^(\d+) (.*)$/)).filter((m) => m && (m[2] === path || m[2].startsWith(`${path} `))).map((m) => Number(m[1]));
}
