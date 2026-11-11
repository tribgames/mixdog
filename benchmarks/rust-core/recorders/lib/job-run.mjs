// Runs a program inside a Windows job object of its own, so what it leaves behind is found by ownership, not by text: every process
// it starts, and every process those start, is a member of the job (a member's children join their parent's jobs), whatever its
// command line names. A PowerShell host makes the job and starts the program suspended with exactly the given environment, puts it
// in the job and only then lets it run; the host itself stays outside the job. The job reports every process that joins or leaves
// it to the host's completion port. The host follows those reports until the program's exit, reads what the port then holds (while
// the members still run, so a join queued around the program's exit still gets its handle), ends the job (TerminateJobObject) and goes
// on reading until the job reports it has no member left (JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO); both under a deadline. Every report
// is read before membership is fixed.
//
// Left behind: every member other than the program that was created before the program exited and had not exited before it,
// whether or not it would have ended by itself afterwards. Its lifetime is read from the handle the host takes when it joins (an
// exit report may be dropped, and a member ended through a job of its own, as the core's extension workers are, is not reported
// leaving this one). A member that had already gone when its join was read has no handle: it had left before the program only if
// its exit report came before the program's; otherwise whether it outlived the program is unknown and the run fails.
//
// The reports are always checked against the job's own accounting, whatever was left: the job's TotalProcesses at its end must be
// the joins reported, and its ActiveProcesses read just after the program's exit must not exceed what the members' lifetimes give at
// that instant (a member that started or ended while the count was read, or within one clock tick of it since process times are kept
// at tick precision, counts on either side), plus the members it still lists after their exit was reported (a process is counted
// while it is torn down). A disagreement means a report was lost,
// so membership at the program's exit is unknown: the report says so and `readJobReport` fails the run. The job is made with
// KILL_ON_JOB_CLOSE, so ending the host (a caller's deadline, a failure) ends the whole tree.
//
//   const child = spawnInJob(file, args, { env, cwd, stdio, report });   // a ChildProcess: the host, with the program's exit code
//   ... await its exit ...
//   const { exitCode, program, left } = readJobReport(report);            // left: [{ pid, name, parentPid, parent, commandLine }]
//   (name, parent and command line are taken when a member joins; `parent` is the parent's name while it was a member, otherwise null)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// How long the host waits, after ending the job, for the job to report that no member is left.
const END_DEADLINE_MS = 30_000;

