import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { PS_RUNTIME } from './ps-runtime.ts';
import { PS_INPUT } from './ps-input.ts';

test('session release restores focus only while the original input observation still owns it', {
  skip: process.platform !== 'win32',
  timeout: 20000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-focus-ownership-'));
  try {
    await writeFile(join(directory, 'runtime.ps1'), PS_RUNTIME);
    await writeFile(join(directory, 'input.ps1'), PS_INPUT);
    await writeFile(
      join(directory, 'test.ps1'),
      `
$ErrorActionPreference = 'Stop'
Add-Type @'
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
  public static IntPtr Foreground() { return Current; }
  public static bool IsWindowHandle(IntPtr value) { return value != IntPtr.Zero; }
  public static bool Focus(IntPtr value) { FocusCalls++; Current = value; return true; }
  public static bool IsContainedSameProcess(IntPtr child, IntPtr parent) { return false; }
  public static bool IsOwnedBy(IntPtr child, IntPtr parent) { return false; }
  public static System.Collections.Generic.List<string> Released = new System.Collections.Generic.List<string>();
  public static IntPtr ParseWindowId(string value) { return new IntPtr(Convert.ToInt32(value.Substring(7), 16)); }
  public static string WindowId(IntPtr value) { return "hwnd:0x" + value.ToInt64().ToString("X"); }
  public static string BackgroundPointer(IntPtr top, int x, int y, string kind, string modifiers) {
    Released.Add(kind + "@" + x + "," + y); return WindowId(top);
  }
}
'@
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:FIXTURE_DIRECTORY 'runtime.ps1'),[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Release-SessionState'},$true)
. ([scriptblock]::Create($function.Extent.Text))
$inputAst=[Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:FIXTURE_DIRECTORY 'input.ps1'),[ref]$tokens,[ref]$errors)
$held=$inputAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Release-HeldPointerButtons'},$true)
. ([scriptblock]::Create($held.Extent.Text))
$heldKeys=$inputAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Release-HeldKeys'},$true)
. ([scriptblock]::Create($heldKeys.Extent.Text))
function Get-CurrentSession { return $script:state }
$results=@()
foreach($scenario in @('unchanged','user_input','observer_lost','different_window','new_monitor')) {
  $script:state=@{Map=@{}; Generation=0; LastFocus=[IntPtr]1; OriginalFocus=[IntPtr]2;
    OriginalFocusMonitor='a'; OriginalFocusSequence=7}
  [MixWin32]::FocusCalls=0; [MixWin32]::Current=[IntPtr]1
  [MixInputObservation]::Current=New-Object ObservedInput
  switch($scenario) {
    'user_input' {[MixInputObservation]::Current.Sequence=8}
    'observer_lost' {[MixInputObservation]::Current.Ready=$false}
    'different_window' {[MixWin32]::Current=[IntPtr]3}
    'new_monitor' {[MixInputObservation]::Current.Generation='b'}
  }
  $result=Release-SessionState
  $results+=@{scenario=$scenario; restored=$result.focus_restored; calls=[MixWin32]::FocusCalls}
}
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:FIXTURE_DIRECTORY 'input.ps1'),[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-BackgroundWindow'},$true)
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
$script:state=@{Map=@{}; Generation=0; LastFocus=[IntPtr]1; OriginalFocus=[IntPtr]::Zero;
  OriginalFocusMonitor=''; OriginalFocusSequence=$null; HeldPointerTargets=@{'hwnd:0x5'=@(11,22)}}
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
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0]
    );
    assert.deepEqual(
      rows.map((row) => row.restored),
      [true, false, false, false, false, true, false, false, false, false]
    );
    // Releasing the session also releases every button it held down.
    assert.equal(rows.at(-1).released, 1);
    assert.equal(rows.at(-1).held, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
