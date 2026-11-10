// Starting a process and ending the WHOLE tree it grew, on Windows and on POSIX. A deadline that ends only the direct
// child leaves what it started (cargo's compilers and test binaries, an exec's tools) running.
import { spawn } from 'node:child_process';

const WINDOWS = process.platform === 'win32';
// Ending a process and waiting for its exit are processes' work too: they have a deadline.
const KILL_DEADLINE_MS = 30_000;

// Windows has no process group. The only identity that holds every descendant and nothing else is a job object, and
// Node cannot make one without a native addon. So a Windows child runs under a small PowerShell launcher that puts
// itself in a job (kill-on-close) before it starts the program: every process the program starts, whatever exits first,
// is in the job, and closing the job's last handle (the launcher's exit, however it comes) ends them all. No pid, no
// creation time, no parent walk: a pid reused by a stranger is not in the job. The program is the launcher's child with
// the launcher's own stdio; its exit code is the launcher's. 125: the program was not found, 126: it could not start.
const LAUNCHER = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TreeJob {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr held;
  public static void JoinKillOnClose() {
    held = CreateJobObject(IntPtr.Zero, null);
    if (held == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    int length = IntPtr.Size == 8 ? 144 : 112;
    IntPtr info = Marshal.AllocHGlobal(length);
    for (int i = 0; i < length; i++) Marshal.WriteByte(info, i, 0);
    Marshal.WriteInt32(info, 16, 0x2000);
    if (!SetInformationJobObject(held, 9, info, length)) throw new System.ComponentModel.Win32Exception();
    if (!AssignProcessToJobObject(held, GetCurrentProcess())) throw new System.ComponentModel.Win32Exception();
  }
}
"@
try { [TreeJob]::JoinKillOnClose() } catch { [Console]::Error.WriteLine("job launcher: could not create the job: $($_.Exception.Message)"); exit 126 }
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $env:MIXDOG_TREE_PROGRAM
$info.Arguments = $env:MIXDOG_TREE_ARGS
$info.UseShellExecute = $false
$info.EnvironmentVariables.Remove('MIXDOG_TREE_PROGRAM')
$info.EnvironmentVariables.Remove('MIXDOG_TREE_ARGS')
try { $child = [System.Diagnostics.Process]::Start($info) } catch {
  [Console]::Error.WriteLine("job launcher: could not start $($info.FileName): $($_.Exception.Message)")
  if ($_.Exception.InnerException -is [System.ComponentModel.Win32Exception] -and @(2, 3) -contains $_.Exception.InnerException.NativeErrorCode) { exit 125 }
  exit 126
}
$child.WaitForExit()
exit $child.ExitCode
`;
const LAUNCHER_ENCODED = Buffer.from(LAUNCHER, 'utf16le').toString('base64');

// The Windows command line of `program args` under the MSVCRT rules every program parses with.
const quote = (arg) => (arg !== '' && !/[\s"]/.test(arg) ? arg : `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);

/**
 * `spawn`, but the child's whole tree can be ended later by `endTree`: on POSIX the child leads its own process group;
 * on Windows it runs under the job launcher above, and the returned child is the launcher (its pid is the launcher's,
 * not the program's). A program that is not found emits 'error' with code ENOENT, as `spawn` does.
 */
export function spawnTree(program, args, options = {}) {
  if (!WINDOWS) return spawn(program, args, { ...options, detached: true });
  const { shell, env, ...rest } = options;
  const line = shell ? `/d /s /c "${[program, ...args].join(' ')}"` : args.map(quote).join(' ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', LAUNCHER_ENCODED], {
    ...rest,
    env: { ...(env ?? process.env), MIXDOG_TREE_PROGRAM: shell ? 'cmd.exe' : program, MIXDOG_TREE_ARGS: line },
    windowsHide: true,
  });
  child.once('exit', (code) => {
    if (code === 125) child.emit('error', Object.assign(new Error(`spawn ${program} ENOENT`), { code: 'ENOENT', syscall: `spawn ${program}`, path: program }));
    else if (code === 126) child.emit('error', Object.assign(new Error(`the job launcher could not start ${program} (exit 126; its stderr says why)`), { code: 'ELAUNCH' }));
  });
  return child;
}

const gone = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Ends `child` and every process it started, whether or not the child itself is still alive, and answers `{ killed }`:
 * the launcher's pid on Windows (its end closes the job, which ends every member), the process group id (negative) on
 * POSIX; empty when nothing was left to end. Rejects when the kill itself fails or the launcher does not exit in time.
 * The members of a Windows job are ended by the system as the launcher goes; prove one gone by waiting for its exit.
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
  if (gone(child)) return { killed: [] };
  let timer;
  const exited = new Promise((resolveExit, reject) => {
    child.once('exit', resolveExit);
    timer = setTimeout(() => reject(new Error(`the job launcher of pid ${child.pid} did not exit within ${deadlineMs}ms after it was killed`)), deadlineMs);
  }).finally(() => clearTimeout(timer));
  if (!child.kill()) throw new Error(`could not kill the job launcher of pid ${child.pid}`);
  await exited;
  return { killed: [child.pid] };
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
    // `code` is the spawn error's own (ENOENT for a program that is not there), so a caller can tell that from a deadline.
    const fail = async (message, code) => {
      ending = true;
      try {
        const { killed } = await endTree(child);
        reject(Object.assign(new Error(`${message} (ended: ${killed.length ? killed.join(', ') : 'nothing was left running'})`), { code }));
      } catch (error) {
        reject(Object.assign(new Error(`${message}; ${error.message}`), { code }));
      }
    };
    const deadline = setTimeout(() => fail(`${label} did not finish within ${deadlineMs}ms and was ended\n${stderr.slice(-600)}`), deadlineMs);
    child.once('error', (error) => {
      clearTimeout(deadline);
      fail(`${label} could not run: ${error.message}`, error.code);
    });
    // Whatever a command left behind is ended when it exits, success included: a run owns its whole tree.
    let endedOnExit = Promise.resolve();
    child.once('exit', () => {
      if (!ending) endedOnExit = endTree(child).then(() => null, (error) => error);
    });
    child.once('close', async (status) => {
      if (ending) return;
      const endError = await endedOnExit;
      clearTimeout(deadline);
      if (endError) reject(new Error(`${label} finished but its process tree could not be ended: ${endError.message}`));
      else resolveRun({ status, stdout, stderr });
    });
  });
}
