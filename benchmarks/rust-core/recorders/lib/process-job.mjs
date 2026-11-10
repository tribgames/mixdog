// A Windows job for the processes one recorder step starts, so that the whole tree it started ends with it, however it ends.
//
// `withJob(what, use)` creates a job (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway allowed) whose one handle is held by a PowerShell guard
// this process starts first (outside the job). `job.run(command, args, …)` starts the command through a gate (a Node script that waits on its
// stdin before it starts the command), puts the gate's pid into the job, then lets it go: the command and everything it starts are in the
// job from their first instruction. When the command exits, or at its deadline, the guard ends every process still in the job and waits,
// on the job's completion port (JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO), until none is left; how many were left is the run's `left`. If this
// process ends first for any reason, the guard's stdin closes, it exits, and Windows ends every process in the job (kill on close).
// Node's own job (libuv `uv__init_global_job_handle`) ends only a process's direct children and allows silent breakaway; this one allows
// none. Neither Node, mixdogd, git nor pg_ctl starts a process with CREATE_BREAKAWAY_FROM_JOB.
import { spawn } from 'node:child_process';

const GUARD = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RecorderJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong Reads, Writes, Others, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Limits; public Io Counters; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct Port { public IntPtr Key; public IntPtr Handle; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetInformationJobObject")] static extern bool SetLimits(IntPtr job, int infoClass, ref Extended info, int length);
  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetInformationJobObject")] static extern bool SetPort(IntPtr job, int infoClass, ref Port info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr overlapped, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  static IntPtr job, port;
  public static void Create() {
    job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Extended limits = new Extended();
    limits.Limits.LimitFlags = 0x2000;
    if (!SetLimits(job, 9, ref limits, Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception();
    port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
    if (port == IntPtr.Zero) throw new Win32Exception();
    Port association = new Port(); association.Key = job; association.Handle = port;
    if (!SetPort(job, 7, ref association, Marshal.SizeOf(typeof(Port)))) throw new Win32Exception();
  }
  public static void Assign(int pid) {
    IntPtr process = OpenProcess(0x0101, false, pid);
    if (process == IntPtr.Zero) throw new Win32Exception();
    try { if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(); } finally { CloseHandle(process); }
  }
  static uint Active() {
    Accounting info;
    if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
    return info.ActiveProcesses;
  }
  // Waits until the job has no process left, each wait on the job's own completion message, up to ms; true if it emptied.
  static bool Empties(int ms) {
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(ms);
    while (Active() > 0) {
      int remaining = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
      if (remaining <= 0) return false;
      uint message; UIntPtr key; IntPtr overlapped;
      GetQueuedCompletionStatus(port, out message, out key, out overlapped, (uint)remaining);
    }
    return true;
  }
  // Lets the job's processes end by themselves for up to grace ms (a process ending as its parent did, as a pipe's reader does once
  // the pipe closes), then ends every process still in it and waits up to ms for them; returns how many it had to end.
  public static string Finish(int grace, int ms) {
    if (Empties(grace)) return "0";
    int left = (int)Active();
    if (!TerminateJobObject(job, 1)) throw new Win32Exception();
    if (!Empties(ms)) throw new TimeoutException(Active() + " process(es) of the job still running " + ms + " ms after it was ended");
    return left.ToString();
  }
}`;

const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${GUARD}
'@
[RecorderJob]::Create()
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.StartsWith('assign ')) { [RecorderJob]::Assign([int]$line.Substring(7)); [Console]::Out.WriteLine('assigned') }
  elseif ($line.StartsWith('end ')) { $ms = $line.Substring(4).Split(' '); $left = [RecorderJob]::Finish([int]$ms[0], [int]$ms[1]); [Console]::Out.WriteLine("ended $left") }
  [Console]::Out.Flush()
}
`;

// The gate: waits for one line on its stdin (sent once its pid is in the job), then runs the command with this process's stdout and stderr.
const GATE = `process.stdin.once('data', () => {
  process.stdin.destroy();
  const r = require('node:child_process').spawnSync(process.argv[1], process.argv.slice(2), { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  if (r.error) console.error('the gate could not start ' + process.argv[1] + ': ' + r.error.message);
  process.exit(r.status ?? 1);
});`;

const GUARD_DEADLINE_MS = 60_000;
/** How long the processes a command leaves behind may take to end by themselves once it exited (tsx's esbuild service ends when the
 *  pipe from its parent closes) before they count as left running. */
const LEFT_GRACE_MS = 10_000;

/** `promise`, or a failure naming `what` once `ms` have passed. */
function within(ms, promise, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

async function startGuard(what, answerMs) {
  const guard = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let err = '';
  let buffered = '';
  const replies = [];
  const waiting = [];
  let gone = null;
  const exited = new Promise((resolve) => guard.once('exit', resolve));
  // A write after the guard exited fails that call through `gone` below, not the process.
  guard.stdin.on('error', () => {});
  guard.stderr.on('data', (chunk) => (err += chunk));
  guard.stdout.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      if (waiting.length) waiting.shift().resolve(line);
      else replies.push(line);
    }
  });
  exited.then((code) => {
    gone = new Error(`${what}: the job guard exited ${code}:\n${err}`);
    for (const w of waiting.splice(0)) w.reject(gone);
  });
  const next = (ms, asked) =>
    within(
      ms,
      replies.length ? Promise.resolve(replies.shift()) : gone ? Promise.reject(gone) : new Promise((resolve, reject) => waiting.push({ resolve, reject })),
      `${what}: the job guard's answer to ${asked}`,
    );
  const ask = async (line, expect, ms) => {
    guard.stdin.write(`${line}\n`);
    const reply = await next(ms, line);
    if (!reply.startsWith(expect)) throw new Error(`${what}: the job guard answered ${reply} to ${line}:\n${err}`);
    return reply;
  };
  try {
    const ready = await next(GUARD_DEADLINE_MS, 'its start');
    if (ready !== 'ready') throw new Error(`${what}: the job guard said ${ready}:\n${err}`);
  } catch (error) {
    guard.kill();
    throw error;
  }
  return {
    pid: guard.pid,
    assign: (pid) => ask(`assign ${pid}`, 'assigned', answerMs),
    /** Ends every process in the job once `grace` ms passed without it emptying; resolves with how many it had to end. */
    end: async (grace) => Number((await ask(`end ${grace} ${answerMs}`, 'ended', grace + answerMs * 2)).split(' ')[1]),
    close: async () => {
      guard.stdin.end();
      try {
        await within(answerMs, exited, `${what}: the job guard to exit`);
      } catch (error) {
        // A guard that no longer answers still holds the job's one handle. Ending the guard itself closes that handle, and the job
        // (KILL_ON_JOB_CLOSE) ends every process in it; the failure that brought us here is the one reported.
        guard.kill();
        await within(answerMs, exited, `${what}: the job guard to exit after it was ended by force`);
        throw error;
      }
    },
  };
}

