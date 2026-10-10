import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';
import { PS_INPUT } from './ps-input.ts';
import { PS_RUNTIME } from './ps-runtime.ts';
import { PS_SEQUENCE } from './ps-sequence.ts';

const exec = promisify(execFile);
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows only', timeout: 40_000 };

async function runFixture(script, files = {}, inspect) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-inactive-hold-'));
  try {
    for (const [name, content] of Object.entries({ ...files, 'test.ps1': script })) {
      await writeFile(join(directory, name), content);
    }
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      {
        windowsHide: true,
        timeout: 30_000,
        env: {
          ...process.env,
          FIXTURE_DIRECTORY: directory,
          MIXDOG_COMPUTER_INACTIVE_LEDGER: join(directory, 'ledger.txt'),
        },
      }
    );
    const parsed = JSON.parse(stdout.trim());
    if (inspect) await inspect(directory);
    return parsed;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Loads the named functions out of a source file without running its top level.
const LOAD_FUNCTIONS = `
function Import-Functions($file, $names) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $env:FIXTURE_DIRECTORY $file), [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw 'fixture source did not parse' }
  foreach ($name in $names) {
    $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    if ($null -eq $node) { throw "missing $name" }
    . ([scriptblock]::Create($node.Extent.Text))
    Set-Item -Path ("function:global:" + $name) -Value (Get-Item ("function:" + $name)).ScriptBlock
  }
}
`;

test('no-activate holds count overlapping holders, clear only their own bit, and record it in the ledger', windowsOnly, async () => {
  let ledger = '';
  const result = await runFixture(
    `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:FIXTURE_DIRECTORY 'native.cs')))
[Console]::WriteLine([InactiveFixture]::Run())
`,
    {
      'native.cs':
        MIXDOG_HOST_CSHARP +
        `
public static class InactiveFixture {
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  static extern System.IntPtr CreateWindowExW(int ex, string cls, string name, uint style, int x, int y, int w, int h,
    System.IntPtr parent, System.IntPtr menu, System.IntPtr instance, System.IntPtr param);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool DestroyWindow(System.IntPtr h);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern int GetWindowLongW(System.IntPtr h, int index);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern int SetWindowLongW(System.IntPtr h, int index, int value);
  static bool Bit(System.IntPtr h) { return (GetWindowLongW(h, -20) & 0x08000000) != 0; }
  static void Check(bool ok, string what) { if (!ok) throw new System.Exception(what); }
  public static string Run() {
    // An invisible top-level popup: never the foreground, owned by this process.
    System.IntPtr h = CreateWindowExW(0, "STATIC", "inactive fixture", 0x80000000, 0, 0, 10, 10,
      System.IntPtr.Zero, System.IntPtr.Zero, System.IntPtr.Zero, System.IntPtr.Zero);
    Check(h != System.IntPtr.Zero, "fixture window");
    var rows = new System.Collections.Generic.List<string>();
    try {
      System.IntPtr first = MixWin32.HoldInactive(h);
      Check(first == h && Bit(h) && !MixWin32.ActivationUnprotected, "first hold adds the bit");
      System.IntPtr second = MixWin32.HoldInactive(h);
      Check(second == h, "an overlapping hold counts against the same root");
      // Not LIFO: the first holder leaves while the second still needs the bit.
      MixWin32.ReleaseInactive(first);
      Check(Bit(h), "bit kept while another holder needs it");
      MixWin32.ReleaseInactive(second);
      Check(!Bit(h), "the last holder clears the bit");
      MixWin32.ReleaseInactive(second);
      Check(!Bit(h), "a spare release changes nothing");
      // A bit someone else set is not needed and never cleared here.
      SetWindowLongW(h, -20, GetWindowLongW(h, -20) | 0x08000000);
      System.IntPtr foreign = MixWin32.HoldInactive(h);
      Check(foreign == System.IntPtr.Zero && !MixWin32.ActivationUnprotected, "an existing bit is not needed, not unavailable");
      MixWin32.ReleaseInactive(foreign);
      Check(Bit(h), "a bit this worker did not add stays");
      SetWindowLongW(h, -20, GetWindowLongW(h, -20) & ~0x08000000);
      // A scope keeps the bit across inner deliveries and settles once at its end.
      var scope = MixWin32.BeginInactive(h);
      System.IntPtr inner = MixWin32.HoldInactive(h);
      MixWin32.ReleaseInactive(inner);
      Check(Bit(h), "an inner delivery does not end the scope's hold");
      var clock = System.Diagnostics.Stopwatch.StartNew();
      MixWin32.EndInactive(scope);
      Check(clock.ElapsedMilliseconds >= 45, "the scope settles before it releases");
      Check(!Bit(h), "the scope's end clears the bit");
      MixWin32.EndInactive(scope);
      rows.Add("holds");
    } finally { DestroyWindow(h); }
    // Bounded recovery: two attempts 12 ms apart, re-checked before each one.
    var sleeps = new System.Collections.Generic.List<int>();
    System.Action<int> sleep = delegate (int ms) { sleeps.Add(ms); };
    int restores = 0;
    int attempts = MixWin32.RunInactiveRecovery(delegate { return true; }, delegate { restores++; }, sleep);
    Check(attempts == 2 && restores == 2 && sleeps.Count == 1 && sleeps[0] == 12, "a target that keeps the foreground gets two attempts");
    sleeps.Clear(); restores = 0;
    bool holds = true;
    attempts = MixWin32.RunInactiveRecovery(delegate { return holds; }, delegate { restores++; holds = false; }, sleep);
    Check(attempts == 1 && restores == 1, "a restore that took ends recovery");
    sleeps.Clear();
    attempts = MixWin32.RunInactiveRecovery(delegate { return false; }, delegate { throw new System.Exception("must not restore"); }, sleep);
    Check(attempts == 0, "nothing is restored while the user's window keeps the foreground");
    sleeps.Clear(); restores = 0;
    attempts = MixWin32.RunInactiveRecovery(delegate { return true; },
      delegate { restores++; throw new System.Exception("user_input_active: external input interrupted this action"); }, sleep);
    Check(attempts == 1 && sleeps.Count == 0, "user input skips every further restore");
    sleeps.Clear(); restores = 0;
    attempts = MixWin32.RunInactiveRecovery(delegate { return true; },
      delegate { restores++; if (restores == 2) throw new System.Exception("user_input_active: moved"); }, sleep);
    Check(attempts == 2, "user input before the second attempt stops it");
    bool surfaced = false;
    try { MixWin32.RunInactiveRecovery(delegate { return true; }, delegate { throw new System.Exception("computer_policy_expired: stop"); }, sleep); }
    catch (System.Exception error) { surfaced = error.Message.StartsWith("computer_policy_expired"); }
    Check(surfaced, "other failures are not swallowed");
    rows.Add("recovery");
    return "[\\"" + System.String.Join("\\",\\"", rows) + "\\"]";
  }
}
`,
    },
    async (directory) => {
      ledger = await readFile(join(directory, 'ledger.txt'), 'utf8');
    }
  );
  assert.deepEqual(result, ['holds', 'recovery']);
  // Each bit this worker added is recorded once and struck once it is cleared;
  // the bit it found already set never appears.
  assert.deepEqual(
    ledger
      .trim()
      .split('\n')
      .map((line) => line.split('\t')[0]),
    ['+', '-', '+', '-']
  );
});

