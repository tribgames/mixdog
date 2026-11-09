import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { PS_RUNTIME } from './ps-runtime.ts';
import { PS_INPUT } from './ps-input.ts';
import { loadComputerSource } from './native-assets.ts';

/** Runs the fixture script. Each time the stub reports that it is waiting for
 *  the delayed steal, the steal is released with one stdin line; the script's
 *  last stdout line is the JSON result. */
async function runWithStealTriggers(directory) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')], {
    timeout: 90000,
    windowsHide: true,
    env: { ...process.env, FIXTURE_DIRECTORY: directory },
  });
  const output = [];
  const markers = [];
  let partial = '';
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    const lines = (partial + chunk).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) {
      if (line.startsWith('awaiting-')) markers.push(line);
      else output.push(line);
      if (line === 'awaiting-steal') child.stdin.write('steal\n');
    }
  });
  const { code, signal } = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  // A stub that never got the signal it waits for ends here by the spawn
  // timeout; say which wait it was in rather than only that it failed.
  const report = () =>
    `stub exit code ${code}, signal ${signal}; waiting markers seen: [${markers.join(', ')}]; ` +
    `last marker: ${markers.at(-1) ?? 'none'}; stdout tail: ${JSON.stringify([...output, partial].slice(-5))}; stderr: ${stderr}`;
  assert.equal(code, 0, report());
  try {
    return JSON.parse([...output, partial].join('\n').trim());
  } catch (error) {
    throw new Error(`${error.message}; ${report()}`);
  }
}

