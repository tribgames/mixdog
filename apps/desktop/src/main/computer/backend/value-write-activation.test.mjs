import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { PS_INPUT } from './ps-input.ts';
import { PS_RUNTIME } from './ps-runtime.ts';
import { PS_SESSION } from './ps-session.ts';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';

const windows = { skip: process.platform !== 'win32' && 'Windows only', timeout: 30000 };

const IMPORT = `
$ErrorActionPreference = 'Stop'
function Import-Functions($file, $names) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $env:FIXTURE_DIRECTORY $file), [ref]$tokens, [ref]$errors)
  foreach ($name in $names) {
    $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    if ($null -eq $node) { throw "missing function $name" }
    . ([scriptblock]::Create($node.Extent.Text.Replace('function ', 'function global:')))
  }
}
Import-Functions 'session.ps1' @('Get-SessionState')
Import-Functions 'input.ps1' @('Get-ValueWriteActivators', 'Register-ValueWriteActivation', 'Unregister-ValueWriteActivation', 'Test-ValueWriteActivates')
$Sessions = @{}
$script:CurrentSession = Get-SessionState 'value-write'
function Get-CurrentSession { return $script:CurrentSession }
`;

async function runFixture(script) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-value-write-'));
  try {
    await writeFile(join(directory, 'input.ps1'), PS_INPUT);
    await writeFile(join(directory, 'runtime.ps1'), PS_RUNTIME);
    await writeFile(join(directory, 'session.ps1'), PS_SESSION);
    await writeFile(join(directory, 'native.cs'), MIXDOG_HOST_CSHARP);
    await writeFile(join(directory, 'test.ps1'), IMPORT + script);
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      { timeout: 25000, windowsHide: true, env: { ...process.env, FIXTURE_DIRECTORY: directory } }
    );
    return JSON.parse(stdout.trim());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const VALUE_FIXTURE = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Collections.Generic;