test('a background semantic call releases its hold even when cleanup fails, and restores a repeated steal', windowsOnly, async () => {
  const rows = await runFixture(
    `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
public sealed class ObservedInput { public bool Ready = true; public string Generation = "a"; public long Sequence = 7; }
public static class MixInputObservation {
  public static ObservedInput Current = new ObservedInput();
  public static ObservedInput Read() { return Current; }
  public static void BeginExpected(string monitor, long sequence) {
    if (sequence != Current.Sequence) throw new Exception("user_input_active: moved");
  }
  public static void AssertContinue() {}
  public static void End() {}
}
public static class MixWin32 {
  public static IntPtr Current;
  public static int FocusCalls, Releases, Resteals;
  public static bool FailEnable, FailFocus;
  public static IntPtr Foreground() { return Current; }
  public static bool IsWithinTopLevel(IntPtr candidate, IntPtr top) { return candidate == top; }
  public static bool IsContainedSameProcess(IntPtr a, IntPtr b) { return false; }
  public static bool IsOwnedBy(IntPtr a, IntPtr b) { return false; }
  public static bool IsWindowHandle(IntPtr value) { return value != IntPtr.Zero; }
  public static bool IsWebContentHost(IntPtr value) { return true; }
  public static bool SelfActivatesOnSemanticInput(IntPtr value) { return true; }
  public static bool Focus(IntPtr value) {
    FocusCalls++;
    if (FailFocus) throw new Exception("focus_broken: fixture");
    Current = value;
    // The target raises itself once more right after the first restore.
    if (Resteals > 0) { Resteals--; Current = new IntPtr(1); }
    return true;
  }
  public static bool SetWindowEnabled(IntPtr value, bool enabled) {
    if (enabled && FailEnable) throw new Exception("enable_failed: fixture");
    return true;
  }
  public static IntPtr HoldInactive(IntPtr value) { return value; }
  public static void ReleaseInactive(IntPtr value) { if (value != IntPtr.Zero) Releases++; }
}
'@
${LOAD_FUNCTIONS}
Import-Functions 'input.ps1' @('Invoke-BackgroundWindow')
$rows = @()
foreach ($scenario in @('enable_fails', 'focus_fails', 'resteal')) {
  [MixWin32]::Releases = 0; [MixWin32]::FocusCalls = 0; [MixWin32]::Current = [IntPtr]2
  [MixWin32]::FailEnable = $scenario -eq 'enable_fails'
  [MixWin32]::FailFocus = $scenario -eq 'focus_fails'
  [MixWin32]::Resteals = if ($scenario -eq 'resteal') { 1 } else { 0 }
  $failure = ''
  try { $null = Invoke-BackgroundWindow ([IntPtr]1) { [MixWin32]::Current = [IntPtr]1 } }
  catch { $failure = $_.Exception.Message }
  $rows += @{ scenario = $scenario; releases = [MixWin32]::Releases; failure = $failure; focus = [MixWin32]::FocusCalls;
    restored = ([MixWin32]::Current -eq [IntPtr]2) }
}
[Console]::WriteLine((ConvertTo-Json @($rows) -Compress))
`,
    { 'input.ps1': PS_INPUT }
  );
  const byName = Object.fromEntries(rows.map((row) => [row.scenario, row]));
  // The style comes off however the cleanup before it ended.
  assert.equal(byName.enable_fails.releases, 1);
  assert.match(byName.enable_fails.failure, /enable_failed/);
  assert.equal(byName.focus_fails.releases, 1);
  assert.match(byName.focus_fails.failure, /focus_broken/);
  // A web content host is watched too, and a second steal is restored once more.
  assert.equal(byName.resteal.releases, 1);
  assert.equal(byName.resteal.failure, '');
  assert.equal(byName.resteal.focus, 2);
  assert.equal(byName.resteal.restored, true);
});

