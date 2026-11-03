import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { PS_INPUT } from './ps-input.ts';
import { loadComputerSource } from './native-assets.ts';

async function runPowerShell(prefix, files, script) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text);
    await writeFile(join(directory, 'test.ps1'), script);
    const result = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      { timeout: 60000, windowsHide: true, env: { ...process.env, FIXTURE_DIRECTORY: directory } }
    );
    return JSON.parse(result.stdout.trim());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// The real MixWin32.Focus over a fake user32: this worker may set the
// foreground only while attached to the input of the thread that has it, and
// an activation can land a few reads after the call that queued it.
const FAKE_USER32 = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MixInputObservation { public static void AssertContinue() {} }
public partial class MixWin32 {
  public struct POINT { public int x, y; }
  public static List<string> Calls = new List<string>();
  public static IntPtr Fg;
  public static int LandAfterReads;
  static IntPtr pending;
  static int landIn;
  static uint attachedTo;
  static uint ThreadOf(IntPtr h) { return (uint)h.ToInt64() + 100; }
  static IntPtr GetForegroundWindow() {
    if (pending != IntPtr.Zero && --landIn <= 0) { Fg = pending; pending = IntPtr.Zero; }
    return Fg;
  }
  static void Activate(IntPtr h) {
    if (attachedTo == 0 || Fg == h) return;
    if (LandAfterReads == 0) Fg = h;
    else if (pending == IntPtr.Zero) { pending = h; landIn = LandAfterReads; }
  }
  public static bool SetForegroundWindow(IntPtr h) { Calls.Add("SetForegroundWindow"); Activate(h); return attachedTo != 0; }
  static bool BringWindowToTop(IntPtr h) { Calls.Add("BringWindowToTop"); Activate(h); return true; }
  static IntPtr SetActiveWindow(IntPtr h) { Calls.Add("SetActiveWindow"); return IntPtr.Zero; }
  static IntPtr SetFocus(IntPtr h) { Calls.Add("SetFocus"); return IntPtr.Zero; }
  public static bool ShowWindow(IntPtr h, int command) { Calls.Add("ShowWindow"); return true; }
  static bool IsIconic(IntPtr h) { return false; }
  static bool IsWindow(IntPtr h) { return h != IntPtr.Zero; }
  static uint GetWindowThreadProcessId(IntPtr h, IntPtr process) { return ThreadOf(h); }
  static uint GetCurrentThreadId() { return 1; }
  static bool AttachThreadInput(uint from, uint to, bool attach) {
    if (attach && to == ThreadOf(Fg)) attachedTo = to;
    if (!attach && to == attachedTo) attachedTo = 0;
    return true;
  }
  static bool SystemParametersInfo(uint action, uint parameter, IntPtr value, uint flags) { return false; }
  public static bool IsWindowHandle(IntPtr h) { return h != IntPtr.Zero; }
  public static bool IsContainedSameProcess(IntPtr candidate, IntPtr surface) { return false; }
  public static void ReportPointer(int x, int y, bool held, string phase = null) {}
  public static bool SetCursorPos(int x, int y) { return true; }
  public static void mouse_event(uint flags, int dx, int dy, int data, IntPtr extra) {}
}
`;

test('a target already in front is not activated again, and an activation that landed late is not replayed', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 90000,
}, async () => {
  const rows = await runPowerShell(
    'mixdog-foreground-focus-',
    { 'fake.cs': FAKE_USER32, 'foreground.cs': loadComputerSource('MixWin32Foreground.cs') },
    `
