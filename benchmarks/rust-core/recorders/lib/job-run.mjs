// Runs a program inside a Windows job object of its own, so what it leaves behind is found by ownership, not by text: every process
// it starts, and every process those start, is a member of the job (a member's children join their parent's jobs), whatever its
// command line names. The job is held by a PowerShell host that joins it before starting the program with exactly the given
// environment. The job reports every process that joins or leaves it to the host's completion port, in the order it happened; the
// host follows those reports until the program's own exit, and every member other than itself that had joined and not left by then
// is left behind, whether or not it ends by itself afterwards. Reports to a completion port are notifications the system may drop
// (and a member ended through a job of its own, as the core's extension workers are, is not reported leaving this one), so a member
// with no exit report is read from the handle taken when it joined: it is left behind unless it exited strictly before the program;
// and the joins are checked against the job's own accounting (TotalProcesses, ActiveProcesses): a join it was not told of fails the
// run instead of being missed. The host then ends every remaining member (TerminateJobObject, which ends the host as well, after
// its report is written: the host's own exit code is then not the program's; the report's is). The job is made with
// KILL_ON_JOB_CLOSE, so ending the host (a deadline, a failure) ends the whole tree.
//
//   const child = spawnInJob(file, args, { env, cwd, stdio, report });   // a ChildProcess: the host, with the program's exit code
//   ... await its exit ...
//   const { exitCode, program, left } = readJobReport(report);            // left: [{ pid, name, parentPid, parent, commandLine }]
//   (name, parent and command line are taken when a member joins; `parent` is the parent's name while it was a member, otherwise null)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const HOST = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class JobRun {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr detail, uint ms);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, IntPtr returned);
  static IntPtr job, port;
  // Every process that has joined the job and not left it, in the order the job reported their joins, and how many joins it reported.
  static readonly List<long> alive = new List<long>();
  static long joins;
  public static readonly Dictionary<long, string> names = new Dictionary<long, string>();
  static readonly Dictionary<long, long> parents = new Dictionary<long, long>();
  static readonly Dictionary<long, string> commandLines = new Dictionary<long, string>();
  static readonly Dictionary<long, IntPtr> members = new Dictionary<long, IntPtr>();
  public static string CommandLineOf(long pid) { string line; return commandLines.TryGetValue(pid, out line) ? line : null; }
  public static string NameOf(long pid) { string name; return names.TryGetValue(pid, out name) ? name : null; }
  /** The parent's name when the parent was a member of the job (a name taken while it ran), otherwise null. */
  public static string ParentNameOf(long pid) { long parent; return parents.TryGetValue(pid, out parent) ? NameOf(parent) : null; }
  public static long ParentOf(long pid) { long parent; return parents.TryGetValue(pid, out parent) ? parent : -1; }
  public static void Create() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes on x64); LimitFlags at 16: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
    IntPtr info = Marshal.AllocHGlobal(144);
    for (int i = 0; i < 144; i++) Marshal.WriteByte(info, i, 0);
    Marshal.WriteInt32(info, 16, 0x2000);
    bool set = SetInformationJobObject(job, 9, info, 144);
    Marshal.FreeHGlobal(info);
    if (!set) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    // The port is associated before the first member joins (JOBOBJECT_ASSOCIATE_COMPLETION_PORT, class 7), so every join is reported.
    port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
    if (port == IntPtr.Zero) throw new Exception("CreateIoCompletionPort failed: " + Marshal.GetLastWin32Error());
    IntPtr assoc = Marshal.AllocHGlobal(16);
    Marshal.WriteIntPtr(assoc, 0, IntPtr.Zero);
    Marshal.WriteIntPtr(assoc, 8, port);
    set = SetInformationJobObject(job, 7, assoc, 16);
    Marshal.FreeHGlobal(assoc);
    if (!set) throw new Exception("associating the completion port failed: " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
  }
  /** Follows the job's reports until the process 'program' has left it; returns the members that were in it then, the host's excluded. */
  public static long[] UntilExit(long program, long host) {
    while (true) {
      uint message; UIntPtr key; IntPtr detail;
      // No deadline here: the caller's deadline ends the host, and with it the job (KILL_ON_JOB_CLOSE).
      if (!GetQueuedCompletionStatus(port, out message, out key, out detail, 0xFFFFFFFF)) throw new Exception("GetQueuedCompletionStatus failed: " + Marshal.GetLastWin32Error());
      long pid = detail.ToInt64();
      // JOB_OBJECT_MSG_NEW_PROCESS 6, JOB_OBJECT_MSG_EXIT_PROCESS 7, JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS 8.
      if (message == 6) {
        joins++;
        alive.Add(pid);
        // Its name and its parent's while it runs, for the report: a member may be gone by the time the report is written.
        names[pid] = null;
        parents[pid] = -1;
        try {
          System.Diagnostics.Process member = System.Diagnostics.Process.GetProcessById((int)pid);
          names[pid] = member.ProcessName;
          // A handle of its own (SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION), kept so its exit time can be read when its exit
          // report is missing (AtProgramExit).
          IntPtr own = OpenProcess(0x101000, false, (uint)pid);
          if (own != IntPtr.Zero) members[pid] = own;
          // PROCESS_BASIC_INFORMATION (class 0, 48 bytes on x64): InheritedFromUniqueProcessId at 40.
          IntPtr basic = Marshal.AllocHGlobal(48);
          try {
            if (NtQueryInformationProcess(member.Handle, 0, basic, 48, IntPtr.Zero) == 0) parents[pid] = Marshal.ReadInt64(basic, 40);
          } finally {
            Marshal.FreeHGlobal(basic);
          }
          // ProcessCommandLineInformation (class 60): a UNICODE_STRING (Length at 0, Buffer at 8) followed by its text.
          IntPtr line = Marshal.AllocHGlobal(65536);
          try {
            if (NtQueryInformationProcess(member.Handle, 60, line, 65536, IntPtr.Zero) == 0) {
              commandLines[pid] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(line, 8), (ushort)Marshal.ReadInt16(line, 0) / 2);
            }
          } finally {
            Marshal.FreeHGlobal(line);
          }
        } catch (ArgumentException) {
        } catch (InvalidOperationException) {
        } catch (System.ComponentModel.Win32Exception) {
        }
      } else if (message == 7 || message == 8) {
        alive.Remove(pid);
        if (pid == program) break;
      }
    }
    List<long> left = new List<long>(alive);
    left.Remove(host);
    left.Remove(program);
    return AtProgramExit(left, program);
  }
  /** A process ended through a job of its own (a nested job's TerminateJobObject) is not reported leaving this one, and the system
   *  may drop any exit report: a member reported joining but not leaving is read from the handle taken when it joined. It was in the
   *  job when the program exited unless it had exited strictly before the program did; a member with no handle is not guessed. */
  static long[] AtProgramExit(List<long> unreported, long program) {
    IntPtr self;
    if (!members.TryGetValue(program, out self)) throw new Exception("the program's own handle was not taken when it joined");
    if (WaitForSingleObject(self, 0xFFFFFFFF) != 0) throw new Exception("waiting for the program's handle failed: " + Marshal.GetLastWin32Error());
    long programExit = ExitTimeOf(self);
    List<long> left = new List<long>();
    foreach (long pid in unreported) {
      IntPtr member;
      if (!members.TryGetValue(pid, out member)) throw new Exception("member " + pid + " (" + NameOf(pid) + ") had no handle when it joined and no exit was reported: whether it outlived the program is unknown");
      // WAIT_OBJECT_0: it has exited; WAIT_TIMEOUT (0x102): it still runs.
      uint state = WaitForSingleObject(member, 0);
      if (state != 0 && state != 0x102) throw new Exception("reading member " + pid + "'s state failed: " + Marshal.GetLastWin32Error());
      if (state == 0 && ExitTimeOf(member) < programExit) continue;
      left.Add(pid);
    }
    return left.ToArray();
  }
  static long ExitTimeOf(IntPtr process) {
    long created, exited, kernel, user;
    if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) throw new Exception("GetProcessTimes failed: " + Marshal.GetLastWin32Error());
    return exited;
  }
  /** With no member left behind, the job's accounting must agree with its reports: every process it ever held was reported joining,
   *  and the host is its only member. A disagreement means a report was dropped, and membership at the program's exit is unknown. */
  public static string Unreported() {
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (class 1, 48 bytes): TotalProcesses at 36, ActiveProcesses at 40.
    IntPtr info = Marshal.AllocHGlobal(48);
    try {
      if (!QueryInformationJobObject(job, 1, info, 48, IntPtr.Zero)) throw new Exception("QueryInformationJobObject failed: " + Marshal.GetLastWin32Error());
      long total = (uint)Marshal.ReadInt32(info, 36);
      long active = (uint)Marshal.ReadInt32(info, 40);
      if (total == joins && active == 1) return null;
      return "the job held " + total + " processes (" + active + " active) but reported " + joins + " joins (" + alive.Count + " not left)";
    } finally {
      Marshal.FreeHGlobal(info);
    }
  }
  public static void End() {
    if (!TerminateJobObject(job, 1)) throw new Exception("TerminateJobObject failed: " + Marshal.GetLastWin32Error());
  }
}
'@
[JobRun]::Create()
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:JOB_RUN_FILE
$psi.Arguments = $env:JOB_RUN_ARGS
$psi.WorkingDirectory = $env:JOB_RUN_CWD
$psi.UseShellExecute = $false
$wanted = $env:JOB_RUN_ENV | ConvertFrom-Json
$report = $env:JOB_RUN_REPORT
$psi.EnvironmentVariables.Clear()
foreach ($p in $wanted.PSObject.Properties) { $psi.EnvironmentVariables[$p.Name] = [string]$p.Value }
$program = [System.Diagnostics.Process]::Start($psi)
$stayed = [JobRun]::UntilExit($program.Id, $PID)
$program.WaitForExit()
$code = $program.ExitCode
$unreported = $null
if ($stayed.Count -eq 0) { $unreported = [JobRun]::Unreported() }
$left = @()
foreach ($id in $stayed) {
  # A member may have ended since the program's exit: it is left behind all the same, named as it was when it joined.
  $left += [pscustomobject]@{ pid = [int]$id; name = [JobRun]::NameOf($id); parentPid = [JobRun]::ParentOf($id); parent = [JobRun]::ParentNameOf($id); commandLine = [JobRun]::CommandLineOf($id) }
}
[System.IO.File]::WriteAllText($report, (ConvertTo-Json -Compress -Depth 4 @{ exitCode = $code; program = $program.Id; left = @($left); unreported = $unreported; complete = $true }))
# Ending the job ends this host too (it is a member): the report is written first.
if ($left.Count -gt 0) { [JobRun]::End() }
exit $code
`;

/** One argument as CommandLineToArgvW reads it back. */
function quote(arg) {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** Starts `file args` in a job of its own (see above); `env` is the program's whole environment, `report` the host's report file. */
export function spawnInJob(file, args, { env, cwd, stdio, report }) {
  const hostEnv = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, JOB_RUN_FILE: file, JOB_RUN_ARGS: args.map(quote).join(' '), JOB_RUN_CWD: cwd, JOB_RUN_ENV: JSON.stringify(env), JOB_RUN_REPORT: report };
  const encoded = Buffer.from(HOST, 'utf16le').toString('base64');
  return spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env: hostEnv, cwd, stdio, windowsHide: true });
}

/** The host's report: the program's exit code and the members it left behind. A missing or incomplete report is a failure of the host. */
export function readJobReport(report) {
  if (!existsSync(report)) throw new Error(`the job host wrote no report (${report}): it failed before the program's members were listed`);
  const parsed = JSON.parse(readFileSync(report, 'utf8').replace(/^\uFEFF/, ''));
  if (parsed.complete !== true || !Array.isArray(parsed.left)) throw new Error(`the job host's report is incomplete: ${JSON.stringify(parsed)}`);
  if (parsed.unreported) throw new Error(`the job's membership at the program's exit is unknown: ${parsed.unreported}`);
  return { exitCode: parsed.exitCode, program: parsed.program, left: parsed.left };
}