const DELIVERY_STUBS = `
Add-Type @'
using System;
using System.Collections.Generic;
public static class MixWin32 {
  public static List<string> Events = new List<string>();
  public static bool FailText, FailPress;
  public static string WindowId(IntPtr value) { return "hwnd:0x" + value.ToInt64().ToString("X"); }
  public static IntPtr ParseWindowId(string value) { return new IntPtr(Convert.ToInt32(value.Substring(7), 16)); }
  public static bool IsOwnedBy(IntPtr a, IntPtr b) { return false; }
  public static object BeginInactive(IntPtr target) { Events.Add("begin"); return "scope"; }
  public static void EndInactive(object scope) { Events.Add("end"); }
  public static IntPtr HoldInactive(IntPtr target) { Events.Add("hold"); return target; }
  public static void ReleaseInactive(IntPtr root) { if (root != IntPtr.Zero) Events.Add("unhold"); }
  public static string BackgroundPointer(IntPtr target, int x, int y, string kind, string modifiers) {
    if (kind == "press" && FailPress) throw new InvalidOperationException("background_target_hung|fixture");
    Events.Add("pointer:" + kind); return WindowId(target);
  }
  public static string BackgroundText(IntPtr target, IntPtr preferred, string text) {
    if (FailText) throw new InvalidOperationException("background_message_rejected|fixture");
    Events.Add("text"); return WindowId(target);
  }
}
'@
function Resolve-WindowInfo($window, $id) { return @{ Handle = [IntPtr]5; Id = 'hwnd:0x5' } }
function Get-PointArg($req) { return @(10, 20, [IntPtr]5) }
function Get-ObservableTargetState($record, $action) { return $null }
function Assert-ExecutionAuthorization($req, $target) {}
function Test-AllowedPointTarget($candidate, $selected, $allowed) { return $true }
function Complete-NativeAction($action, $messageTarget, $windowId) { return @{ action = $action; delivery_accepted = $true } }
function Native-BackgroundFailure($action, $exception, $windowId, $prior) { return @{ action = $action; delivery_accepted = $null; failure = $exception.Message } }
function Get-CurrentSession { return $script:state }
`;

test('background typing holds one scope across the click, the wait and the text', windowsOnly, async () => {
  const rows = await runFixture(
    `
$ErrorActionPreference = 'Stop'
${DELIVERY_STUBS}
${LOAD_FUNCTIONS}
Import-Functions 'runtime.ps1' @('Do-Type')
$rows = @()
foreach ($failText in @($false, $true)) {
  [MixWin32]::Events.Clear(); [MixWin32]::FailText = $failText
  $result = Do-Type @{ action = 'type'; window_id = 'hwnd:0x5'; delivery = 'background'; text = 'abc'; x = 10; y = 20 }
  $rows += @{ events = @([MixWin32]::Events); accepted = $result.delivery_accepted }
}
[Console]::WriteLine((ConvertTo-Json @($rows) -Compress -Depth 4))
`,
    { 'runtime.ps1': PS_RUNTIME }
  );
  assert.deepEqual(rows[0].events, ['begin', 'pointer:click', 'text', 'end']);
  assert.equal(rows[0].accepted, true);
  // A failed text delivery still ends the one scope, after the click it followed.
  assert.deepEqual(rows[1].events, ['begin', 'pointer:click', 'end']);
});