public sealed class FakeValueInfo {
  public FakeValue Owner;
  public string Value { get { if (Owner.Unreadable) throw new InvalidOperationException("gone"); return Owner.Text; } }
  public bool IsReadOnly { get { return Owner.ReadOnly; } }
}
public sealed class ObservedInput { public bool Ready = true; public string Generation = "a"; public long Sequence; }
public static class MixInputObservation {
  public static long Sequence = 7;
  public static ObservedInput Read() { MixWin32.Order.Add("observe"); return new ObservedInput { Sequence = Sequence }; }
  public static void BeginExpected(string monitor, long sequence) {
    if (sequence != Sequence) throw new Exception("user_input_active: superseded");
  }
  public static void AssertContinue() {}
  public static void End() {}
}
public sealed class FakeValue {
  public string Text = "old";
  public bool ReadOnly;
  public bool Unreadable;
  public int SetValueCalls;
  public string SetValueStores = "same";
  // What happens to the foreground while the provider handles the write:
  // nothing, its window raises itself, the user acts meanwhile, or the window
  // comes forward only after the call returned.
  public string Activation = "none";
  public FakeValueInfo Current { get { return new FakeValueInfo { Owner = this }; } }
  public void SetValue(string value) {
    MixWin32.Order.Add("setvalue");
    SetValueCalls++;
    Text = SetValueStores == "lower" ? value.ToLowerInvariant() : value;
    if (Activation == "steal" || Activation == "user") MixWin32.Current = new IntPtr(1);
    if (Activation == "user") MixInputObservation.Sequence++;
    if (Activation == "later") MixWin32.StealAfterReads = 1;
  }
}
public sealed class FakeElementInfo { public bool IsEnabled = true; public string ClassName = "RichEditD2DPT"; }
public sealed class FakeElement {
  public FakeValue Value = new FakeValue();
  public FakeElementInfo Current = new FakeElementInfo();
  public bool TryGetCurrentPattern(object pattern, out object result) { result = Value; return true; }
}
public sealed class FakeMsaa {
  public bool Enabled = true;
  public bool ReadOnly;
  public string SetValue(string value) { return value.ToLowerInvariant(); }
}
public static class MixWin32 {
  public static FakeElement Element;
  public static List<string> Sent = new List<string>();
  public static bool Selected;
  // How the control handles typed text: as typed, Enter stored as CR, cut to
  // a length limit, folded to lower case, or unreadable afterwards.
  public static string Typing = "enter_cr";
  // How the control answers: select-all proven and Delete honoured, the
  // selection proof failing (only selection messages sent), or Delete refused
  // on a proven selection.
  public static string Selection = "whole";
  public static List<string> Order = new List<string>();
  public static Dictionary<long, string> Alive = new Dictionary<long, string>();
  public static string WindowOwnerIdentity(IntPtr value) {
    string identity; return Alive.TryGetValue(value.ToInt64(), out identity) ? identity : "";
  }
  public static string WindowId(IntPtr value) { return "hwnd:0x" + value.ToInt64().ToString("x"); }
  public static bool IsWindowHandle(IntPtr value) { return value != IntPtr.Zero; }
  // Window 1 is the target; window 2 is where the user works.
  public static IntPtr Current = new IntPtr(2);
  public static int StealAfterReads = -1;
  public static IntPtr Foreground() {
    Order.Add("foreground");
    if (StealAfterReads == 0) Current = new IntPtr(1);
    if (StealAfterReads >= 0) StealAfterReads--;
    return Current;
  }
  public static bool IsWithinTopLevel(IntPtr candidate, IntPtr top) { return candidate == top; }
  public static bool IsContainedSameProcess(IntPtr child, IntPtr parent) { return false; }
  public static bool IsOwnedBy(IntPtr child, IntPtr parent) { return false; }
  public static bool Focus(IntPtr value) { Current = value; return true; }
  public static bool SelfActivatesOnSemanticInput(IntPtr value) { return false; }
  public static bool SetWindowEnabled(IntPtr value, bool enabled) { return true; }
  public static IntPtr HoldInactive(IntPtr value) { return IntPtr.Zero; }
  public static void ReleaseInactive(IntPtr value) {}
  public static object BeginInactive(IntPtr top) { Sent.Add("hold"); return new object(); }
  public static void EndInactive(object scope) { Sent.Add("release"); }
  public static int BackgroundSelectAll(IntPtr top, IntPtr preferred, bool valueHasText) {
    Sent.Add("select");
    if (Selection == "ignored") return -1;
    Selected = true;
    return Element.Value.Text.Length;
  }
  public static int BackgroundTextEnd(IntPtr top, IntPtr preferred) {
    Sent.Add("end");
    return Element.Value.Text.Length;
  }
  public static string BackgroundKeys(IntPtr top, IntPtr preferred, string keys) {
    Sent.Add("keys:" + keys);
    if (keys == "{DELETE}" && Selection != "deleteRejected") {
      if (Selected) Element.Value.Text = "";
      else if (Element.Value.Text.Length > 0) Element.Value.Text = Element.Value.Text.Substring(1);
    }
    Selected = false;
    return WindowId(preferred);
  }
  public static string BackgroundText(IntPtr top, IntPtr preferred, string text) {
    Sent.Add("text:" + text);
    string stored = text.Replace("\\r", "").Replace("\\n", "\\r");
    if (Typing == "limit") stored = stored.Substring(0, 2);
    if (Typing == "lower") stored = stored.ToLowerInvariant();
    if (Typing == "unreadable") Element.Value.Unreadable = true;
    Element.Value.Text += stored;
    return WindowId(preferred);
  }
  public static void SendText(string text) { Sent.Add("foreground:" + text); }
}
'@
function Get-RefRecord($ref) {
  if ($ref -eq 'msaa') { return @{ Kind = 'msaa'; Msaa = (New-Object FakeMsaa); WindowId = 'hwnd:0x1' } }
  return @{ Kind = 'uia'; Element = [MixWin32]::Element; WindowId = 'hwnd:0x1' }
}
function Get-RefTopHandle($record) { return [IntPtr]1 }
function Get-TopWindowId($el) { return 'hwnd:0x1' }
function Get-ExactNativeElementHandle($el) { return $script:NativeTarget }
function Test-BackgroundKeyboardRoute($top, $preferred) { return $script:KeyboardRoute }
function Assert-ExecutionAuthorization($req, $target) {}
function Select-OwningItemAlone($el) { return $null }
Import-Functions 'input.ps1' @('New-ActionResult', 'Get-VerifiedEffect', 'Background-Unavailable', 'Native-BackgroundFailure',
  'Test-IgnoredValueWrite', 'Test-SameValue', 'ConvertTo-TypedLineBreaks', 'Read-ValueUntil', 'Write-ValueByKeys', 'Do-SetValue',
  'Test-TargetWindow', 'Invoke-BackgroundWindow')
