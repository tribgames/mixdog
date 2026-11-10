// Runs a program inside a Windows job object of its own, so what it leaves behind is found by ownership, not by text: every process
// it starts, and every process those start, is a member of the job (a member's children join their parent's jobs), whatever its
// command line names. The job is held by a PowerShell host that starts the program with exactly the given environment, waits for it
// to exit, then lists the job's members other than itself: a member still running after a bounded wait for it to finish exiting
// (10 s, a process ended at the program's own exit is gone well within it) is left behind. The host then ends every remaining member
// (TerminateJobObject, which ends the host as well, after its report is written: the host's own exit code is then not the program's;
// the report's is). The job is made with KILL_ON_JOB_CLOSE, so ending the host (a deadline, a failure)
// ends the whole tree.
//
//   const child = spawnInJob(file, args, { env, cwd, stdio, report });   // a ChildProcess: the host, with the program's exit code
//   ... await its exit ...
//   const { exitCode, left } = readJobReport(report);                     // left: [{ pid, name, commandLine }]
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
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static IntPtr Create() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes on x64); LimitFlags at 16: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
    IntPtr info = Marshal.AllocHGlobal(144);
    for (int i = 0; i < 144; i++) Marshal.WriteByte(info, i, 0);
    Marshal.WriteInt32(info, 16, 0x2000);
    bool set = SetInformationJobObject(job, 9, info, 144);
    Marshal.FreeHGlobal(info);
    if (!set) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
    return job;
  }
  public static long[] Members(IntPtr job) {
    const int max = 4096;
    IntPtr info = Marshal.AllocHGlobal(8 + 8 * max);
    try {
      if (!QueryInformationJobObject(job, 3, info, (uint)(8 + 8 * max), IntPtr.Zero)) throw new Exception("QueryInformationJobObject failed: " + Marshal.GetLastWin32Error());
      int assigned = Marshal.ReadInt32(info, 0);
      int listed = Marshal.ReadInt32(info, 4);
      if (listed != assigned) throw new Exception("the job lists " + listed + " of its " + assigned + " members");
      long[] ids = new long[listed];
      for (int i = 0; i < listed; i++) ids[i] = Marshal.ReadInt64(info, 8 + 8 * i);
      return ids;
    } finally {
      Marshal.FreeHGlobal(info);
    }
  }
  public static void End(IntPtr job) {
    if (!TerminateJobObject(job, 1)) throw new Exception("TerminateJobObject failed: " + Marshal.GetLastWin32Error());
  }
}
'@
$job = [JobRun]::Create()
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
$program.WaitForExit()
$code = $program.ExitCode
$left = @()
$members = [JobRun]::Members($job)
foreach ($id in $members) {
  if ($id -eq $PID) { continue }
  $member = $null
  try { $member = [System.Diagnostics.Process]::GetProcessById([int]$id) } catch [System.ArgumentException] { continue }
  if ($member.WaitForExit(10000)) { continue }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  $left += [pscustomobject]@{ pid = [int]$id; name = $cim.Name; commandLine = $cim.CommandLine }
}
[System.IO.File]::WriteAllText($report, (ConvertTo-Json -Compress -Depth 4 @{ exitCode = $code; members = @($members); left = @($left); complete = $true }))
# Ending the job ends this host too (it is a member): the report is written first.
if ($left.Count -gt 0) { [JobRun]::End($job) }
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
  return { exitCode: parsed.exitCode, left: parsed.left };
}