$ErrorActionPreference = 'Stop'
$dir = $env:FIXTURE_DIRECTORY
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $dir 'fake.cs')) + "\`n" + [IO.File]::ReadAllText((Join-Path $dir 'foreground.cs')))
$rows = @()
# Window 1 is the user's, window 2 the target.
foreach ($scenario in @('in_front', 'from_user_window', 'late_landing')) {
  [MixWin32]::Calls.Clear()
  [MixWin32]::Fg = $(if ($scenario -eq 'in_front') { [IntPtr]2 } else { [IntPtr]1 })
  [MixWin32]::LandAfterReads = $(if ($scenario -eq 'late_landing') { 2 } else { 0 })
  $focused = [MixWin32]::Focus([IntPtr]2)
  $rows += @{ scenario = $scenario; focused = $focused; front = [int64][MixWin32]::Fg; calls = @([MixWin32]::Calls) }
}
[Console]::WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject $rows))
`
  );
  const count = (row, call) => row.calls.filter((name) => name === call).length;
  const [inFront, fromUser, late] = rows;
  assert.deepEqual([inFront.focused, inFront.front, inFront.calls], [true, 2, []]);
  // The one switch away from the user's window still happens, exactly once.
  assert.deepEqual(
    [fromUser.focused, fromUser.front, count(fromUser, 'BringWindowToTop'), count(fromUser, 'SetFocus')],
    [true, 2, 1, 1]
  );
  assert.deepEqual(
    [late.focused, late.front, count(late, 'BringWindowToTop'), count(late, 'SetFocus')],
    [true, 2, 1, 1]
  );
});

test('a semantic step of a foreground operation leaves its target in front instead of bouncing focus to the user window', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 90000,
}, async () => {
  const rows = await runPowerShell(
    'mixdog-foreground-semantic-',
    { 'input.ps1': PS_INPUT },
    `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
public sealed class ObservedInput { public bool Ready = true; public string Generation = "a"; public long Sequence = 7; }
public static class MixInputObservation {
  public static ObservedInput Read() { return new ObservedInput(); }
  public static void BeginRestore(string monitor, long sequence, IntPtr target) {}
  public static void End() {}
}
public static class MixForegroundLock {
  public static int Acquires;
  public static System.Collections.Hashtable LastFacts = new System.Collections.Hashtable();
  public static bool Acquire(int holdMs, long action) { Acquires++; return false; }
  public static bool Held { get { return false; } }
  public static void Mark(string name) {}
  public static void Note(string name, object value) {}
  public static string Release() { return "none"; }
}
public static class MixWin32 {
  public static IntPtr Current;
  public static List<string> Calls = new List<string>();
  public static IntPtr Foreground() { return Current; }
  public static bool IsWindowHandle(IntPtr h) { return h != IntPtr.Zero; }
  public static bool IsWithinTopLevel(IntPtr candidate, IntPtr top) { return candidate == top; }
  public static bool IsContainedSameProcess(IntPtr candidate, IntPtr surface) { return false; }
  public static bool IsOwnedBy(IntPtr candidate, IntPtr owner) { return false; }
  // A Chromium target: its accessibility call pulls it in front of the user's window.
  public static bool SelfActivatesOnSemanticInput(IntPtr h) { return true; }
  public static bool SetWindowEnabled(IntPtr h, bool enabled) { Calls.Add("SetWindowEnabled"); return true; }
  public static IntPtr HoldInactive(IntPtr h) { return IntPtr.Zero; }
  public static void ReleaseInactive(IntPtr h) {}
  public static bool RestoreForeground(IntPtr h) { Calls.Add("RestoreForeground"); Current = h; return true; }
}
'@
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $env:FIXTURE_DIRECTORY 'input.ps1'), [ref]$tokens, [ref]$errors)
foreach ($name in @('Invoke-BackgroundWindow', 'Test-TargetWindow', 'Test-RestoreBaseline', 'Restore-UserForeground')) {
  $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  . ([scriptblock]::Create($function.Extent.Text))
}
$rows = @()
# Window 2 is the user's, window 1 the target the set_value step writes to.
foreach ($delivery in @('foreground', 'background')) {
  $script:CurrentRequest = [pscustomobject]@{ id = 5; delivery = $delivery }
  [MixWin32]::Calls.Clear(); [MixForegroundLock]::Acquires = 0
  [MixWin32]::Current = [IntPtr]2
  $null = Invoke-BackgroundWindow ([IntPtr]1) {
    [MixWin32]::Current = [IntPtr]1
    @{ delivery_accepted = $true; text = 'set' }
  }
  $rows += @{ delivery = $delivery; front = [int64][MixWin32]::Current; calls = @([MixWin32]::Calls); locks = [MixForegroundLock]::Acquires }
}
[Console]::WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject $rows))
`
  );
  const [foreground, background] = rows;
  // The target stays in front for the operation's next step; the host hands the
  // user's window back once, at the end of the turn.
  assert.deepEqual([foreground.front, foreground.calls, foreground.locks], [1, [], 0]);
  // Background delivery still keeps the user's window in front.
  assert.equal(background.front, 2);
  assert.ok(background.calls.includes('RestoreForeground'), JSON.stringify(background));
});