[MixWin32]::Alive[[long]1] = '100:1'
function Attempt($text, [scriptblock]$arrange, [bool]$recorded = $true) {
  [MixWin32]::Element = New-Object FakeElement
  [MixWin32]::Sent.Clear()
  [MixWin32]::Selected = $false
  [MixWin32]::Typing = 'enter_cr'
  [MixWin32]::Selection = 'whole'
  [MixWin32]::Current = [IntPtr]2
  [MixWin32]::StealAfterReads = -1
  [MixInputObservation]::Sequence = 7
  [MixWin32]::Order.Clear()
  $script:NativeTarget = [IntPtr]2
  $script:KeyboardRoute = $true
  $script:CurrentSession.ValueWriteActivators.Clear()
  if ($recorded) { Register-ValueWriteActivation ([IntPtr]1) }
  if ($arrange) { & $arrange }
  $result = if ($script:Wrapped) { Invoke-BackgroundWindow ([IntPtr]1) { Do-SetValue 's1:e0' $text } } else { Do-SetValue 's1:e0' $text }
  return @{
    path = $result.path; verified = $result.verified; effect = $result.effect; code = $result.code
    sent = @([MixWin32]::Sent); setValue = [MixWin32]::Element.Value.SetValueCalls; value = [MixWin32]::Element.Value.Text
    recorded = (Test-ValueWriteActivates ([IntPtr]1)); restored = ([MixWin32]::Current -eq [IntPtr]2)
    mayHaveExecuted = $result.input_may_have_executed; order = @([MixWin32]::Order)
  }
}
`;

test(
  'a window is remembered only when its own value write call raised it, and forgotten with it',
  windows,
  async () => {
    const rows = await runFixture(`${VALUE_FIXTURE}