test('a background press keeps its target held until the release or the session cleanup', windowsOnly, async () => {
  const rows = await runFixture(
    `
$ErrorActionPreference = 'Stop'
${DELIVERY_STUBS}
${LOAD_FUNCTIONS}
Import-Functions 'input.ps1' @('Do-ClickFamily', 'Record-HeldPointer', 'Release-HeldPointerButtons')
$script:state = @{ Map = @{}; HeldPointerTargets = @{} }
$request = @{ action = 'mouse_down'; window_id = 'hwnd:0x5'; delivery = 'background' }
$rows = @()
[MixWin32]::Events.Clear()
$null = Do-ClickFamily $request 'press'
$rows += @{ step = 'press'; events = @([MixWin32]::Events); held = $script:state.HeldPointerInactive.Count }
[MixWin32]::Events.Clear()
$null = Do-ClickFamily (@{ action = 'mouse_up'; window_id = 'hwnd:0x5'; delivery = 'background' }) 'release'
$rows += @{ step = 'release'; events = @([MixWin32]::Events); held = $script:state.HeldPointerInactive.Count }
[MixWin32]::Events.Clear()
$null = Do-ClickFamily $request 'press'
$script:state.SequenceInactive = @{ 'hwnd:0x5' = 'scope' }
Release-HeldPointerButtons $script:state
$rows += @{ step = 'cleanup'; events = @([MixWin32]::Events); held = $script:state.HeldPointerInactive.Count;
  buttons = $script:state.HeldPointerTargets.Count; sequences = $script:state.SequenceInactive.Count }
[MixWin32]::Events.Clear(); [MixWin32]::FailPress = $true
$failed = Do-ClickFamily $request 'press'
$rows += @{ step = 'failed_press'; events = @([MixWin32]::Events); held = $script:state.HeldPointerInactive.Count; failure = $failed.failure }
[Console]::WriteLine((ConvertTo-Json @($rows) -Compress -Depth 4))
`,
    { 'input.ps1': PS_INPUT }
  );
  const [press, release, cleanup, failed] = rows;
  assert.deepEqual(press.events, ['hold', 'pointer:press']);
  assert.equal(press.held, 1, 'the press keeps its hold past its own request');
  assert.deepEqual(release.events, ['pointer:release', 'unhold']);
  assert.equal(release.held, 0);
  assert.deepEqual(cleanup.events, ['hold', 'pointer:press', 'pointer:release', 'unhold', 'end']);
  assert.equal(cleanup.held, 0);
  assert.equal(cleanup.buttons, 0);
  assert.equal(cleanup.sequences, 0, 'an unfinished sequence hold ends with the session cleanup');
  assert.deepEqual(failed.events, ['hold', 'unhold'], 'a press that did not land gives its hold back');
  assert.equal(failed.held, 0);
  assert.match(failed.failure, /background_target_hung/);
});

test('a background sequence holds its root across continuing steps and ends the hold once', windowsOnly, async () => {
  const rows = await runFixture(
    `
$ErrorActionPreference = 'Stop'
${DELIVERY_STUBS}
${LOAD_FUNCTIONS}
Import-Functions 'sequence.ps1' @('Invoke-SequenceStep')
function Do-WindowSnapshot { return @{ windows = @() } }
function Handle($step) { [MixWin32]::Events.Add('step'); return @{ delivery_accepted = $true } }
$script:state = @{ Map = @{} }
function Step($continues) {
  $step = @{ action = 'click'; delivery = 'background'; window_id = 'hwnd:0x5'; session_id = 's' }
  if ($continues) { $step.input_continues = $true }
  return @{ action = 'sequence_step'; delivery = 'background'; session_id = 's'; step = [pscustomobject]$step }
}
$null = Invoke-SequenceStep (Step $true)
$open = $script:state.SequenceInactive.Count
$null = Invoke-SequenceStep (Step $true)
$null = Invoke-SequenceStep (Step $false)
[Console]::WriteLine((ConvertTo-Json @{ events = @([MixWin32]::Events); open = $open; after = $script:state.SequenceInactive.Count } -Compress))
`,
    { 'sequence.ps1': PS_SEQUENCE }
  );
  assert.deepEqual(rows.events, ['begin', 'step', 'step', 'step', 'end']);
  assert.equal(rows.open, 1);
  assert.equal(rows.after, 0);
});