const HOST = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class JobRun {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string reserved; public string desktop; public string title;
    public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
    public short showWindow, reserved2Count; public IntPtr reserved2, stdInput, stdOutput, stdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public int processId, threadId; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr detail, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool PostQueuedCompletionStatus(IntPtr port, uint message, UIntPtr key, IntPtr detail);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long now);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, IntPtr returned);
  static IntPtr job, port, programHandle;
  public static long Program = -1;
  public static int ExitCode;
  public static string Unreported;
  // The joins in the order the job reported them, how many, and the place of each exit report among the exit reports.
  static readonly List<long> joined = new List<long>();
  static long joins;
  static readonly Dictionary<long, long> exitOrder = new Dictionary<long, long>();
  static long exits;
  static long programExitOrder = -1;
  static bool empty;
  public static readonly Dictionary<long, string> names = new Dictionary<long, string>();
  static readonly Dictionary<long, long> parents = new Dictionary<long, long>();
  static readonly Dictionary<long, string> commandLines = new Dictionary<long, string>();
  static readonly Dictionary<long, IntPtr> members = new Dictionary<long, IntPtr>();
  // Test-only (lib/job-run.test.mjs; no recorder or replay sets them): the k-th join report from the job is ignored, as if the system
  // had dropped it, or held back and posted again after the program's exit report, as if the system had queued it that late.
  public static long DropJoin, LateJoin;
  static long joinReports;
  static readonly List<long> late = new List<long>();
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
  }
  /** Reads one report from the port; false when none came within 'ms'. */
  static bool Next(uint ms) {
    uint message; UIntPtr key; IntPtr detail;
    if (!GetQueuedCompletionStatus(port, out message, out key, out detail, ms)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 258) return false;
      throw new Exception("GetQueuedCompletionStatus failed: " + error);
    }
    long pid = detail.ToInt64();
    // JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO 4, NEW_PROCESS 6, EXIT_PROCESS 7, ABNORMAL_EXIT_PROCESS 8. The job posts with key 0; a join
    // the test hook posts again carries key 1.
    if (message == 6) {
      if (key == UIntPtr.Zero) {
        joinReports++;
        if (joinReports == DropJoin) return true;
        if (joinReports == LateJoin) { late.Add(pid); return true; }
      }
      Join(pid);
    } else if (message == 7 || message == 8) {
      exitOrder[pid] = ++exits;
      if (pid == Program) {
        programExitOrder = exits;
        foreach (long held in late) {
          if (!PostQueuedCompletionStatus(port, 6, new UIntPtr(1), new IntPtr(held))) throw new Exception("PostQueuedCompletionStatus failed: " + Marshal.GetLastWin32Error());
        }
        late.Clear();
      }
    } else if (message == 4) {
      empty = true;
    }
    return true;
  }
  static void Join(long pid) {
    joins++;
    joined.Add(pid);
    names[pid] = null;
    parents[pid] = -1;
    // A handle of its own (SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION) for its lifetime, kept only when it is this job's member:
    // a process that has already gone may have handed its id on to another.
    IntPtr own = pid == Program ? programHandle : OpenProcess(0x101000, false, (uint)pid);
    if (own == IntPtr.Zero) return;
    bool inJob;
    if (!IsProcessInJob(own, job, out inJob) || !inJob) {
      if (pid != Program) CloseHandle(own);
      return;
    }
    members[pid] = own;
    // Its name, its parent's and its command line while it runs, for the report.
    try {
      System.Diagnostics.Process member = System.Diagnostics.Process.GetProcessById((int)pid);
      names[pid] = member.ProcessName;
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
  }
  static long[] Accounting() {
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (class 1, 48 bytes): TotalProcesses at 36, ActiveProcesses at 40.
    IntPtr info = Marshal.AllocHGlobal(48);
    try {
      if (!QueryInformationJobObject(job, 1, info, 48, IntPtr.Zero)) throw new Exception("QueryInformationJobObject failed: " + Marshal.GetLastWin32Error());
      return new long[] { (uint)Marshal.ReadInt32(info, 36), (uint)Marshal.ReadInt32(info, 40) };
    } finally {
      Marshal.FreeHGlobal(info);
    }
  }
  /** The ids of the processes the job holds (JOBOBJECT_BASIC_PROCESS_ID_LIST, class 3): two counts, then one id per pointer. */
  static long[] Listed() {
    for (int room = 64; ; room *= 4) {
      int size = 8 + room * 8;
      IntPtr info = Marshal.AllocHGlobal(size);
      try {
        if (QueryInformationJobObject(job, 3, info, (uint)size, IntPtr.Zero)) {
          long[] ids = new long[Marshal.ReadInt32(info, 4)];
          for (int i = 0; i < ids.Length; i++) ids[i] = Marshal.ReadInt64(info, 8 + i * 8);
          return ids;
        }
        int error = Marshal.GetLastWin32Error();
        if (error != 234) throw new Exception("QueryInformationJobObject (process ids) failed: " + error);
      } finally {
        Marshal.FreeHGlobal(info);
      }
    }
  }
  static long Now() { long now; GetSystemTimePreciseAsFileTime(out now); return now; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetSystemTimeAdjustment(out uint adjustment, out uint increment, out bool disabled);
  /** The clock's tick in 100 ns units: how far a coarse system time may lie behind the precise one. */
  static long TimeIncrement() {
    uint adjustment, increment; bool disabled;
    if (!GetSystemTimeAdjustment(out adjustment, out increment, out disabled)) throw new Exception("GetSystemTimeAdjustment failed: " + Marshal.GetLastWin32Error());
    return increment;
  }
  /** A member's creation and exit times (exit long.MaxValue while it runs). */
  static long[] Lifetime(IntPtr process) {
    long created, exited, kernel, user;
    if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) throw new Exception("GetProcessTimes failed: " + Marshal.GetLastWin32Error());
    uint state = WaitForSingleObject(process, 0);
    if (state != 0 && state != 0x102) throw new Exception("reading a member's state failed: " + Marshal.GetLastWin32Error());
    return new long[] { created, state == 0 ? exited : long.MaxValue };
  }
  /** Runs the program in the job (see the file's head); returns the members left behind at its exit, in join order. */
  public static long[] Run(string commandLine, string cwd, string environment, uint endDeadlineMs) {
    STARTUPINFO startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION info;
    IntPtr block = Marshal.StringToHGlobalUni(environment);
    try {
      // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT; the standard handles are inherited as Process.Start inherits them.
      if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x400, block, cwd, ref startup, out info)) throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
    } finally {
      Marshal.FreeHGlobal(block);
    }
    programHandle = info.process;
    Program = info.processId;
    if (!AssignProcessToJobObject(job, info.process)) {
      int error = Marshal.GetLastWin32Error();
      TerminateProcess(info.process, 1);
      throw new Exception("AssignProcessToJobObject failed: " + error);
    }
    if (ResumeThread(info.thread) == 0xFFFFFFFF) throw new Exception("ResumeThread failed: " + Marshal.GetLastWin32Error());
    CloseHandle(info.thread);
    // No deadline here: the caller's deadline ends the host, and with it the job (KILL_ON_JOB_CLOSE).
    while (programExitOrder < 0) Next(0xFFFFFFFF);
    if (WaitForSingleObject(programHandle, 0xFFFFFFFF) != 0) throw new Exception("waiting for the program's handle failed: " + Marshal.GetLastWin32Error());
    uint code;
    if (!GetExitCodeProcess(programHandle, out code)) throw new Exception("GetExitCodeProcess failed: " + Marshal.GetLastWin32Error());
    ExitCode = (int)code;
    long programExit = Lifetime(programHandle)[1];
    // What the port already holds is read while the members still run, so a join queued around the program's exit gets its handle.
    System.Diagnostics.Stopwatch since = System.Diagnostics.Stopwatch.StartNew();
    while (Next(0)) {
      if (since.ElapsedMilliseconds > endDeadlineMs) throw new Exception("the job's reports did not run out within " + endDeadlineMs + " ms of the program's exit (" + joins + " joins reported)");
    }
    long before = Now();
    // The list before the count: joins are reported, and a process leaves the job's list and count together (both are kept under
    // the job's lock), so a member the count holds that the host did not count as alive was already listed.
    long[] listedAtExit = Listed();
    long[] atExit = Accounting();
    long after = Now();
    if (!TerminateJobObject(job, 1)) throw new Exception("TerminateJobObject failed: " + Marshal.GetLastWin32Error());
    since.Restart();
    while (!empty) {
      long remaining = endDeadlineMs - since.ElapsedMilliseconds;
      if (remaining <= 0 || !Next((uint)remaining)) throw new Exception("the job did not report that no member is left within " + endDeadlineMs + " ms of being ended (" + joins + " joins reported)");
    }
    long[] atEnd = Accounting();
    // The members' lifetimes against the job's own counts. A process's creation and exit times are the system time as of the last
    // clock tick (KeQuerySystemTime), up to one increment earlier than the instant itself, while 'before' and 'after' are precise: a
    // member whose recorded exit is within one increment before 'before' may still have been counted.
    long increment = TimeIncrement();
    long surely = 0, possibly = 0;
    HashSet<long> counted = new HashSet<long>();
    List<long> left = new List<long>();
    List<string> problems = new List<string>();
    foreach (long pid in joined) {
      IntPtr member;
      if (members.TryGetValue(pid, out member)) {
        long[] life = Lifetime(member);
        if (life[0] <= before - increment && life[1] > after) surely++;
        if (life[0] <= after && life[1] > before - increment) { possibly++; counted.Add(pid); }
        if (pid != Program && life[0] <= programExit && life[1] >= programExit) left.Add(pid);
      } else {
        long order;
        bool gone = exitOrder.TryGetValue(pid, out order) && order < programExitOrder;
        if (!gone) { possibly++; counted.Add(pid); }
        if (pid != Program && !gone) problems.Add("member " + pid + " had gone when its join was read, and its exit was not reported before the program's: whether it outlived the program is unknown");
      }
    }
    if (atEnd[0] != joins) problems.Add("the job held " + atEnd[0] + " processes but reported " + joins + " joins");
    if (atEnd[1] != 0) problems.Add("the job reported no member left but counts " + atEnd[1] + " active");
    // Only the upper bound: a member the job counts and the host did not see (a lost join) makes the count exceed it. The lower bound
    // does not hold: the job stops counting an exiting member before its exit time is recorded (a full recording counted 1 where the
    // lifetimes gave 2), so a member may look alive past the read and not be counted. Nor does the job stop counting a member when
    // it exits: it keeps listing and counting it while the process is torn down, after its exit report was posted and its handle
    // signalled (a replay counted mixdogd 79.5 ms after its reported exit). Such a member was seen joining and leaving, so it is
    // no lost report: a listed member whose exit report was read before the count adds to what the lifetimes give.
    long lingering = 0;
    foreach (long pid in listedAtExit) {
      if (joined.Contains(pid) && exitOrder.ContainsKey(pid) && !counted.Contains(pid)) lingering++;
    }
    if (atExit[1] > possibly + lingering) {
      List<string> held = new List<string>();
      foreach (long pid in listedAtExit) {
        IntPtr member; long order;
        string state = !joined.Contains(pid) ? "never reported joining" : !members.TryGetValue(pid, out member) ? "no handle" : "exited " + ((Lifetime(member)[1] == long.MaxValue) ? "never" : ((before - Lifetime(member)[1]) / 10000.0).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " ms before the read");
        state += exitOrder.TryGetValue(pid, out order) ? ", exit report " + order + " (the program's " + programExitOrder + ")" : ", no exit report";
        held.Add(pid + " " + (NameOf(pid) ?? "?") + " (" + state + ")");
      }
      problems.Add("the job counted " + atExit[1] + " active members after the program's exit, its reported members' lifetimes give " + (surely == possibly ? surely.ToString() : surely + " to " + possibly) + "; it listed [" + string.Join(", ", held.ToArray()) + "]");
    }
    Unreported = problems.Count == 0 ? null : string.Join("; ", problems.ToArray());
    return left.ToArray();
  }
}
'@
$report = $env:JOB_RUN_REPORT
try {
  [JobRun]::Create()
  [JobRun]::DropJoin = [long]('0' + $env:JOB_RUN_TEST_DROP_JOIN)
  [JobRun]::LateJoin = [long]('0' + $env:JOB_RUN_TEST_LATE_JOIN)
  $wanted = $env:JOB_RUN_ENV | ConvertFrom-Json
  $pairs = [System.Collections.Generic.List[string]]::new()
  foreach ($p in $wanted.PSObject.Properties) { $pairs.Add($p.Name + '=' + [string]$p.Value) }
  $pairs.Sort([System.StringComparer]::OrdinalIgnoreCase)
  $block = ($pairs -join [char]0) + [char]0
  $stayed = [JobRun]::Run($env:JOB_RUN_COMMAND, $env:JOB_RUN_CWD, $block, [uint32]$env:JOB_RUN_END_DEADLINE_MS)
} catch {
  [System.IO.File]::WriteAllText($report, (ConvertTo-Json -Compress @{ error = $_.Exception.GetBaseException().Message }))
  exit 1
}
$left = @()
foreach ($id in $stayed) {
  # A member may have ended since the program's exit: it is left behind all the same, named as it was when it joined.
  $left += [pscustomobject]@{ pid = [int]$id; name = [JobRun]::NameOf($id); parentPid = [JobRun]::ParentOf($id); parent = [JobRun]::ParentNameOf($id); commandLine = [JobRun]::CommandLineOf($id) }
}
[System.IO.File]::WriteAllText($report, (ConvertTo-Json -Compress -Depth 4 @{ exitCode = [JobRun]::ExitCode; program = [JobRun]::Program; left = @($left); unreported = [JobRun]::Unreported; complete = $true }))
exit [JobRun]::ExitCode
`;

/** One argument as CommandLineToArgvW reads it back. */
function quote(arg) {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Starts `file args` in a job of its own (see above); `env` is the program's whole environment, `report` the host's report file (the
 * host's script is written next to it). `testHooks` ({ dropJoin, lateJoin }) is for lib/job-run.test.mjs only.
 */
export function spawnInJob(file, args, { env, cwd, stdio, report, testHooks = {} }) {
  const script = `${report}.host.ps1`;
  writeFileSync(script, `\uFEFF${HOST}`, 'utf8');
  const hostEnv = {
    SystemRoot: process.env.SystemRoot,
    PATH: process.env.PATH,
    JOB_RUN_COMMAND: [file, ...args].map(quote).join(' '),
    JOB_RUN_CWD: cwd,
    JOB_RUN_ENV: JSON.stringify(env),
    JOB_RUN_REPORT: report,
    JOB_RUN_END_DEADLINE_MS: String(END_DEADLINE_MS),
    ...(testHooks.dropJoin ? { JOB_RUN_TEST_DROP_JOIN: String(testHooks.dropJoin) } : {}),
    ...(testHooks.lateJoin ? { JOB_RUN_TEST_LATE_JOIN: String(testHooks.lateJoin) } : {}),
  };
  return spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env: hostEnv, cwd, stdio, windowsHide: true });
}

/** The host's report: the program's exit code and the members it left behind. A missing or incomplete report is a failure of the host. */
export function readJobReport(report) {
  if (!existsSync(report)) throw new Error(`the job host wrote no report (${report}): it failed before the program's members were listed`);
  const parsed = JSON.parse(readFileSync(report, 'utf8').replace(/^\uFEFF/, ''));
  if (parsed.error) throw new Error(`the job host failed: ${parsed.error}`);
  if (parsed.complete !== true || !Array.isArray(parsed.left)) throw new Error(`the job host's report is incomplete: ${JSON.stringify(parsed)}`);
  if (parsed.unreported) throw new Error(`the job's membership at the program's exit is unknown: ${parsed.unreported}`);
  return { exitCode: parsed.exitCode, program: parsed.program, left: parsed.left };
}