$rows = [ordered]@{}
$rows.steal = Attempt 'abc' { [MixWin32]::Element.Value.Activation = 'steal' } $false
$rows.quiet = Attempt 'abc' $null $false
# A remembered window whose keyboard proof fails takes the accessibility write
# once; a call that does not raise it forgets it, one that does keeps it.
$rows.recordedQuiet = Attempt 'abc' { [MixWin32]::Selection = 'ignored' }
$rows.recordedSteal = Attempt 'abc' { [MixWin32]::Selection = 'ignored'; [MixWin32]::Element.Value.Activation = 'steal' }
$rows.recordedUser = Attempt 'abc' { [MixWin32]::Selection = 'ignored'; [MixWin32]::Element.Value.Activation = 'user' }
# The same for every keyboard-route outcome that sent nothing: an element with
# no native handle of its own, or one the background keyboard check rejects.
$rows.noHandleQuiet = Attempt 'abc' { $script:NativeTarget = [IntPtr]::Zero }
$rows.noHandleSteal = Attempt 'abc' { $script:NativeTarget = [IntPtr]::Zero; [MixWin32]::Element.Value.Activation = 'steal' }
$rows.rejectedQuiet = Attempt 'abc' { $script:KeyboardRoute = $false }
$rows.rejectedSteal = Attempt 'abc' { $script:KeyboardRoute = $false; [MixWin32]::Element.Value.Activation = 'steal' }
# The user typed or clicked while the call ran: the change may be theirs.
$rows.userInput = Attempt 'abc' { [MixWin32]::Element.Value.Activation = 'user' } $false
# The user already works in the target: the target holding the foreground is not a steal.
$rows.userInTarget = Attempt 'abc' { [MixWin32]::Current = [IntPtr]1; [MixWin32]::Element.Value.Activation = 'steal' } $false
# The window comes forward only after the call returned, inside the wrapper's
# watch: restored there, but not attributed to the value write.
$script:Wrapped = $true
$rows.later = Attempt 'abc' { [MixWin32]::Element.Value.Activation = 'later' } $false
$script:Wrapped = $false
$null = Attempt 'abc' { [MixWin32]::Element.Value.Activation = 'steal' } $false
# A handle reused by another window is not the window that was observed.
[MixWin32]::Alive[[long]1] = '200:9'
$rows.reused = Test-ValueWriteActivates ([IntPtr]1)
[MixWin32]::Alive[[long]1] = '100:1'
$null = Attempt 'abc' { [MixWin32]::Element.Value.Activation = 'steal' } $false
[void][MixWin32]::Alive.Remove([long]1)
$rows.dead = Test-ValueWriteActivates ([IntPtr]1)
$rows.after = $script:CurrentSession.ValueWriteActivators.Count
$rows | ConvertTo-Json -Compress -Depth 4
`);
    assert.equal(rows.steal.recorded, true);
    assert.equal(rows.steal.path, 'uia_value');
    // The observer brackets the foreground reads on both sides of the call.
    assert.deepEqual(rows.steal.order, ['observe', 'foreground', 'setvalue', 'foreground', 'observe']);
    assert.equal(rows.quiet.recorded, false);
    for (const name of ['recordedQuiet', 'recordedSteal', 'recordedUser']) {
      assert.equal(rows[name].path, 'uia_value', name);
      assert.equal(rows[name].setValue, 1, name);
      assert.deepEqual(rows[name].sent, ['hold', 'select', 'release'], name);
    }
    assert.equal(rows.recordedQuiet.recorded, false, 'a call that did not raise the window forgets it');
    assert.equal(rows.recordedSteal.recorded, true);
    assert.equal(rows.recordedUser.recorded, true, 'a call the user acted during proves nothing either way');
    for (const name of ['noHandleQuiet', 'noHandleSteal', 'rejectedQuiet', 'rejectedSteal']) {
      assert.equal(rows[name].path, 'uia_value', name);
      assert.equal(rows[name].verified, true, name);
      assert.equal(rows[name].setValue, 1, name);
      assert.deepEqual(rows[name].sent, [], `${name}: no keyboard message`);
    }
    assert.equal(rows.noHandleQuiet.recorded, false);
    assert.equal(rows.noHandleSteal.recorded, true);
    assert.equal(rows.rejectedQuiet.recorded, false);
    assert.equal(rows.rejectedSteal.recorded, true);
    assert.equal(rows.userInput.recorded, false);
    assert.equal(rows.userInTarget.recorded, false);
    assert.equal(rows.later.recorded, false);
    assert.equal(rows.later.restored, true, 'the watch still gives the user their window back');
    assert.equal(rows.reused, false);
    assert.equal(rows.dead, false);
    assert.equal(rows.after, 0, 'entries for gone or reused windows are dropped');
  }
);

test(
  'a remembered window takes set_value through its keyboard, refusing first and never writing twice',
  windows,
  async () => {
    const rows = await runFixture(`${VALUE_FIXTURE}
