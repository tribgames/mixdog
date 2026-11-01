import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { PS_RUNTIME } from './ps-runtime.ts';
import { PS_INPUT } from './ps-input.ts';
import { loadComputerSource } from './native-assets.ts';

test('session release leaves focus alone, and background input returns it only while the user did not move it', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 20000,
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
public sealed class ObservedInput { public bool Ready = true; public string Generation = "a"; public long Sequence = 7; }
public static class MixInputObservation {
  public static ObservedInput Current;
  public static ObservedInput Read() { return Current; }
  public static void BeginExpected(string monitor, long sequence) {
    if(!Current.Ready || monitor != Current.Generation) throw new Exception("input_observation_unavailable");
    if(sequence != Current.Sequence) throw new Exception("user_input_active");
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
  public static IntPtr Foreground() {
    if (StealAfterReads == 0) TrySteal(StealWith);
    if (StealAfterReads >= 0) StealAfterReads--;
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
    if (!Locked) return false;
    Unlocks++; Locked = false; HeldMs = LockClock.ElapsedMilliseconds; return true;
  }
  public static void InstallLock() { MixForegroundLock.Native = NativeLock; }
  public static bool RestoreForeground(IntPtr value) {
    FocusCalls++;
    if (Locked) return false;
    Current = value; return true;
  }
  public static void TrySteal(IntPtr value) {
    if (Locked && !StealPassesLock) { RefusedSteals++; return; }
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
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-TargetWindow'},$true)
. ([scriptblock]::Create($function.Extent.Text))
foreach($scenario in @('background_unchanged','background_user_input','background_observer_lost','background_other_window')) {
  [MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2
  [MixInputObservation]::Current=New-Object ObservedInput
  $null=Invoke-BackgroundWindow ([IntPtr]1) {
    # A snapshot is a value, not the live monitor object.
    [MixInputObservation]::Current=New-Object ObservedInput
    [MixWin32]::Current=[IntPtr]1
    switch($scenario) {
      'background_user_input' {[MixInputObservation]::Current.Sequence=8}
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
# A provider that blocks well past the hold: the lock still ends at its
# deadline, counted from acquisition, while the call is still running.
foreach($scenario in @('slow_operation','operation_throws')) {
  [MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]2; [MixWin32]::HeldMs=-1
  [MixWin32]::Locks=0; [MixWin32]::Unlocks=0; [MixWin32]::RefusedSteals=0
  $script:lockedAfterCall=$null
  $failure=''
  try {
    $null=Invoke-BackgroundWindow ([IntPtr]1) {
      Start-Sleep -Milliseconds 350
      $script:lockedAfterCall=[MixWin32]::Locked
      if ($scenario -eq 'operation_throws') { throw 'provider_failed: fixture' }
    }
  }
  catch { $failure=$_.Exception.Message }
  $results+=@{scenario=$scenario; restored=([MixWin32]::Current -eq [IntPtr]2); calls=[MixWin32]::FocusCalls;
    locks=[MixWin32]::Locks; unlocks=[MixWin32]::Unlocks; heldMs=[MixWin32]::HeldMs; locked=[MixWin32]::Locked;
    lockedAfterCall=$script:lockedAfterCall; failure=$failure}
}
[MixWin32]::LockGranted=$false
[MixWin32]::SelfActivating=$false
$script:state=@{Map=@{}; Generation=0; LastFocus=[IntPtr]1; HeldPointerTargets=@{'hwnd:0x5'=@(11,22)}}
[MixWin32]::Released.Clear()
$null=Release-SessionState
$results+=@{scenario='held_button'; restored=$false; calls=0; released=[MixWin32]::Released.Count;
  held=$script:state.HeldPointerTargets.Count}
[Console]::WriteLine(($results | ConvertTo-Json -Compress))
`
    );
    const result = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      { timeout: 15000, windowsHide: true, env: { ...process.env, FIXTURE_DIRECTORY: directory } }
    );
    const rows = JSON.parse(result.stdout.trim());
    assert.deepEqual(
      rows.map((row) => row.calls),
      [0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0]
    );
    assert.deepEqual(
      rows.map((row) => row.restored),
      [false, true, false, false, false, true, true, true, true, true, true, false]
    );
    // The hold is bounded from acquisition, not from the end of the call: a
    // 350 ms provider call sees the lock already gone, which ended once, near
    // its 250 ms deadline, on every path including a failing call.
    for (const row of [rows[9], rows[10]]) {
      assert.equal(row.locks, 1, JSON.stringify(row));
      assert.equal(row.unlocks, 1, JSON.stringify(row));
      assert.equal(row.locked, false, JSON.stringify(row));
      assert.equal(row.lockedAfterCall, false, JSON.stringify(row));
      assert.ok(row.heldMs >= 200 && row.heldMs <= 330, JSON.stringify(row));
    }
    assert.equal(rows[9].failure, '');
    assert.match(rows[10].failure, /provider_failed/);
    // The late self-activation is refused while locked: nothing to restore, and
    // the lock is released exactly once.
    assert.deepEqual(
      [rows[7].refused, rows[7].locks, rows[7].unlocks, rows[7].locked],
      [1, 1, 1, false]
    );
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