test('session release leaves focus alone, and background input returns it only while the user did not move it', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 120000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-focus-ownership-'));
  try {
    await writeFile(join(directory, 'runtime.ps1'), PS_RUNTIME);
    await writeFile(join(directory, 'input.ps1'), PS_INPUT);
    await writeFile(join(directory, 'lock.cs'), loadComputerSource('MixForegroundLock.cs'));
    await writeFile(
      join(directory, 'test.ps1'),
      `
$ErrorActionPreference = 'Stop'
$stub = @'
using System;
public sealed class ObservedInput {
  public bool Ready = true; public string Generation = "a"; public long Sequence = 7;
  // The last foreign input that could reach the scoped target or move the pointer.
  public long Relevant = 7;
}
public static class MixInputObservation {
  public static ObservedInput Current;
  public static long ScopedTarget;
  public static ObservedInput Read() { return Current; }
  public static void BeginRestore(string monitor, long sequence, IntPtr target) {
    ScopedTarget = target.ToInt64();
    if(!Current.Ready || monitor != Current.Generation) throw new Exception("input_observation_unavailable");
    if(sequence > Current.Sequence || Current.Relevant > sequence) throw new Exception("user_input_active");
  }
  public static void AssertContinue() {}
  public static void End() {}
}
public static class MixWin32 {
  public static int FocusCalls;
  public static IntPtr Current;
  // Reads left before a delayed steal lands; negative means none is pending.
  public static int StealAfterReads = -1;
  public static IntPtr StealWith;
  // The stub's own account of what happened and in which order. It is the only
  // thing the assertions order events by; nothing here waits while holding it,
  // and nothing in the stub ever waits inside a call the lock code makes under
  // its own synchronization.
  static readonly object eventSync = new object();
  static readonly System.Collections.Generic.List<string> events = new System.Collections.Generic.List<string>();
  public static void Log(string name) { lock (eventSync) { events.Add(name); } }
  public static string TakeEvents() {
    lock (eventSync) { string text = string.Join(",", events.ToArray()); events.Clear(); return text; }
  }
  static void Marker(string name) { Console.Out.WriteLine(name); Console.Out.Flush(); }
  // A steal the test triggers. ArmSteal is called inside the operation; the
  // first foreground read after that reports "awaiting-steal" on stdout and
  // blocks until the test answers with a line on stdin, then the steal lands on
  // that read. That read is on the calling thread outside the lock code's
  // synchronization, so the hold's timer can end the lock before or after the
  // steal lands without either waiting on the other.
  public static bool StealArmed;
  public static void ArmSteal() { StealArmed = true; Log("armed"); }
  static void AwaitSteal() {
    StealArmed = false;
    Marker("awaiting-steal");
    Console.In.ReadLine();
    TrySteal(StealWith);
  }
  public static IntPtr Foreground() {
    if (StealAfterReads == 0) TrySteal(StealWith);
    if (StealAfterReads >= 0) StealAfterReads--;
    if (StealArmed) AwaitSteal();
    return Current;
  }
  // Window 9 is a packaged app's content window inside frame 1.
  public static bool IsWithinTopLevel(IntPtr candidate, IntPtr top) {
    return candidate == top || (candidate == new IntPtr(9) && top == new IntPtr(1));
  }
  public static bool IsWindowHandle(IntPtr value) { return value != IntPtr.Zero; }
  public static bool Focus(IntPtr value) { FocusCalls++; Current = value; return true; }
  // The foreground lock refuses every SetForegroundWindow, the restore included.
  public static bool LockGranted, Locked;
  public static int Locks, Unlocks, RefusedSteals;
  // How long the lock stayed on, measured by the native calls themselves.
  public static System.Diagnostics.Stopwatch LockClock = new System.Diagnostics.Stopwatch();
  public static long HeldMs = -1;
  // A system activation (the user's click) passes the lock.
  public static bool StealPassesLock;
  // Stands in for LockSetForegroundWindow under the real hold logic.
  public static bool NativeLock(uint code) {
    if (code == 1) {
      if (!LockGranted || Locked) return false;
      Locks++; Locked = true; LockClock.Restart(); return true;
    }
    Log("unlock");
    if (!Locked) return false;
    Unlocks++; Locked = false; HeldMs = LockClock.ElapsedMilliseconds; Unlocked.Set(); return true;
  }
  // Set once an unlock has really ended the lock. A call that blocks on it
  // finishes only after the lock's own hold ended, whatever the timing.
  public static readonly System.Threading.ManualResetEvent Unlocked = new System.Threading.ManualResetEvent(false);
  public static void AwaitUnlock() { Marker("awaiting-unlock"); Unlocked.WaitOne(); }
  public static void InstallLock() { MixForegroundLock.Native = NativeLock; }
  public static void InstallHost(IMixLeaseChannel host) { MixForegroundLock.Host = host; }
  // Steals the target makes again after a restore, and a restore Windows refuses.
  public static int Resteals; public static bool RestoreRefuses;
  public static bool RestoreForeground(IntPtr value) {
    FocusCalls++;
    if (Locked || RestoreRefuses) return false;
    Current = value;
    if (Resteals > 0) { Resteals--; Current = new IntPtr(1); }
    return true;
  }
  // A steal that gets past the lock and lifts it, as the live run saw: the
  // worker's unlocks then answer false.
  public static bool StealLifts;
  public static void TrySteal(IntPtr value) {
    if (Locked && !StealPassesLock) { RefusedSteals++; Log("steal:refused"); return; }
    Log("steal:landed");
    if (StealLifts) Locked = false;
    Current = value;
  }
  public static bool IsContainedSameProcess(IntPtr child, IntPtr parent) { return false; }
  public static bool IsOwnedBy(IntPtr child, IntPtr parent) { return false; }
  public static bool SelfActivating;
  public static int Disables;
  public static int Restores;
  public static bool SelfActivatesOnSemanticInput(IntPtr value) { return SelfActivating; }
  public static bool IsWebContentHost(IntPtr value) { return false; }
  public static bool SetWindowEnabled(IntPtr value, bool enabled) {
    if (enabled) Restores++; else Disables++;
    return true;
  }
  public static int Holds;
  public static int Releases;
  public static IntPtr HoldInactive(IntPtr value) { Holds++; return value; }
  public static void ReleaseInactive(IntPtr value) { if (value != IntPtr.Zero) Releases++; }
  public static System.Collections.Generic.List<string> Released = new System.Collections.Generic.List<string>();
  public static IntPtr ParseWindowId(string value) { return new IntPtr(Convert.ToInt32(value.Substring(7), 16)); }
  public static string WindowId(IntPtr value) { return "hwnd:0x" + value.ToInt64().ToString("X"); }
  public static string BackgroundPointer(IntPtr top, int x, int y, string kind, string modifiers) {
    Released.Add(kind + "@" + x + "," + y); return WindowId(top);
  }
  public static int RetryPendingReleases() { return 0; }
}
// Stands in for the bridge host's lease: granted or refused, and a release
// that answers with the given outcome (null: no answer in time) after
// whatever the user does while the worker waits for it.
public sealed class FakeHost : IMixLeaseChannel {
  public bool Grants;
  public string ReleaseOutcome = "released";
  public bool Answers = true;
  public Action OnRelease;
  public System.Collections.Generic.List<string> Calls = new System.Collections.Generic.List<string>();
  public MixLeaseAnswer Acquire(long action, long seq, int holdMs, double answerBy) {
    Calls.Add("acquire");
    var answer = new MixLeaseAnswer();
    answer.Answer = Grants ? "locked" : "refused";
    answer.Lease = Grants ? 1 : 0;
    answer.DeadlineAt = MixLeaseClock.Now() + holdMs;
    if (Grants) MixWin32.Locked = true;
    return answer;
  }
  public string Release(long action, long seq, long lease) {
    Calls.Add("release");
    MixWin32.Locked = false;
    if (OnRelease != null) OnRelease();
    return Answers ? ReleaseOutcome : null;
  }
}
'@
Add-Type -TypeDefinition ($stub + "\`n" + [IO.File]::ReadAllText((Join-Path $env:FIXTURE_DIRECTORY 'lock.cs')))
[MixWin32]::InstallLock()
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:FIXTURE_DIRECTORY 'runtime.ps1'),[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Release-SessionState'},$true)
. ([scriptblock]::Create($function.Extent.Text))
$heldInput=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Release-HeldInput'},$true)
. ([scriptblock]::Create($heldInput.Extent.Text))
$inputAst=[Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:FIXTURE_DIRECTORY 'input.ps1'),[ref]$tokens,[ref]$errors)
$held=$inputAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Release-HeldPointerButtons'},$true)
. ([scriptblock]::Create($held.Extent.Text))
$heldKeys=$inputAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Release-HeldKeys'},$true)
. ([scriptblock]::Create($heldKeys.Extent.Text))
$cursorTheme=$inputAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Release-CursorTheme'},$true)
. ([scriptblock]::Create($cursorTheme.Extent.Text))
function Get-CurrentSession { return $script:state }
$results=@()
# The host restores focus from the session's restore point; a release never
# moves it, even when nothing changed since the session's first input.
$script:state=@{Map=@{}; Generation=0; LastFocus=[IntPtr]1}
[MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]1
[MixInputObservation]::Current=New-Object ObservedInput
$null=Release-SessionState
$results+=@{scenario='release'; restored=([MixWin32]::Current -ne [IntPtr]1); calls=[MixWin32]::FocusCalls}
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:FIXTURE_DIRECTORY 'input.ps1'),[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-BackgroundWindow'},$true)
. ([scriptblock]::Create($function.Extent.Text))
foreach($name in @('Test-TargetWindow','Test-RestoreBaseline','Restore-UserForeground')) {
  $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  . ([scriptblock]::Create($function.Extent.Text))
}
# The request in flight, which a host lease names.
$script:CurrentRequest=[pscustomobject]@{ id = 5 }
foreach($scenario in @('background_unchanged','background_user_input','background_observer_lost','background_other_window')) {
  [MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2
  [MixInputObservation]::Current=New-Object ObservedInput
  $null=Invoke-BackgroundWindow ([IntPtr]1) {
    # A snapshot is a value, not the live monitor object.
    [MixInputObservation]::Current=New-Object ObservedInput
    [MixWin32]::Current=[IntPtr]1
    switch($scenario) {
      'background_user_input' {[MixInputObservation]::Current.Sequence=8; [MixInputObservation]::Current.Relevant=8}
      'background_observer_lost' {[MixInputObservation]::Current.Ready=$false}
      'background_other_window' {[MixWin32]::Current=[IntPtr]3}
    }
  }
  $results+=@{scenario=$scenario; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls}
}
[MixWin32]::SelfActivating=$true
[MixWin32]::FocusCalls=0; [MixWin32]::Disables=0; [MixWin32]::Restores=0
[MixWin32]::Holds=0; [MixWin32]::Releases=0
[MixWin32]::Current=[IntPtr]2
$null=Invoke-BackgroundWindow ([IntPtr]1) { [MixWin32]::Current=[IntPtr]1 }
$results+=@{scenario='shielded_self_activating'; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
  disables=[MixWin32]::Disables; restores=[MixWin32]::Restores; holds=[MixWin32]::Holds; releases=[MixWin32]::Releases}
# The content window of a packaged app takes the foreground just after the
# call returns: past the immediate check, inside the short watch.
[MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2
[MixWin32]::StealWith=[IntPtr]9; [MixWin32]::StealAfterReads=2
$null=Invoke-BackgroundWindow ([IntPtr]1) { }
$results+=@{scenario='delayed_content_steal'; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls}
# A Chromium host activates itself well after the call returned, past the
# 100 ms an unlocked watch lasts: the lock is still held and refuses it.
[MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2; [MixWin32]::LockGranted=$true
[MixWin32]::Locks=0; [MixWin32]::Unlocks=0; [MixWin32]::RefusedSteals=0
[MixWin32]::StealWith=[IntPtr]1; [MixWin32]::StealAfterReads=10
$null=Invoke-BackgroundWindow ([IntPtr]1) { }
$results+=@{scenario='locked_late_steal'; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
  locks=[MixWin32]::Locks; unlocks=[MixWin32]::Unlocks; refused=[MixWin32]::RefusedSteals; locked=[MixWin32]::Locked}
# An activation the lock does not cover is undone, and the lock comes off first
# so it does not refuse the restore as well.
[MixWin32]::StealAfterReads=-1
[MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2; [MixWin32]::StealPassesLock=$true
[MixWin32]::Locks=0; [MixWin32]::Unlocks=0; [MixWin32]::RefusedSteals=0
$null=Invoke-BackgroundWindow ([IntPtr]1) { [MixWin32]::TrySteal([IntPtr]1) }
$results+=@{scenario='steal_past_lock'; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
  locks=[MixWin32]::Locks; unlocks=[MixWin32]::Unlocks; refused=[MixWin32]::RefusedSteals; locked=[MixWin32]::Locked}
[MixWin32]::StealPassesLock=$false
# A provider that blocks past the hold: the lock still ends at its deadline,
# counted from acquisition, while the call is still running. The call here
# blocks until an unlock has happened, so only the hold's own timer can end it.
foreach($scenario in @('slow_operation','operation_throws')) {
  [MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2; [MixWin32]::HeldMs=-1
  [MixWin32]::Locks=0; [MixWin32]::Unlocks=0; [MixWin32]::RefusedSteals=0
  $script:lockedAfterCall=$null
  $failure=''
  [void][MixWin32]::Unlocked.Reset()
  try {
    $null=Invoke-BackgroundWindow ([IntPtr]1) {
      [MixWin32]::AwaitUnlock()
      $script:lockedAfterCall=[MixWin32]::Locked
      if ($scenario -eq 'operation_throws') { throw 'provider_failed: fixture' }
    }
  }
  catch { $failure=$_.Exception.Message }
  $results+=@{scenario=$scenario; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
    locks=[MixWin32]::Locks; unlocks=[MixWin32]::Unlocks; heldMs=[MixWin32]::HeldMs; locked=[MixWin32]::Locked;
    lockedAfterCall=$script:lockedAfterCall; failure=$failure}
}
# Delivered input the lock did not cover is not reported as protected from the
# target taking the foreground; a refusal delivered nothing to report.
foreach($scenario in @('lock_held','lock_unavailable','lock_unavailable_refused')) {
  [MixWin32]::LockGranted = ($scenario -eq 'lock_held')
  [MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2
  $reply=Invoke-BackgroundWindow ([IntPtr]1) {
    @{ delivery_accepted=($scenario -ne 'lock_unavailable_refused'); delivery='background'; text='invoked' }
  }
  $results+=@{scenario=$scenario; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
    protection=[string]$reply.activation_protection; text=$reply.text;
    foregroundLockHolder=[string]$reply.foreground_lock.holder; hostAnswer=[string]$reply.foreground_lock.host_answer}
}
[MixWin32]::LockGranted=$false
[MixWin32]::SelfActivating=$false
# Keys the user typed into their own window do not stop the restore: the
# window they were typing into is the one they want in front.
[MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2
[MixInputObservation]::Current=New-Object ObservedInput
$null=Invoke-BackgroundWindow ([IntPtr]1) {
  [MixInputObservation]::Current=New-Object ObservedInput
  [MixInputObservation]::Current.Sequence=9
  [MixWin32]::Current=[IntPtr]1
}
$results+=@{scenario='background_own_window_typing'; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
  scopedTarget=[MixInputObservation]::ScopedTarget}
# The worker is refused the lock; the bridge host takes it instead and the
# late self-activation is refused all the same. A host that refuses too leaves
# the delivery reported as unprotected.
$fake=New-Object FakeHost
[MixWin32]::InstallHost($fake)
foreach($scenario in @('host_lock','host_refused')) {
  $fake.Grants = ($scenario -eq 'host_lock')
  $fake.Calls.Clear()
  [MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2; [MixWin32]::RefusedSteals=0
  [MixWin32]::StealWith=[IntPtr]1
  # The target takes the foreground a few reads after the call, inside the 100 ms hold.
  [MixWin32]::StealAfterReads = $(if ($scenario -eq 'host_lock') { 3 } else { -1 })
  $reply=Invoke-BackgroundWindow ([IntPtr]1) {
    @{ delivery_accepted=$true; delivery='background'; text='invoked' }
  }
  [MixWin32]::StealAfterReads=-1
  $results+=@{scenario=$scenario; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
    refused=[MixWin32]::RefusedSteals; hostCalls=@($fake.Calls); locked=[MixWin32]::Locked;
    protection=[string]$reply.activation_protection; holder=[string]$reply.foreground_lock.holder;
    hostAnswer=[string]$reply.foreground_lock.host_answer; workerError=[string]$reply.foreground_lock.worker_error}
}
# An activation that got past the host's lease: the lease is released first,
# and the one restore runs only if, after that wait, the release is confirmed,
# no user input superseded the observation and the target is still in front.
[MixWin32]::StealPassesLock=$true
foreach($scenario in @('input_during_release','third_window_during_release','release_unknown','release_no_ack','release_failed')) {
  $fake.Grants=$true; $fake.Calls.Clear(); $fake.ReleaseOutcome='released'; $fake.Answers=$true; $fake.OnRelease=$null
  switch($scenario) {
    # A fresh snapshot, as the observer returns: the original one is a value.
    'input_during_release' { $fake.OnRelease=[Action]{
      $later=New-Object ObservedInput; $later.Sequence=8; $later.Relevant=8; [MixInputObservation]::Current=$later } }
    'third_window_during_release' { $fake.OnRelease=[Action]{ [MixWin32]::Current=[IntPtr]3 } }
    'release_unknown' { $fake.ReleaseOutcome='unknown' }
    'release_no_ack' { $fake.Answers=$false }
    'release_failed' { $fake.ReleaseOutcome='failed' }
  }
  [MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2
  [MixInputObservation]::Current=New-Object ObservedInput
  $reply=Invoke-BackgroundWindow ([IntPtr]1) {
    [MixWin32]::TrySteal([IntPtr]1)
    @{ delivery_accepted=$true; delivery='background'; text='invoked' }
  }
  $results+=@{scenario=$scenario; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
    hostCalls=@($fake.Calls); restore=[string]$reply.foreground_lock.restore; release=[string]$reply.foreground_lock.release}
}
[MixWin32]::StealPassesLock=$false
$fake.OnRelease=$null; $fake.Answers=$true
# Exactly one restore attempt: neither a target that takes the foreground again
# right after it nor a restore Windows refuses gets a second one.
foreach($scenario in @('restolen','restore_refused')) {
  $fake.Grants=$false
  [MixWin32]::Resteals = $(if ($scenario -eq 'restolen') { 1 } else { 0 })
  [MixWin32]::RestoreRefuses = ($scenario -eq 'restore_refused')
  [MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2
  [MixInputObservation]::Current=New-Object ObservedInput
  $reply=Invoke-BackgroundWindow ([IntPtr]1) {
    [MixWin32]::Current=[IntPtr]1
    @{ delivery_accepted=$true; delivery='background'; text='invoked' }
  }
  $results+=@{scenario=$scenario; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
    restore=[string]$reply.foreground_lock.restore}
}
[MixWin32]::Resteals=0; [MixWin32]::RestoreRefuses=$false
# A self-activation that lands after the call returned, while the hold is still
# in force: the hold refuses it, and without a lock the watch still sees it, so
# it gets the one restore. A steal that gets past the lock and lifts it (the
# worker's unlocks then answer false: unknown) is restored too. The test releases
# the steal once the watch is reading the foreground.
$fake.Grants=$false
# A self-activating target, so the hold, and the watch, last 250 ms.
[MixWin32]::SelfActivating=$true
foreach($scenario in @('locked_delayed_steal','unlocked_delayed_steal','own_lock_lifted')) {
  [MixWin32]::LockGranted = ($scenario -ne 'unlocked_delayed_steal')
  [MixWin32]::StealPassesLock = ($scenario -eq 'own_lock_lifted')
  [MixWin32]::StealLifts = ($scenario -eq 'own_lock_lifted')
  [MixWin32]::StealWith=[IntPtr]1
  [MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2; [MixWin32]::HeldMs=-1
  [MixWin32]::Locks=0; [MixWin32]::Unlocks=0; [MixWin32]::RefusedSteals=0
  [MixInputObservation]::Current=New-Object ObservedInput
  [void][MixWin32]::TakeEvents()
  $reply=Invoke-BackgroundWindow ([IntPtr]1) {
    [MixWin32]::ArmSteal()
    [MixWin32]::Log('op_end')
    @{ delivery_accepted=$true; delivery='background'; text='invoked' }
  }
  $results+=@{scenario=$scenario; delayed=$true; events=[MixWin32]::TakeEvents(); releasedBy=[string]$reply.foreground_lock.released_by;
    restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
    refused=[MixWin32]::RefusedSteals; locks=[MixWin32]::Locks; unlocks=[MixWin32]::Unlocks;
    locked=[MixWin32]::Locked; restore=[string]$reply.foreground_lock.restore; release=[string]$reply.foreground_lock.release;
    unlockErrors=@($reply.foreground_lock.unlock_errors).Count; stealSeen=($null -ne $reply.foreground_lock.steal_seen_at)}
}
# The hold's timer ends the lock before the operation arms the steal: the order
# the loop above can meet under load. Nothing may wait on anything that is
# behind the lock code's own synchronization, so this must complete, with the
# steal landing on an unlocked foreground and being restored.
[MixWin32]::LockGranted=$true; [MixWin32]::StealPassesLock=$false; [MixWin32]::StealLifts=$false
[MixWin32]::StealWith=[IntPtr]1
[MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2
[MixWin32]::Locks=0; [MixWin32]::Unlocks=0; [MixWin32]::RefusedSteals=0
[MixInputObservation]::Current=New-Object ObservedInput
[void][MixWin32]::Unlocked.Reset()
[void][MixWin32]::TakeEvents()
$reply=Invoke-BackgroundWindow ([IntPtr]1) {
  [MixWin32]::AwaitUnlock()
  [MixWin32]::ArmSteal()
  [MixWin32]::Log('op_end')
  @{ delivery_accepted=$true; delivery='background'; text='invoked' }
}
$results+=@{scenario='expire_before_steal'; delayed=$true; events=[MixWin32]::TakeEvents(); releasedBy=[string]$reply.foreground_lock.released_by;
  restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
  refused=[MixWin32]::RefusedSteals; locks=[MixWin32]::Locks; unlocks=[MixWin32]::Unlocks;
  locked=[MixWin32]::Locked; restore=[string]$reply.foreground_lock.restore; release=[string]$reply.foreground_lock.release;
  unlockErrors=@($reply.foreground_lock.unlock_errors).Count; stealSeen=($null -ne $reply.foreground_lock.steal_seen_at)}
[MixWin32]::LockGranted=$false; [MixWin32]::StealPassesLock=$false; [MixWin32]::StealLifts=$false
[MixWin32]::SelfActivating=$false
$script:state=@{Map=@{}; Generation=0; LastFocus=[IntPtr]1; HeldPointerTargets=@{'hwnd:0x5'=@(11,22)}}
[MixWin32]::Released.Clear()
$null=Release-SessionState
$results+=@{scenario='held_button'; restored=$false; calls=0; released=[MixWin32]::Released.Count;
  held=$script:state.HeldPointerTargets.Count}
[Console]::WriteLine(($results | ConvertTo-Json -Compress))
`
    );
    const everything = await runWithStealTriggers(directory);
    const rows = everything.filter((row) => !row.delayed);
    const delayed = everything.filter((row) => row.delayed);
    assert.deepEqual(
      rows.map((row) => row.calls),
      [0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0],
      JSON.stringify(rows.map((row) => [row.scenario, row.calls, row.restore]))
    );
    assert.deepEqual(
      rows.map((row) => row.restored),
      [
        false,
        true,
        false,
        false,
        false,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        false,
        false,
        true,
        false,
        false,
        false,
        false,
        false,
      ]
    );
    // Released first, then rechecked after that wait: input the user gave, or a
    // third window they picked, while it ran cancels the restore, and so does a
    // release that failed or that the host never answered, since it may still
    // hold its lease. An unknown end (a false unlock) holds no lock, so it restores.
    assert.deepEqual(
      rows.slice(17, 22).map((row) => [row.scenario, row.hostCalls, row.release, row.restore]),
      [
        ['input_during_release', ['acquire', 'release'], 'released', 'skipped:user_input_active'],
        ['third_window_during_release', ['acquire', 'release'], 'released', 'skipped:foreground_moved'],
        ['release_unknown', ['acquire', 'release'], 'unknown', 'restored'],
        ['release_no_ack', ['acquire', 'release'], 'no_ack', 'skipped:release_no_ack'],
        ['release_failed', ['acquire', 'release'], 'failed', 'skipped:release_failed'],
      ]
    );
    // One attempt, whatever followed it.
    assert.deepEqual(
      rows.slice(22, 24).map((row) => [row.scenario, row.calls, row.restore]),
      [
        ['restolen', 1, 'restored'],
        ['restore_refused', 1, 'refused'],
      ]
    );
    // Refused the lock itself, the worker gets it through the bridge host: the
    // late self-activation is refused, the host's hold is released once, and
    // the reply names the holder. A host that refuses too is reported.
    const [hostLock, hostRefused] = [rows[15], rows[16]];
    assert.deepEqual(
      [hostLock.scenario, hostLock.refused, hostLock.hostCalls, hostLock.locked, hostLock.protection],
      ['host_lock', 1, ['acquire', 'release'], false, '']
    );
    assert.deepEqual([hostLock.holder, hostLock.hostAnswer], ['host', 'locked']);
    assert.notEqual(hostLock.workerError, '');
    assert.deepEqual(
      [hostRefused.scenario, hostRefused.hostCalls, hostRefused.protection, hostRefused.holder, hostRefused.hostAnswer],
      ['host_refused', ['acquire'], 'unavailable', 'none', 'refused']
    );
    // Without a host channel the facts say so.
    assert.equal(rows[12].foregroundLockHolder, 'none');
    assert.equal(rows[12].hostAnswer, 'not_offered');
    // The restore asks only about input that could reach the target or move
    // the pointer, so typing in the user's own window still gets it back.
    assert.deepEqual([rows[14].scenario, rows[14].scopedTarget], ['background_own_window_typing', 1]);
    assert.deepEqual(
      rows.slice(11, 14).map((row) => [row.scenario, row.protection]),
      [
        ['lock_held', ''],
        ['lock_unavailable', 'unavailable'],
        ['lock_unavailable_refused', ''],
      ]
    );
    assert.match(rows[12].text, /^invoked; the foreground lock was unavailable/);
    // The hold is bounded from acquisition, not from the end of the call: the
    // provider call blocks until an unlock has happened, so its seeing the lock
    // already gone means the hold's own timer ended it, once, while the call was
    // still running, on every path including a failing call.
    for (const row of [rows[9], rows[10]]) {
      assert.equal(row.locks, 1, JSON.stringify(row));
      assert.equal(row.unlocks, 1, JSON.stringify(row));
      assert.equal(row.locked, false, JSON.stringify(row));
      assert.equal(row.lockedAfterCall, false, JSON.stringify(row));
    }
    // The hold's window: a steal after the call returned is refused by the hold,
    // which then ends once at its deadline; without the lock the watch still
    // sees it and restores once; a steal that lifted the worker's own lock
    // leaves an unknown release (three false unlocks, each error recorded),
    // which no longer stops the restore.
    // Which comes first, the steal or the hold's timer, depends on how long the
    // test takes to answer the stub, so each row is read against the order the
    // stub itself recorded, never against time.
    const [lockedLate, unlockedLate, lifted, expireFirst] = delayed;
    const order = (row) => row.events.split(',');
    const happened = (row, name) => order(row).includes(name);
    const unlockFirst = (row) => {
      const events = order(row);
      return events.indexOf('unlock') >= 0 && events.indexOf('unlock') < events.findIndex((e) => e.startsWith('steal:'));
    };
    // An unlock that comes before the operation ended can only be the hold's own
    // timer; any other early unlock is a release requested too soon.
    for (const row of delayed) {
      const events = order(row);
      const unlockAt = events.indexOf('unlock');
      if (unlockAt >= 0 && unlockAt < events.indexOf('op_end')) {
        assert.equal(row.releasedBy, 'deadline', `${row.scenario} unlocked early: ${row.events}`);
      }
      assert.equal(happened(row, 'steal:refused') + happened(row, 'steal:landed'), 1, `${row.scenario}: ${row.events}`);
    }
    assert.deepEqual([lockedLate.scenario, lockedLate.restored, lockedLate.locks, lockedLate.unlocks, lockedLate.locked],
      ['locked_delayed_steal', true, 1, 1, false]);
    // No Release ended this hold: nothing restored, so the lock ran to its own timer.
    assert.equal(lockedLate.releasedBy, 'deadline', lockedLate.events);
    if (happened(lockedLate, 'steal:refused')) {
      // The hold was in force when the steal came: refused, and never restored.
      assert.deepEqual([lockedLate.refused, lockedLate.calls, unlockFirst(lockedLate)], [1, 0, false], lockedLate.events);
    } else {
      // The timer had already ended it: the watch saw the steal and restored once.
      assert.deepEqual([lockedLate.refused, lockedLate.calls, unlockFirst(lockedLate)], [0, 1, true], lockedLate.events);
    }
    // Never locked, so the watch alone catches and restores it, and nothing unlocks.
    assert.deepEqual(
      [unlockedLate.scenario, unlockedLate.locks, unlockedLate.calls, unlockedLate.restored, unlockedLate.restore, unlockedLate.stealSeen, unlockedLate.events],
      ['unlocked_delayed_steal', 0, 1, true, 'restored', true, 'armed,op_end,steal:landed']
    );
    assert.equal(lifted.scenario, 'own_lock_lifted');
    assert.deepEqual([lifted.calls, lifted.restore, lifted.restored], [1, 'restored', true], lifted.events);
    if (unlockFirst(lifted)) {
      // The timer ended the lock first; the steal then met no lock at all.
      assert.deepEqual([lifted.locks, lifted.unlocks, lifted.release, lifted.unlockErrors, lifted.releasedBy], [1, 1, 'released', 1, 'deadline'], lifted.events);
    } else {
      // A steal that lifted the worker's own lock leaves an unknown release (three
      // false unlocks, each error recorded), answering the steal it just saw.
      assert.deepEqual([lifted.locks, lifted.unlocks, lifted.release, lifted.unlockErrors], [1, 0, 'unknown', 3], lifted.events);
      assert.ok(order(lifted).indexOf('unlock') > order(lifted).indexOf('steal:landed'), lifted.events);
    }
    // Forced: the timer ends the lock before the steal is even armed. It must
    // complete, with the one unlock first, the steal landing unlocked and restored.
    assert.deepEqual(
      [expireFirst.scenario, expireFirst.events.split(',')[0], expireFirst.releasedBy, expireFirst.release, expireFirst.locks, expireFirst.unlocks, expireFirst.refused, expireFirst.calls, expireFirst.restore, expireFirst.restored],
      ['expire_before_steal', 'unlock', 'deadline', 'released', 1, 1, 0, 1, 'restored', true],
      expireFirst.events
    );
    assert.ok(unlockFirst(expireFirst) && order(expireFirst).indexOf('armed') > order(expireFirst).indexOf('unlock'), expireFirst.events);
    assert.equal(rows[9].failure, '');
    assert.match(rows[10].failure, /provider_failed/);
    // The late self-activation is refused while locked: nothing to restore, and
    // the lock is released exactly once.
    assert.deepEqual([rows[7].refused, rows[7].locks, rows[7].unlocks, rows[7].locked], [1, 1, 1, false]);
    assert.equal(rows[8].refused, 0);
    assert.equal(rows[8].locked, false);
    // A window that would activate itself is disabled for the call and restored
    // to exactly the state it had, so the steal never reaches the user's screen.
    assert.equal(rows[5].disables, 1);
    assert.equal(rows[5].restores, 1);
    // The target is held non-activatable for the call and released exactly once.
    assert.equal(rows[5].holds, 1);
    assert.equal(rows[5].releases, 1);
    // Releasing the session also releases every button it held down.
    assert.equal(rows.at(-1).released, 1);
    assert.equal(rows.at(-1).held, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the end of a turn lets go of held keys and buttons and keeps the session refs', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 20000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-turn-end-release-'));
  try {
    await writeFile(join(directory, 'runtime.ps1'), PS_RUNTIME);
    await writeFile(join(directory, 'input.ps1'), PS_INPUT);
    await writeFile(
      join(directory, 'test.ps1'),
      `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
public static class MixWin32 {
  public static List<string> Released = new List<string>();
  public static IntPtr ParseWindowId(string value) { return new IntPtr(Convert.ToInt32(value.Substring(7), 16)); }
  public static string BackgroundPointer(IntPtr top, int x, int y, string kind, string modifiers) {
    Released.Add(kind + "@" + x + "," + y); return "";
  }
  public static int RetryPendingReleases() { return 0; }
}
public static class MixTaggedKeys {
  public static List<string> Lifted = new List<string>();
  public static void Hold(string value, bool down) { if (!down) Lifted.Add(value); }
}
'@
$tokens=$null; $errors=$null
$runtimeAst=[Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:FIXTURE_DIRECTORY 'runtime.ps1'),[ref]$tokens,[ref]$errors)
$release=$runtimeAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Release-HeldInput'},$true)
. ([scriptblock]::Create($release.Extent.Text))
$invalidate=$runtimeAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invalidate-RefsForRequest'},$true)
. ([scriptblock]::Create($invalidate.Extent.Text))
$inputAst=[Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:FIXTURE_DIRECTORY 'input.ps1'),[ref]$tokens,[ref]$errors)
$held=$inputAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Release-HeldPointerButtons'},$true)
. ([scriptblock]::Create($held.Extent.Text))
$heldKeys=$inputAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Release-HeldKeys'},$true)
. ([scriptblock]::Create($heldKeys.Extent.Text))
function Get-CurrentSession { return $script:state }
$script:state=@{Map=@{'s1:e0'='edit'}; Generation=3; HeldKeys=@{'shift'=$true}; HeldPointerTargets=@{'hwnd:0x5'=@(11,22)}}
$reply=Release-HeldInput $script:state
# The end of a turn sends exactly these two requests to the warm worker.
foreach($action in @('release_held_input','restore_input_state')) {
  Invalidate-RefsForRequest ([pscustomobject]@{ action = $action })
}
$kept=$script:state.Map.Count
Invalidate-RefsForRequest ([pscustomobject]@{ action = 'key' })
[Console]::WriteLine((@{
  text=$reply.text; keys=@([MixTaggedKeys]::Lifted); buttons=@([MixWin32]::Released)
  heldKeys=$script:state.HeldKeys.Count; heldButtons=$script:state.HeldPointerTargets.Count
  kept=$kept; afterInput=$script:state.Map.Count
} | ConvertTo-Json -Compress))
`
    );
    const result = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      { timeout: 15000, windowsHide: true, env: { ...process.env, FIXTURE_DIRECTORY: directory } }
    );
    const state = JSON.parse(result.stdout.trim());
    assert.deepEqual(state.keys, ['shift'], 'a key the agent left down goes up');
    assert.deepEqual(state.buttons, ['release@11,22'], 'so does a button it left down');
    assert.equal(state.heldKeys, 0);
    assert.equal(state.heldButtons, 0);
    assert.equal(state.kept, 1, 'the refs stay for a follow-up turn');
    assert.equal(state.afterInput, 0, 'new input still retires them');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