$rows = [ordered]@{}
$rows.keys = Attempt "Hello\`nWorld"
$rows.readOnly = Attempt 'x' { [MixWin32]::Element.Value.ReadOnly = $true }
$rows.disabled = Attempt 'x' { [MixWin32]::Element.Current.IsEnabled = $false }
$rows.limit = Attempt 'abcdef' { [MixWin32]::Typing = 'limit' }
$rows.caseKeys = Attempt 'ABC' { [MixWin32]::Typing = 'lower' }
$rows.unreadable = Attempt 'abc' { [MixWin32]::Typing = 'unreadable' }
$rows.deleteRejected = Attempt 'abc' { [MixWin32]::Selection = 'deleteRejected' }
$rows.empty = Attempt ''
$rows.bareCr = Attempt "a\`rb"
$rows.crLf = Attempt "a\`r\`nb"
$rows.uia = Attempt 'abc' $null $false
$rows.caseUia = Attempt 'ABC' { [MixWin32]::Element.Value.SetValueStores = 'lower' } $false
$msaa = Do-SetValue 'msaa' 'ABC'
$rows.caseMsaa = @{ verified = $msaa.verified }
$rows | ConvertTo-Json -Compress -Depth 4
`);
    // Remembered window: selection proven, cleared through the keyboard, typed, read back once.
    assert.equal(rows.keys.path, 'win32_message');
    assert.equal(rows.keys.verified, true);
    assert.equal(rows.keys.effect, 'confirmed');
    assert.equal(rows.keys.setValue, 0, 'the accessibility value write is never made');
    assert.deepEqual(rows.keys.sent, ['hold', 'select', 'keys:{DELETE}', 'end', 'text:Hello\nWorld', 'release']);
    assert.equal(rows.keys.value, 'Hello\rWorld');
    // Refusals come before anything is sent.
    for (const [name, code] of [
      ['readOnly', 'element_read_only'],
      ['disabled', 'element_disabled'],
    ]) {
      assert.equal(rows[name].code, code, name);
      assert.deepEqual(rows[name].sent, [], name);
      assert.equal(rows[name].setValue, 0, name);
      assert.equal(rows[name].value, 'old', name);
    }
    // Any readback other than the requested text is unverified and not written again.
    for (const name of ['limit', 'caseKeys', 'unreadable']) {
      assert.equal(rows[name].path, 'win32_message', name);
      assert.equal(rows[name].verified, false, name);
      assert.equal(rows[name].effect, 'unverifiable', name);
      assert.equal(rows[name].setValue, 0, name);
      assert.equal(rows[name].sent.filter((entry) => entry.startsWith('text:')).length, 1, name);
    }
    assert.equal(rows.caseKeys.value, 'abc');
    // A proven selection whose Delete the control refused: nothing is typed into
    // what is left, the result is unverified and the Delete may have acted.
    assert.equal(rows.deleteRejected.path, 'win32_message');
    assert.equal(rows.deleteRejected.verified, false);
    assert.equal(rows.deleteRejected.mayHaveExecuted, true);
    assert.deepEqual(rows.deleteRejected.sent, ['hold', 'select', 'keys:{DELETE}', 'end', 'release']);
    assert.equal(rows.deleteRejected.value, 'old');
    assert.equal(rows.deleteRejected.setValue, 0, 'no fallback after a destructive key');
    assert.equal(rows.empty.verified, true);
    assert.deepEqual(rows.empty.sent, ['hold', 'select', 'keys:{DELETE}', 'end', 'release']);
    // Line breaks are sent as the Enter they stand for, so a bare CR is not lost.
    for (const name of ['bareCr', 'crLf']) {
      assert.deepEqual(rows[name].sent, ['hold', 'select', 'keys:{DELETE}', 'end', 'text:a\nb', 'release'], name);
      assert.equal(rows[name].value, 'a\rb', name);
      assert.equal(rows[name].verified, true, name);
    }
    // A window never seen raising itself keeps the accessibility route, exactly once.
    assert.equal(rows.uia.path, 'uia_value');
    assert.equal(rows.uia.verified, true);
    assert.equal(rows.uia.setValue, 1);
    assert.deepEqual(rows.uia.sent, []);
    // Letter case is part of the value on every route.
    assert.equal(rows.caseUia.verified, false);
    assert.equal(rows.caseMsaa.verified, false);
  }
);

test('an MSAA value write refuses a read-only or disabled field before writing', windows, async () => {
  const rows = await runFixture(`
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:FIXTURE_DIRECTORY 'native.cs')))
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); }
'@
Import-Functions 'input.ps1' @('New-ActionResult', 'Get-VerifiedEffect', 'Background-Unavailable', 'Test-SameValue', 'Do-SetValue')
function Assert-ExecutionAuthorization($req, $target) {}
$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(-3000, -3000)
$fields = [ordered]@{
  writable = (New-Object System.Windows.Forms.TextBox -Property @{ Text = 'writable-before'; Top = 10 })
  readOnly = (New-Object System.Windows.Forms.TextBox -Property @{ Text = 'readonly-before'; Top = 40; ReadOnly = $true })
  disabled = (New-Object System.Windows.Forms.TextBox -Property @{ Text = 'disabled-before'; Top = 70; Enabled = $false })
}
foreach ($field in $fields.Values) { $form.Controls.Add($field) }
$form.CreateControl()
# Shown without activation, so the fixture never takes the user's foreground.
[void][FixtureWindow]::ShowWindow($form.Handle, 4)
$windowId = 'hwnd:0x' + $form.Handle.ToInt64().ToString('x')
$nodes = @([MixMsaa]::Snapshot($form.Handle, $windowId, 100))
$rows = [ordered]@{}
try {
  foreach ($name in @($fields.Keys)) {
    $before = $fields[$name].Text
    $node = @($nodes | Where-Object { $_.Value -eq $before }) | Select-Object -First 1
    if ($null -eq $node) { throw "no MSAA node for $name" }
    $script:Record = @{ Kind = 'msaa'; Msaa = $node; WindowId = $windowId }
    function Get-RefRecord($ref) { [void]$script:Record.Msaa.Refresh(); return $script:Record }
    $result = Do-SetValue 'm1' 'written-by-test'
    $rows[$name] = @{ code = $result.code; path = $result.path; verified = $result.verified; text = $fields[$name].Text }
  }
}
finally { $form.Dispose() }
$rows | ConvertTo-Json -Compress
`);
  assert.equal(rows.writable.path, 'msaa_value');
  assert.equal(rows.writable.verified, true);
  assert.equal(rows.writable.text, 'written-by-test');
  assert.equal(rows.readOnly.code, 'element_read_only');
  assert.equal(rows.readOnly.text, 'readonly-before', 'nothing is written into a read-only field');
  assert.equal(rows.disabled.code, 'element_disabled');
  assert.equal(rows.disabled.text, 'disabled-before');
});

test(
  'the keyboard route proves the selection natively and leaves a control that ignores it untouched',
  windows,
  async () => {
    const rows = await runFixture(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:FIXTURE_DIRECTORY 'native.cs')))
Add-Type -ReferencedAssemblies @('System.Windows.Forms') @'
using System;
using System.Runtime.InteropServices;
public static class FixtureWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); }
// The value as an accessibility reader would see it: the control's own text.
public sealed class ControlValueInfo {
  public System.Windows.Forms.Control Owner;
  public string Value { get { return Owner.Text; } }
  public bool IsReadOnly { get { return false; } }
}
public sealed class ControlValue {
  public System.Windows.Forms.Control Owner;
  public int SetValueCalls;
  public ControlValueInfo Current { get { return new ControlValueInfo { Owner = Owner }; } }
  public void SetValue(string value) { SetValueCalls++; Owner.Text = value; }
}
public sealed class ControlElementInfo { public bool IsEnabled = true; public string ClassName = "fixture"; }
public sealed class ControlElement {
  public ControlValue Value;
  public ControlElementInfo Current = new ControlElementInfo();
  public bool TryGetCurrentPattern(object pattern, out object result) { result = Value; return true; }
}
// An editor whose text length counts a line break as CR LF (two) while its
// selection positions count it as one, as RichEdit does.
public sealed class UnitsEditor : System.Windows.Forms.Control {
  public string Content = "first\\r\\nsecond";
  public int Start, End;
  public int LengthReplies, Chars;
  // normal; partial: select-all stops one short; protected: Delete is refused.
  public string Mode = "normal";
  int Last { get { return Content.Replace("\\r\\n", "\\n").Length; } }
  public override string Text { get { return Content; } set { Content = value ?? ""; } }
  protected override void WndProc(ref System.Windows.Forms.Message m) {
    switch (m.Msg) {
      case 0x000E: LengthReplies++; m.Result = new IntPtr(Content.Length); return;
      case 0x00B1: {
        long s = (long)m.WParam, e = (long)m.LParam;
        if (e == -1 || e > Last) e = Last;
        if (s < 0 || s > Last) s = Last;
        if (Mode == "partial" && s == 0 && e == Last && e > 0) e--;
        Start = (int)Math.Min(s, e); End = (int)e; m.Result = IntPtr.Zero; return;
      }
      case 0x00B0: m.Result = new IntPtr(Start | (End << 16)); return;
      case 0x0100:
        if ((int)m.WParam == 0x2E && Start == 0 && End == Last && Mode != "protected") { Content = ""; Start = End = 0; }
        m.Result = IntPtr.Zero; return;
      case 0x0102: {
        Chars++;
        char c = (char)(int)m.WParam;
        Content += c == '\\r' ? "\\r\\n" : c.ToString();
        Start = End = Last; m.Result = IntPtr.Zero; return;
      }
    }
    base.WndProc(ref m);
  }
}
'@
Import-Functions 'input.ps1' @('New-ActionResult', 'Get-VerifiedEffect', 'Background-Unavailable', 'Native-BackgroundFailure',
  'Test-SameValue', 'ConvertTo-TypedLineBreaks', 'Write-ValueByKeys', 'Read-ValueUntil', 'Test-IgnoredValueWrite',
  'Test-TargetWindow', 'Do-SetValue')
function Get-RefRecord($ref) { return @{ Kind = 'uia'; Element = $script:Element; WindowId = 'hwnd:fixture' } }
function Get-RefTopHandle($record) { return $form.Handle }
function Get-TopWindowId($el) { return 'hwnd:fixture' }
function Get-ExactNativeElementHandle($el) { return $script:Element.Value.Owner.Handle }
function Test-BackgroundKeyboardRoute($top, $preferred) { return $true }
function Assert-ExecutionAuthorization($req, $target) {}
function Select-OwningItemAlone($el) { return $null }
$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(-3000, -3000)
# A label keeps window text but has no selection: it ignores the selection messages.
$label = New-Object System.Windows.Forms.Label -Property @{ Text = 'label-before'; Top = 10 }
$edit = New-Object System.Windows.Forms.TextBox -Property @{ Text = 'edit-before'; Top = 40; Multiline = $true; Height = 60 }
$rich = New-Object System.Windows.Forms.RichTextBox -Property @{ Text = "rich line one\`nrich line two\`nthree"; Top = 110; Height = 60 }
$units = New-Object UnitsEditor -Property @{ Top = 180 }
$partial = New-Object UnitsEditor -Property @{ Top = 210; Mode = 'partial'; Start = 2; End = 4 }
$protected = New-Object UnitsEditor -Property @{ Top = 240; Mode = 'protected' }
foreach ($control in @($label, $edit, $rich, $units, $partial, $protected)) { $form.Controls.Add($control) }
$form.CreateControl()
[void][FixtureWindow]::ShowWindow($form.Handle, 4)
$rows = [ordered]@{}
try {
  # The keyboard proof fails on a label (it has no selection): only selection
  # messages were sent, the text is intact, and the caller may write another way.
  $result = Write-ValueByKeys 'k1' (New-Object ControlValue -Property @{ Owner = $label }) $form.Handle $label.Handle 'written'
  $rows.labelKeys = @{ fallback = ($null -eq $result); text = $label.Text }
  # Through Do-SetValue on a remembered window: the accessibility write runs once, as on HEAD.
  Register-ValueWriteActivation $form.Handle
  $script:Element = New-Object ControlElement -Property @{ Value = (New-Object ControlValue -Property @{ Owner = $label }) }
  $result = Do-SetValue 'k1' 'written'
  $rows.label = @{ path = $result.path; verified = $result.verified; setValue = $script:Element.Value.SetValueCalls; text = $label.Text }
  # Select-all stops short: no Delete, and the selection the control had is put back.
  $result = Write-ValueByKeys 'k5' (New-Object ControlValue -Property @{ Owner = $partial }) $form.Handle $partial.Handle 'x'
  $rows.partial = @{ fallback = ($null -eq $result); text = $partial.Content; start = $partial.Start; end = $partial.End; chars = $partial.Chars }
  # Delete refused on a proven selection: nothing typed into what is left.
  $result = Write-ValueByKeys 'k6' (New-Object ControlValue -Property @{ Owner = $protected }) $form.Handle $protected.Handle 'x'
  $rows.protected = @{ path = $result.path; verified = $result.verified; may = $result.input_may_have_executed; text = $protected.Content; chars = $protected.Chars }
  foreach ($case in @(@{ name = 'bareCr'; text = "a\`rb" }, @{ name = 'crLf'; text = "a\`r\`nb" })) {
    $edit.Text = 'edit-before'
    $result = Write-ValueByKeys 'k2' (New-Object ControlValue -Property @{ Owner = $edit }) $form.Handle $edit.Handle $case.text
    $rows[$case.name] = @{ path = $result.path; verified = $result.verified; text = $edit.Text }
  }
  $result = Write-ValueByKeys 'k3' (New-Object ControlValue -Property @{ Owner = $rich }) $form.Handle $rich.Handle "new one\`r\`nnew two"
  $rows.rich = @{ path = $result.path; verified = $result.verified; code = $result.code; text = $rich.Text; class = $rich.GetType().Name }
  $result = Write-ValueByKeys 'k4' (New-Object ControlValue -Property @{ Owner = $units }) $form.Handle $units.Handle "x\`r\`ny"
  $rows.units = @{ path = $result.path; verified = $result.verified; code = $result.code; text = $units.Content; lengthReplies = $units.LengthReplies }
}
finally { $form.Dispose() }
$rows | ConvertTo-Json -Compress
`);
    assert.equal(rows.labelKeys.fallback, true);
    assert.equal(rows.labelKeys.text, 'label-before', 'nothing was deleted or typed');
    assert.equal(rows.label.path, 'uia_value');
    assert.equal(rows.label.setValue, 1);
    assert.equal(rows.label.verified, true);
    assert.equal(rows.label.text, 'written');
    assert.deepEqual(rows.partial, { fallback: true, text: 'first\r\nsecond', start: 2, end: 4, chars: 0 });
    assert.equal(rows.protected.path, 'win32_message');
    assert.equal(rows.protected.verified, false);
    assert.equal(rows.protected.may, true);
    assert.equal(rows.protected.text, 'first\r\nsecond');
    assert.equal(rows.protected.chars, 0, 'nothing typed');
    for (const name of ['bareCr', 'crLf']) {
      assert.equal(rows[name].path, 'win32_message', name);
      assert.equal(rows[name].verified, true, name);
      assert.equal(rows[name].text, 'a\r\nb', name);
    }
    // A real RichEdit with several lines: the proof holds in its selection units.
    assert.equal(rows.rich.code, null, JSON.stringify(rows.rich));
    assert.equal(rows.rich.verified, true, JSON.stringify(rows.rich));
    assert.equal(rows.rich.text, 'new one\nnew two');
    // Text length and selection count line breaks differently: the proof uses
    // only selection positions, so it passes and never asks for the length.
    assert.equal(rows.units.verified, true, JSON.stringify(rows.units));
    assert.equal(rows.units.text, 'x\r\ny');
    assert.equal(rows.units.lengthReplies, 0);
  }
);

test('foreground type into a remembered window is unchanged', windows, async () => {
  const row = await runFixture(`${VALUE_FIXTURE}
Import-Functions 'runtime.ps1' @('Do-Type')
$script:MaximumForegroundTextCharacters = 1000
function Resolve-WindowInfo($title, $id) { return @{ Handle = [IntPtr]1 } }
function Invoke-ForegroundInput($target, $action, [scriptblock]$body) { & $body; return @{ path = 'foreground_input' } }
function Focus-TypingPoint($req, $target, $point) {}
function Report-TypingPoint($req, $point) {}
[MixWin32]::Element = New-Object FakeElement
[MixWin32]::Sent.Clear()
Register-ValueWriteActivation ([IntPtr]1)
$result = Do-Type @{ delivery = 'foreground'; window_id = 'hwnd:0x1'; text = 'abc' }
@{ path = $result.path; sent = @([MixWin32]::Sent); setValue = [MixWin32]::Element.Value.SetValueCalls } | ConvertTo-Json -Compress
`);
  assert.equal(row.path, 'foreground_input');
  assert.deepEqual(row.sent, ['foreground:abc']);
  assert.equal(row.setValue, 0);
});