/** Runs `use(job)` with a job of its own, closed (every process in it ended) however `use` ends. `job.guardPid` is the guard holding the
 *  job's handle; `answerMs` bounds each of the guard's answers and its exit (the process-job test shortens it). */
export async function withJob(what, use, { answerMs = GUARD_DEADLINE_MS } = {}) {
  const guard = await startGuard(what, answerMs);
  const run = (label, command, args, { cwd, env, ms }) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', GATE, command, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      let timer = null;
      let settled = false;
      const exited = new Promise((done) => child.once('exit', (code) => done(code)));
      // Its output is whole once its pipes close, which a process it left running (holding them) delays until the job is ended.
      const closed = new Promise((done) => child.once('close', done));
      const settle = (code, timedOut) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Ended here on every path: what the command left running past the grace is counted, and ended (at once past its deadline).
        guard
          .end(timedOut ? 0 : LEFT_GRACE_MS)
          .then(async (left) => {
            await within(GUARD_DEADLINE_MS, closed, `${label}: its output to close once its job was ended`);
            resolve({ code, stdout, stderr, left, timedOut });
          })
          .catch(reject);
      };
      // A run that fails before its command started: nothing is left for the deadline to end.
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', (error) => fail(new Error(`${label}: the gate did not start: ${error.message}`)));
      // `ms` counts from this call, the guard's assignment included. Until the gate is told to go it runs nothing and is in no
      // job yet, so a deadline that passes first ends the gate itself.
      let assigned = false;
      timer = setTimeout(() => {
        if (!assigned) child.kill();
        settle(null, true);
      }, ms);
      guard.assign(child.pid).then(
        () => {
          assigned = true;
          if (settled) {
            child.kill();
            return;
          }
          exited.then((code) => settle(code, false));
          child.stdin.end('go\n');
        },
        (error) => {
          child.kill();
          fail(error);
        },
      );
    });
  try {
    return await use({ run, guardPid: guard.pid });
  } finally {
    // The job is closed however its ending went; of the two, the first failure is the one reported (a guard that stopped answering fails
    // the ending first, and its close then ends it by force).
    const ending = await guard.end(0).then(
      () => null,
      (error) => error,
    );
    await guard.close().catch((error) => {
      throw ending ?? error;
    });
    if (ending) throw ending;
  }
}
