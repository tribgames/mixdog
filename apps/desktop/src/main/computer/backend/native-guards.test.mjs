import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { RESPONSE_MARKER, powershellHostProgram } from './program.ts';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';
import { PS_AUTHORIZATION } from './ps-authorization.ts';
import { PS_INPUT } from './ps-input.ts';
import { PS_RUNTIME } from './ps-runtime.ts';

const exec = promisify(execFile);
async function isolatedProgram(script, files = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-native-guards-'));
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
        env: { ...process.env, AUDIT_DIRECTORY: directory },
      }
    );
    return stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('resident native program parses and its C# compiles without touching the desktop', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:AUDIT_DIRECTORY 'host.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'native.cs')))
[Console]::WriteLine('compiled')
`,
    { 'host.ps1': powershellHostProgram(), 'native.cs': MIXDOG_HOST_CSHARP }
  );
  assert.equal(output, 'compiled');
});

test('close requests do not time out on slow shutdown or force a cancelled close', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'native.cs')))
Add-Type -ReferencedAssemblies @('System.dll','System.Windows.Forms.dll') -TypeDefinition @'
using System;
using System.Threading;
using System.Windows.Forms;
public sealed class CloseFixture : NativeWindow, IDisposable {
    readonly bool cancel;
    readonly Thread thread;
    readonly ManualResetEvent ready = new ManualResetEvent(false);
    public readonly ManualResetEvent received = new ManualResetEvent(false);
    public readonly ManualResetEvent finished = new ManualResetEvent(false);
    public IntPtr Target;
    public CloseFixture(bool cancel) {
        this.cancel = cancel;
        thread = new Thread(delegate() {
            CreateHandle(new CreateParams { Caption = "Mixdog hidden close fixture" });
            Target = Handle;
            ready.Set();
            Application.Run();
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        if (!ready.WaitOne(5000)) throw new Exception("fixture did not start");
    }
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x0010) {
            received.Set();
            if (!cancel) {
                Thread.Sleep(1600);
                DestroyHandle();
                Application.ExitThread();
            }
            finished.Set();
            return;
        }
        if (message.Msg == 0x8001) {
            DestroyHandle();
            Application.ExitThread();
            return;
        }
        base.WndProc(ref message);
    }
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    public void Dispose() {
        if (thread.IsAlive) PostMessage(Target, 0x8001, IntPtr.Zero, IntPtr.Zero);
        if (!thread.Join(5000)) throw new Exception("fixture did not stop");
        ready.Dispose();
        received.Dispose();
        finished.Dispose();
    }
}
'@
$slow = [CloseFixture]::new($false)
$cancelled = [CloseFixture]::new($true)
try {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $accepted = [MixWin32]::CloseWindow($slow.Target)
    $timer.Stop()
    $elapsed = $timer.ElapsedMilliseconds
    if (-not $slow.finished.WaitOne(5000)) { throw 'slow close did not finish' }
    $cancelAccepted = [MixWin32]::CloseWindow($cancelled.Target)
    if (-not $cancelled.finished.WaitOne(5000)) { throw 'cancelled close was not handled' }
    @{
        accepted = $accepted
        elapsed = $elapsed
        closed = -not [MixWin32]::IsWindowHandle($slow.Target)
        cancelAccepted = $cancelAccepted
        cancelledStillOpen = [MixWin32]::IsWindowHandle($cancelled.Target)
        invalidAccepted = [MixWin32]::CloseWindow([IntPtr]::Zero)
    } | ConvertTo-Json -Compress
} finally {
    $slow.Dispose()
    $cancelled.Dispose()
}
`,
    { 'native.cs': MIXDOG_HOST_CSHARP }
  );
  const result = JSON.parse(output);
  assert.equal(result.accepted, true);
  assert.ok(result.elapsed < 1000, 'dispatch must not wait for the slow close handler');
  assert.equal(result.closed, true);
  assert.equal(result.cancelAccepted, true);
  assert.equal(result.cancelledStillOpen, true);
  assert.equal(result.invalidAccepted, false);
});

test('MSAA roles map to the control types their oleacc constants name, and editing keys carry their character', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'native.cs')))
$roles = [ordered]@{}
foreach ($role in 0x14, 0x1E, 0x25, 0x26, 0x2B, 0x2F, 0x39, 0x3C, 0x7F) { $roles[[string]$role] = [MixMsaa]::ControlTypeForRole([uint32]$role) }
$keys = [ordered]@{}
foreach ($vk in 0x08, 0x09, 0x0D, 0x1B, 0x20, 0x41, 0x25) { $keys[[string]$vk] = [int][MixWin32]::TranslatedKeyCharacter([uint16]$vk) }
[Console]::WriteLine((@{ roles = $roles; keys = $keys; tk = [MixWin32]::ReceivesTranslatedCharacter('TkChild'); edit = [MixWin32]::ReceivesTranslatedCharacter('Edit') } | ConvertTo-Json -Compress))
`,
    { 'native.cs': MIXDOG_HOST_CSHARP }
  );
  const result = JSON.parse(output);
  assert.deepEqual(result.roles, {
    20: 'Group',
    30: 'Hyperlink',
    37: 'TabItem',
    38: 'Pane',
    43: 'Button',
    47: 'ComboBox',
    57: 'Button',
    60: 'Tab',
    127: 'Custom',
  });
  // Backspace, Tab, Enter, Escape and Space make a character; letters and arrows do not.
  assert.deepEqual(result.keys, { 8: 8, 9: 9, 13: 13, 27: 27, 32: 32, 65: 0, 37: 0 });
  assert.equal(result.tk, false);
  assert.equal(result.edit, true);
});

test('native typing retains a completed preparatory click when text input is unsupported', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference = 'Stop'
foreach ($source in @('input.ps1','runtime.ps1')) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $env:AUDIT_DIRECTORY $source), [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw 'fixture source did not parse' }
  foreach ($name in @('New-ActionResult','Background-Unavailable','Native-BackgroundFailure','Do-Type')) {
    $node = $ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name}, $true)
    if ($null -ne $node) { . ([scriptblock]::Create($node.Extent.Text)) }
  }
}
Add-Type @'
using System;
public static class MixWin32 {
  public static int Clicks;
  public static int Scopes;
  public static string WindowId(IntPtr target) { return "hwnd:0x1"; }
  public static object BeginInactive(IntPtr target) { Scopes++; return new object(); }
  public static void EndInactive(object scope) { Scopes--; }
  public static string BackgroundPointer(IntPtr target, int x, int y, string action, string modifiers) {
    Clicks++; return "hwnd:0x1";
  }
  public static string BackgroundText(IntPtr target, IntPtr preferred, string text) {
    throw new InvalidOperationException("background_unsupported|renderer rejected text; no text sent");
  }
}
'@
function Resolve-WindowInfo($window, $id) { return @{ Handle=[IntPtr]1; Id='hwnd:0x1' } }
function Get-ObservableTargetState($record, $action) { return $null }
function Assert-ExecutionAuthorization($req, $target) {}
$rows = @()
foreach ($point in @($false, $true)) {
  [MixWin32]::Clicks = 0
  $request = @{action='type';window_id='hwnd:0x1';delivery='background';text='fixture'}
  if ($point) { $request.x=10; $request.y=20 }
  $result = Do-Type $request
  $rows += @{clicks=[MixWin32]::Clicks;result=$result}
}
$rows | ConvertTo-Json -Compress -Depth 6
`,
    { 'input.ps1': PS_INPUT, 'runtime.ps1': PS_RUNTIME }
  );
  const rows = JSON.parse(output);
  assert.equal(rows[0].clicks, 0);
  assert.equal(rows[0].result.delivery_accepted, false);
  assert.notEqual(rows[0].result.input_may_have_executed, true);
  assert.equal(rows[1].clicks, 1);
  assert.equal(rows[1].result.code, 'background_unsupported');
  assert.equal(rows[1].result.delivery_accepted, null);
  assert.equal(rows[1].result.input_may_have_executed, true);
});

test('native authority and drag endpoint guards reject before any desktop effect', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
public class AuditWindow { public long Pid = 123; }
public class MixWin32 {
  public static IntPtr ParseWindowId(string value) { return value == "hwnd:0x1" ? new IntPtr(1) : IntPtr.Zero; }
  public static AuditWindow Info(IntPtr value) { return new AuditWindow(); }
  public static IntPtr WindowAtPoint(int x, int y) { return new IntPtr(x > 50 ? 2 : 1); }
  public static bool IsOwnedBy(IntPtr a, IntPtr b) { return false; }
  public static bool IsContainedSameProcess(IntPtr a, IntPtr b) { return false; }
}
"@
. ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'authorization.ps1'))))
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:AUDIT_DIRECTORY 'input.ps1'), [ref]$tokens, [ref]$errors)
foreach ($name in @('Test-AllowedPointTarget','Assert-DragPointTargets')) {
  $function = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
  . ([scriptblock]::Create($function.Extent.Text))
}
$results = @()
foreach ($mode in @('expired','process','endpoint','allowed')) {
  $req = @{
    window_id='hwnd:0x1'; authorization_window_id='hwnd:0x1'; authorization_pid=123
    authorization_expires_at=[DateTimeOffset]::UtcNow.AddMinutes(1).ToUnixTimeMilliseconds()
    allowed_window_ids=@('hwnd:0x1')
  }
  if ($mode -eq 'expired') { $req.authorization_expires_at=0 }
  if ($mode -eq 'process') { $req.authorization_pid=999 }
  $sent=$false; $failure=''
  try {
    $endX=if ($mode -eq 'endpoint') {90} else {20}
    Assert-DragPointTargets $req ([IntPtr]1) 10 10 $endX 20
    $sent=$true
  } catch { $failure=$_.Exception.Message }
  $results += @{mode=$mode; sent=$sent; error=$failure}
}
$results | ConvertTo-Json -Compress
`,
    { 'authorization.ps1': PS_AUTHORIZATION, 'input.ps1': PS_INPUT }
  );
  const rows = JSON.parse(output);
  assert.deepEqual(
    rows.map((row) => row.sent),
    [false, false, false, true]
  );
  assert.match(rows[0].error, /policy_expired/);
  assert.match(rows[1].error, /policy_denied/);
  assert.match(rows[2].error, /target_mismatch/);
});

test('every background scroll route re-checks authorization against its exact target before any wheel message', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:AUDIT_DIRECTORY 'input.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'fixture source did not parse' }
foreach ($name in @('New-ActionResult','Background-Unavailable','Native-BackgroundFailure','Do-Scroll')) {
  $node = $ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name}, $true)
  . ([scriptblock]::Create($node.Extent.Text))
}
Add-Type @'
using System;
public static class MixWin32 {
  public static int Wheels;
  public static string WindowId(IntPtr target) { return "hwnd:0x" + target.ToInt64(); }
  public static string BackgroundWheel(IntPtr target, int x, int y, int clicks, string modifiers, bool horizontal) {
    Wheels++; return WindowId(target);
  }
}
'@
function Resolve-WindowInfo($window, $id) { return @{ Handle=[IntPtr]1; Id='hwnd:0x1'; X=0; Y=0; Width=100; Height=100 } }
function Get-RefRecord($ref) { return @{ Kind='msaa'; WindowId='hwnd:0x3' } }
function Get-ElPoint($ref, $requireTopmost) { return @(10, 20, [IntPtr]3) }
function Get-ObservableTargetState($record, $action) { return $null }
$script:authorized = @()
function Assert-ExecutionAuthorization($req, $target) {
  $script:authorized += [long]$target
  throw 'computer_policy_denied: native target is outside the authorization'
}
$rows = @()
foreach ($request in @(
  @{action='scroll';direction='down';delivery='background';window_id='hwnd:0x1';x=5;y=6},
  @{action='scroll';direction='down';delivery='background';ref='s1:e0'},
  @{action='scroll';direction='down';delivery='background';window_id='hwnd:0x1'}
)) {
  [MixWin32]::Wheels = 0
  $result = Do-Scroll $request
  $rows += @{ wheels=[MixWin32]::Wheels; accepted=$result.delivery_accepted; text=[string]$result.text }
}
@{ rows=$rows; authorized=$script:authorized } | ConvertTo-Json -Compress -Depth 4
`,
    { 'input.ps1': PS_INPUT }
  );
  const result = JSON.parse(output);
  // Coordinate, ref and whole-window routes each name their own exact target.
  assert.deepEqual(result.authorized, [1, 3, 1]);
  for (const row of result.rows) {
    assert.equal(row.wheels, 0, 'no wheel message may precede the authorization check');
    assert.match(row.text, /policy_denied/);
  }
});

test('all foreground native actions keep one intervention scope even on failure, while reads do not acquire one', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference = 'Stop'
Add-Type @"
public static class MixInputObservation {
  public static int Depth;
  public static int Starts;
  public static int Ends;
  public static void Begin() { Depth++; Starts++; }
  public static void End() { Depth--; Ends++; }
}
"@
function Get-SessionState($id) { return @{} }
function Assert-ExecutionAuthorization($req) {}
function Do-Drag($req) {
  if ([MixInputObservation]::Depth -ne 1) { throw 'scope_missing' }
  throw 'user_input_active: fixture interruption'
}
function Do-ListWindows { return @{text='fixture'} }
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:AUDIT_DIRECTORY 'runtime.ps1'), [ref]$tokens, [ref]$errors)
$function = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Handle'}, $true)
. ([scriptblock]::Create($function.Extent.Text))
$caught = ''
try { Handle @{action='drag';delivery='foreground';session_id='fixture'} } catch { $caught=$_.Exception.Message }
if ($caught -ne 'user_input_active: fixture interruption') { throw $caught }
$null = Handle @{action='list_windows';delivery='foreground';session_id='fixture';read_only=$true}
if ([MixInputObservation]::Depth -ne 0 -or [MixInputObservation]::Starts -ne 1 -or [MixInputObservation]::Ends -ne 1) {
  throw 'input scope leaked or read acquired an input scope'
}
[Console]::WriteLine('scoped')
`,
    { 'runtime.ps1': PS_RUNTIME }
  );
  assert.equal(output, 'scoped');
});

test('foreground feedback reports completed theme restoration and restores on body failure', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public static class MixInputObservation {
  public static int Depth;
  public static Action DispatchAuthorization;
  public static void Begin() { Depth++; }
  public static void AssertContinue() { if (DispatchAuthorization != null) DispatchAuthorization(); }
  public static void End() { Depth--; }
}
public sealed class MixCursorThemeReservation : IDisposable {
  public static int Dropped;
  public void Dispose() { Dropped++; }
}
public sealed class MixCursorTheme : IDisposable {
  public static int Restores;
  public static Action Prepared;
  public static bool LastDecorate;
  public static MixCursorThemeReservation Reserve() { return new MixCursorThemeReservation(); }
  public static MixCursorTheme Complete(MixCursorThemeReservation reservation, bool decorate) {
    LastDecorate = decorate; if (Prepared != null) Prepared(); return new MixCursorTheme();
  }
  public static MixCursorTheme Begin(bool decorate) { return Complete(Reserve(), decorate); }
  public void Dispose() { Restores++; }
}
public class PointValue { public int x,y; }
public static class MixWin32 {
  public static int X=10;
  public static PointValue Cursor() { return new PointValue {x=X,y=20}; }
  public static IntPtr Foreground() { return new IntPtr(1); }
  public static bool Focus(IntPtr target) { return true; }
  public static bool IsWindowHandle(IntPtr target) { return target != IntPtr.Zero; }
  public static string WindowId(IntPtr target) { return "hwnd:0x1"; }
  public static int LastInjectionTick { get { return 1; } }
  public static void NoteInjection() {}
}
'@
. (Join-Path $env:AUDIT_DIRECTORY 'input.ps1')
$script:state=@{LastFocus=[IntPtr]1}
$script:CurrentRequest=@{}
function Get-CurrentSession { return $script:state }
function Wait-UserInputIdle { return 0 }
function Assert-ExecutionAuthorization($req,$target) {}
$result=Invoke-ForegroundInput ([IntPtr]1) 'click' { [MixWin32]::X=30 }
# A pointer action blanks the system cursor so the overlay arrow is the only one.
if (-not [MixCursorTheme]::LastDecorate -or -not $result.cursor_feedback.system_theme_applied -or
    -not $result.cursor_feedback.system_theme_restored -or
    -not $result.cursor_feedback.pointer_moved) { throw 'feedback did not reflect completed action lifecycle' }
try { Invoke-ForegroundInput ([IntPtr]1) 'click' { throw 'fixture failure' }; throw 'missing failure' } catch {
  if ($_.Exception.Message -ne 'fixture failure') { throw }
}
if ([MixCursorTheme]::Restores -ne 2 -or [MixInputObservation]::Depth -ne 0) { throw 'theme or intervention scope leaked' }
# Key/type never replace the user's cursor artwork, while the watchdog still
# guards the input this session owns.
$keyFeedback=(Invoke-ForegroundInput ([IntPtr]1) 'key' { }).cursor_feedback
if ([MixCursorTheme]::LastDecorate -or $keyFeedback.system_theme_applied -or
    $keyFeedback.system_theme_restored) { throw 'input must not replace the user cursor artwork' }
$script:expired=$false
$script:sent=$false
function Assert-ExecutionAuthorization($req,$target) {
  if ($script:expired) { throw 'computer_policy_expired: fixture authority expired during preparation' }
}
[MixCursorTheme]::Prepared = [Action] { $script:expired=$true }
try { Invoke-ForegroundInput ([IntPtr]1) 'key' { $script:sent=$true }; throw 'missing expiry refusal' } catch {
  if ($_.Exception.ToString() -notmatch 'computer_policy_expired') { throw }
}
if ($script:sent -or [MixInputObservation]::Depth -ne 0 -or
    $null -ne [MixInputObservation]::DispatchAuthorization -or [MixCursorTheme]::Restores -ne 4) {
  throw 'expired authority dispatched input or leaked its cleanup scope'
}
if ([MixCursorThemeReservation]::Dropped -ne 0) { throw 'a consumed watchdog reservation was dropped as unused' }
[Console]::WriteLine('FEEDBACK_RESTORED')
`,
    { 'input.ps1': PS_INPUT }
  );
  assert.equal(output, 'FEEDBACK_RESTORED');
});

test('a foreground refusal before any input hands the blanked cursor straight back', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public static class MixInputObservation {
  public static Action DispatchAuthorization;
  public static void Begin() {}
  public static void AssertContinue() { if (DispatchAuthorization != null) DispatchAuthorization(); }
  public static void End() {}
}
public sealed class MixCursorThemeReservation : IDisposable { public void Dispose() {} }
public sealed class MixCursorTheme : IDisposable {
  public static int Restores;
  public bool Expired;
  public static MixCursorThemeReservation Reserve() { return new MixCursorThemeReservation(); }
  public static MixCursorTheme Complete(MixCursorThemeReservation reservation, bool decorate) { return new MixCursorTheme(); }
  public static MixCursorTheme Begin(bool decorate) { return new MixCursorTheme(); }
  public void Dispose() { Restores++; }
}
public class PointValue { public int x,y; }
public static class MixWin32 {
  public static PointValue Cursor() { return new PointValue {x=10,y=20}; }
  public static IntPtr Foreground() { return new IntPtr(1); }
  public static bool Focus(IntPtr target) { return true; }
  public static bool IsWindowHandle(IntPtr target) { return target != IntPtr.Zero; }
  public static string WindowId(IntPtr target) { return "hwnd:0x1"; }
  public static int LastInjectionTick { get { return 1; } }
  public static void NoteInjection() {}
}
'@
. (Join-Path $env:AUDIT_DIRECTORY 'input.ps1')
$script:state=@{LastFocus=[IntPtr]1}
$script:CurrentRequest=@{hold_pointer=$true}
function Get-CurrentSession { return $script:state }
function Wait-UserInputIdle { return 0 }
function Assert-ExecutionAuthorization($req,$target) {}
function Refuse { throw 'element e1 is covered by another window at its click point' }
# Nothing held yet: the refused click leaves the user's own cursor on screen.
try { Invoke-ForegroundInput ([IntPtr]1) 'click' { Refuse }; throw 'missing refusal' } catch {
  if ($_.Exception.Message -notmatch 'covered') { throw }
}
if ($null -ne $script:state.CursorTheme -or [MixCursorTheme]::Restores -ne 1) { throw 'a refused click kept the cursor blanked' }
# Input that ran keeps the hold for the session's next command.
$null = Invoke-ForegroundInput ([IntPtr]1) 'click' { }
if ($null -eq $script:state.CursorTheme -or [MixCursorTheme]::Restores -ne 1) { throw 'dispatched input did not hold the cursor' }
# A later refusal neither ends nor replaces the hold an earlier action began.
$held = $script:state.CursorTheme
try { Invoke-ForegroundInput ([IntPtr]1) 'click' { Refuse }; throw 'missing refusal' } catch {
  if ($_.Exception.Message -notmatch 'covered') { throw }
}
if (-not [object]::ReferenceEquals($held, $script:state.CursorTheme) -or [MixCursorTheme]::Restores -ne 1) {
  throw 'a refusal disturbed the held cursor'
}
[Console]::WriteLine('REFUSAL_RESTORED')
`,
    { 'input.ps1': PS_INPUT }
  );
  assert.equal(output, 'REFUSAL_RESTORED');
});

test('session restore sends focus home only to a window the user can still see', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public class Evidence { public bool Ready = true; public string Generation = "monitor-a"; public long Sequence = 0; }
public static class MixInputObservation {
  public static Evidence Read() { return new Evidence(); }
  public static void BeginExpected(string monitor, long sequence) {}
  public static void End() {}
}
public class PointValue { public int x,y; }
public class WindowState { public bool Visible; public bool Cloaked; public bool Minimized; }
public static class MixWin32 {
  public static bool HomeVisible;
  public static int Focused;
  public static int X, Y;
  public static IntPtr ParseWindowId(string id) { return new IntPtr(Convert.ToInt64(id.Substring(7), 16)); }
  public static bool IsWindowHandle(IntPtr h) { return h != IntPtr.Zero; }
  public static IntPtr Foreground() { return new IntPtr(1); }
  public static bool IsOwnedBy(IntPtr window, IntPtr owner) { return false; }
  public static WindowState Info(IntPtr h) { return new WindowState { Visible = HomeVisible, Cloaked = !HomeVisible }; }
  public static bool Focus(IntPtr h) { Focused++; return true; }
  public static bool SetCursorPos(int x, int y) { X = x; Y = y; return true; }
  public static PointValue Cursor() { return new PointValue { x = X, y = Y }; }
  public static string WindowId(IntPtr h) { return "hwnd:0x" + h.ToInt64().ToString("x"); }
  public static long InputTick() { return 0; }
}
'@
function Get-PhysicalInputIdleMs { return 0 }
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:AUDIT_DIRECTORY 'runtime.ps1'), [ref]$tokens, [ref]$errors)
foreach ($name in @('Restore-InputRecoveryState', 'Assert-RecoveryInputUnchanged', 'Test-VisibleFocusHome')) {
  $function = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
  . ([scriptblock]::Create($function.Extent.Text))
}
$request = @{
  window_id = 'hwnd:0x1'; held_window_ids = @('hwnd:0x1'); restore_window_id = 'hwnd:0x2'; restore_owner_window_id = ''
  cursor_x = 10; cursor_y = 20; restore_focus = $true
  expected_input_monitor_id = 'monitor-a'; expected_input_user_sequence = 0
}
# The Start menu that held focus when the session began is hidden by now.
$hidden = Restore-InputRecoveryState $request
if ($hidden.restored_target -ne 'unavailable' -or [MixWin32]::Focused -ne 0) { throw 'focus went to a window nobody can see' }
if ([MixWin32]::X -ne 10 -or [MixWin32]::Y -ne 20) { throw 'the pointer stayed away when focus had no home' }
[MixWin32]::HomeVisible = $true
$shown = Restore-InputRecoveryState $request
if ($shown.restored_target -ne 'original' -or [MixWin32]::Focused -ne 1) { throw 'a visible home did not get focus back' }
[Console]::WriteLine('HOME_CHECKED')
`,
    { 'runtime.ps1': PS_RUNTIME }
  );
  assert.equal(output, 'HOME_CHECKED');
});

test('a pointer action that must activate its target dispatches while the prior foreground holds it', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public static class MixInputObservation {
  public static int Depth;
  public static Action DispatchAuthorization;
  public static void Begin() { Depth++; }
  public static void AssertContinue() { if (DispatchAuthorization != null) DispatchAuthorization(); }
  public static void End() { Depth--; }
}
public sealed class MixCursorThemeReservation : IDisposable { public void Dispose() {} }
public sealed class MixCursorTheme : IDisposable {
  public static MixCursorThemeReservation Reserve() { return new MixCursorThemeReservation(); }
  public static MixCursorTheme Complete(MixCursorThemeReservation reservation, bool decorate) { return new MixCursorTheme(); }
  public static MixCursorTheme Begin(bool decorate) { return new MixCursorTheme(); }
  public void Dispose() {}
}
public class PointValue { public int x,y; }
public static class MixWin32 {
  public static IntPtr Front = new IntPtr(2);
  static bool activating;
  static IntPtr holder;
  public static void BeginPointerActivation(IntPtr h) { activating = true; holder = h; }
  public static void EndPointerActivation() { activating = false; holder = IntPtr.Zero; }
  public static bool HoldsForActivation(IntPtr f) { return activating && f == holder; }
  public static bool Activating { get { return activating; } }
  public static PointValue Cursor() { return new PointValue {x=10,y=20}; }
  public static IntPtr Foreground() { return Front; }
  public static bool Focus(IntPtr target) { return false; }
  public static bool IsWindowHandle(IntPtr target) { return target != IntPtr.Zero; }
  public static string WindowId(IntPtr target) { return "hwnd:0x1"; }
  public static int LastInjectionTick { get { return 1; } }
  public static void NoteInjection() {}
}
'@
. (Join-Path $env:AUDIT_DIRECTORY 'input.ps1')
$script:state=@{}
$script:CurrentRequest=@{}
function Get-CurrentSession { return $script:state }
function Get-ForegroundRefusal($action,$target,$req) { return $null }
function Assert-ExecutionAuthorization($req,$target) {}
# The click is the activation, so the window that kept the foreground may hold it until then.
$result=Invoke-ForegroundInput ([IntPtr]1) 'click' { [MixInputObservation]::AssertContinue(); [MixWin32]::Front=[IntPtr]1 } $true
if ($result.path -ne 'foreground_pointer_activation') { throw "unexpected path: $($result.path) $($result.code)" }
# A third window taking the foreground still stops the dispatch.
[MixWin32]::Front=[IntPtr]2
$script:sent=$false
try {
  Invoke-ForegroundInput ([IntPtr]1) 'click' { [MixWin32]::Front=[IntPtr]3; [MixInputObservation]::AssertContinue(); $script:sent=$true } $true
  throw 'missing refusal'
} catch {
  if ($_.Exception.ToString() -notmatch 'foreground_changed') { throw }
}
# Keys never activate by pointer, so a refused focus sends nothing.
[MixWin32]::Front=[IntPtr]2
$keys=Invoke-ForegroundInput ([IntPtr]1) 'key' { $script:sent=$true }
if ($script:sent -or $keys.code -ne 'foreground_unavailable' -or [MixInputObservation]::Depth -ne 0 -or [MixWin32]::Activating) {
  throw 'a refused focus dispatched input or leaked its scope'
}
[Console]::WriteLine('POINTER_ACTIVATION')
`,
    { 'input.ps1': PS_INPUT }
  );
  assert.equal(output, 'POINTER_ACTIVATION');
});

test('the pointer path accepts the window that kept the foreground only while an activation is pending', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const members = MIXDOG_HOST_CSHARP.slice(
    MIXDOG_HOST_CSHARP.indexOf('  static void AssertDragTarget('),
    MIXDOG_HOST_CSHARP.indexOf('/// The foreground twin of BackgroundDragPath')
  );
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public static class DragFixture {
  public static IntPtr Front = new IntPtr(2);
  static IntPtr Foreground() { return Front; }
  static IntPtr WindowAtPoint(int x, int y) { return new IntPtr(1); }
  static bool IsWindowHandle(IntPtr h) { return h != IntPtr.Zero; }
  static bool IsContainedSameProcess(IntPtr a, IntPtr b) { return false; }
${members}
  public static string Check() {
    try { AssertDragTarget(new IntPtr(1), 5, 5); return "ok"; }
    catch (InvalidOperationException e) { return e.Message.Split('|')[0]; }
  }
}
'@
$plain = [DragFixture]::Check()
[DragFixture]::BeginPointerActivation([IntPtr]2)
$holding = [DragFixture]::Check()
[DragFixture]::Front = [IntPtr]3
$third = [DragFixture]::Check()
[DragFixture]::Front = [IntPtr]1
$landed = [DragFixture]::Check()
[DragFixture]::EndPointerActivation()
[DragFixture]::Front = [IntPtr]2
$ended = [DragFixture]::Check()
[Console]::WriteLine("$plain $holding $third $landed $ended")
`
  );
  assert.equal(output, 'target_mismatch ok target_mismatch ok target_mismatch');
});

test('foreground admission names an elevated holder before waiting and refuses an unobservable origin at once', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public class IntegrityValue { public bool Known=true, Higher=true; public string TargetName="High", OwnName="Medium"; }
public class InfoValue { public string Title="Administrator: Terminal"; }
public static class MixWin32 {
  public static IntPtr Front = new IntPtr(2);
  public static IntPtr Foreground() { return Front; }
  public static bool IsWindowHandle(IntPtr target) { return target != IntPtr.Zero; }
  public static string WindowId(IntPtr target) { return "hwnd:0x1"; }
  public static IntegrityValue WindowIntegrity(IntPtr target) { return new IntegrityValue(); }
  public static InfoValue Info(IntPtr target) { return new InfoValue(); }
  public static int PhysicalInputIdleMs(int known, bool hasKnown) { return -1; }
}
'@
. (Join-Path $env:AUDIT_DIRECTORY 'input.ps1')
$script:CurrentRequest=@{}
function Assert-ExecutionAuthorization($req,$target) {}
# The elevated holder is named before any wait, which could only end in the wrong reason.
$elevated = Get-ForegroundRefusal 'click' ([IntPtr]1) @{}
if ($elevated.code -ne 'foreground_unavailable') { throw "elevated holder: $($elevated.code)" }
# An input origin that cannot be observed refuses at once instead of after the idle wait.
[MixWin32]::Front=[IntPtr]1
$clock=[Diagnostics.Stopwatch]::StartNew()
try { $null = Wait-UserInputIdle; throw 'missing refusal' } catch {
  if ($_.Exception.Message -notmatch '^input_observation_unavailable:') { throw }
}
if ($clock.ElapsedMilliseconds -gt 2000) { throw "unobservable origin waited $($clock.ElapsedMilliseconds)ms" }
[Console]::WriteLine('ADMISSION')
`,
    { 'input.ps1': PS_INPUT }
  );
  assert.equal(output, 'ADMISSION');
});

test('focus_window passes the foreground admission and confirms only a settled foreground', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public class IntegrityValue { public bool Known=true, Higher=false; public string TargetName="Medium", OwnName="Medium"; }
public static class MixInputObservation {
  public static int Depth, Asserts;
  public static Action DispatchAuthorization;
  public static void Begin() { Depth++; }
  public static void AssertContinue() { Asserts++; }
  public static void End() { Depth--; }
}
public static class MixWin32 {
  public static IntPtr Front = new IntPtr(2);
  public static IntPtr Settled = new IntPtr(1);
  public static int Focused;
  public static IntPtr Foreground() { return Front; }
  public static bool Focus(IntPtr target) { Focused++; Front = Settled; return true; }
  public static bool IsWindowHandle(IntPtr target) { return target != IntPtr.Zero; }
  public static string WindowId(IntPtr target) { return "hwnd:0x1"; }
  public static IntegrityValue WindowIntegrity(IntPtr target) { return new IntegrityValue(); }
}
'@
. (Join-Path $env:AUDIT_DIRECTORY 'input.ps1')
$script:state=@{}
function Resolve-WindowInfo($window,$id) { return @{ Handle=[IntPtr]1; Id='hwnd:0x1'; Title='Notepad' } }
function Get-CurrentSession { return $script:state }
function Assert-ExecutionAuthorization($req,$target) {}
# Input during the wait refuses focus like any other foreground action.
function Wait-UserInputIdle { return 800 }
$busy = Do-Focus @{ window_id='hwnd:0x1' }
if ($busy.code -ne 'user_input_active' -or [MixWin32]::Focused -ne 0) { throw 'focus was taken after user input' }
function Wait-UserInputIdle { return 0 }
# A window that does not keep the foreground was not focused.
[MixWin32]::Settled=[IntPtr]3
$moved = Do-Focus @{ window_id='hwnd:0x1' }
if ($moved.code -ne 'foreground_changed' -or $null -ne $script:state.LastFocus) { throw "unsettled focus: $($moved.code)" }
[MixWin32]::Front=[IntPtr]2
[MixWin32]::Settled=[IntPtr]1
$done = Do-Focus @{ window_id='hwnd:0x1' }
if ($done.code -or $script:state.LastFocus -ne [IntPtr]1) { throw "focus failed: $($done.code)" }
if ([MixInputObservation]::Depth -ne 0 -or [MixInputObservation]::Asserts -ne 2) { throw 'focus ran outside an observed input scope' }
[Console]::WriteLine('FOCUS_GUARDED')
`,
    { 'input.ps1': PS_INPUT }
  );
  assert.equal(output, 'FOCUS_GUARDED');
});

test('detached watchdog launcher runs with a hidden console and no desktop input', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'native.cs')))
$receipt=Join-Path $env:AUDIT_DIRECTORY 'launched'
$program="[IO.File]::WriteAllText('" + $receipt.Replace("'","''") + "','ready')"
[MixCursorTheme]::LaunchDetachedWatchdog($program)
$clock=[Diagnostics.Stopwatch]::StartNew()
while (-not [IO.File]::Exists($receipt) -and $clock.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 25 }
if (-not [IO.File]::Exists($receipt)) { throw 'detached watchdog did not start' }
[Console]::WriteLine([IO.File]::ReadAllText($receipt))
`,
    { 'native.cs': MIXDOG_HOST_CSHARP }
  );
  assert.equal(output, 'ready');
});

test('background key grammar is completely validated before any target input', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'native.cs')))
$strokes=@([MixWin32]::ParseBackgroundKeys('a{ENTER 2}{{}{}}') | ForEach-Object {
  if ($_.IsCharacter) { 'C' + [int]$_.Character } else { 'K' + $_.Key }
})
if (($strokes -join ',') -ne 'C97,K13,K13,C123,C125') { throw 'wrong parsed key sequence' }
foreach($keys in @('a^c','a{BROKEN}','a{ENTER','a{ENTER 101}')) {
  try {
    [void][MixWin32]::BackgroundKeys([IntPtr]::Zero,[IntPtr]::Zero,$keys)
    throw 'missing preflight rejection'
  } catch {
    if ($_.Exception.ToString() -notmatch 'background_unsupported') { throw }
  }
}
[Console]::WriteLine('BACKGROUND_PREFLIGHT_OK')
`,
    { 'native.cs': MIXDOG_HOST_CSHARP }
  );
  assert.equal(output, 'BACKGROUND_PREFLIGHT_OK');
});

test('native background failures distinguish unsupported preflight from possibly partial delivery', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
. (Join-Path $env:AUDIT_DIRECTORY 'input.ps1')
$results=@()
foreach($code in @('background_unsupported','background_target_hung','background_message_rejected','background_blocked_uipi')) {
  $results+=Native-BackgroundFailure 'key' ([Exception]::new($code + '|fixture failure')) 'hwnd:0x1'
}
[Console]::WriteLine(($results | ConvertTo-Json -Compress -Depth 4))
`,
    { 'input.ps1': PS_INPUT }
  );
  const rows = JSON.parse(output);
  assert.equal(rows[0].delivery_accepted, false);
  assert.notEqual(rows[0].input_may_have_executed, true);
  for (const row of rows.slice(1)) {
    assert.equal(row.delivery_accepted, null);
    assert.equal(row.input_may_have_executed, true);
    assert.equal(row.effect, 'unverifiable');
  }
});

test('background press lifetimes release once after uncertain delivery and preserve cleanup failure', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'native.cs')))
[Console]::WriteLine([ReleaseFixture]::Run())
`,
    {
      'native.cs':
        MIXDOG_HOST_CSHARP +
        `
public static class ReleaseFixture {
  public static string Run() {
    foreach(string scenario in new string[] {"success", "rejected", "press_unknown", "held_failure", "release_failure", "both_fail"}) {
      var events = new System.Collections.Generic.List<string>();
      System.Exception failure = null;
      try {
        MixWin32.WithBackgroundRelease(
          delegate {
            events.Add("press");
            if(scenario == "rejected") throw new MixWin32.BackgroundMessageException("denied", true);
            if(scenario == "press_unknown") throw new System.Exception("timeout");
          },
          delegate { events.Add("held"); if(scenario == "held_failure" || scenario == "both_fail") throw new System.Exception("interrupted"); },
          delegate { events.Add("release"); if(scenario == "release_failure" || scenario == "both_fail") throw new System.Exception("timeout"); });
      } catch(System.Exception error) { failure = error; }
      string actual = System.String.Join(",", events);
      string expected = scenario == "rejected" ? "press" :
        scenario == "press_unknown" ? "press,release" : "press,held,release";
      if(actual != expected) throw new System.Exception(scenario + " " + actual);
      if((scenario == "release_failure" || scenario == "both_fail") && (failure == null || !failure.Message.StartsWith("input_cleanup_unconfirmed:")))
        throw new System.Exception("cleanup failure was hidden");
      if(scenario == "both_fail" && (!failure.InnerException.ToString().Contains("interrupted") || !failure.InnerException.ToString().Contains("timeout")))
        throw new System.Exception("original failure was lost");
      if(scenario != "success" && failure == null) throw new System.Exception("operation failure was hidden");
    }
    return "BACKGROUND_RELEASE_OK";
  }
}
`,
    }
  );
  assert.equal(output, 'BACKGROUND_RELEASE_OK');
});

test('response envelopes keep pointer accounting for failed requests and clear the progress hook', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public static class MixWin32 {
  public static int PointerEventsGenerated;
  public static int PointerEventsFailed;
  public static bool ActivationUnprotected;
  public static Action<int,int,bool,string> PointerProgress;
}
'@
function Invalidate-RefsForRequest($req) {}
function Handle($req) {
  if ($null -eq [MixWin32]::PointerProgress -and $req.pointer_feedback -eq $true) { throw 'progress hook missing during handling' }
  [MixWin32]::PointerEventsGenerated = 3
  [MixWin32]::PointerEventsFailed = 1
  if ($req.action -eq 'fail') { throw 'foreground_changed: fixture interruption' }
  return @{ done = $true }
}
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:AUDIT_DIRECTORY 'runtime.ps1'), [ref]$tokens, [ref]$errors)
$loop=$ast.Find({param($node) $node -is [System.Management.Automation.Language.WhileStatementAst]}, $false)
$lines=@(
  '{"id":1,"action":"fail","pointer_feedback":true}',
  '{"id":2,"action":"ok","pointer_feedback":true}',
  '{"id":3,"action":"fail"}'
)
$__stdin=New-Object System.IO.StringReader(($lines -join [Environment]::NewLine))
. ([scriptblock]::Create($loop.Extent.Text))
if ($null -ne [MixWin32]::PointerProgress) { throw 'progress hook leaked past the request' }
`,
    { 'runtime.ps1': PS_RUNTIME }
  );
  const rows = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(RESPONSE_MARKER))
    .map((line) => JSON.parse(line.slice(RESPONSE_MARKER.length)));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].ok, false);
  assert.match(rows[0].error, /^foreground_changed:/);
  assert.deepEqual(rows[0].pointer_feedback, { generated: 3, failed: 1 });
  assert.equal(rows[1].ok, true);
  assert.deepEqual(rows[1].pointer_feedback, { generated: 3, failed: 1 });
  assert.equal(rows[2].ok, false);
  assert.equal('pointer_feedback' in rows[2], false);
});

test('background cleanup uncertainty reaches the safety guard instead of ordinary mode escalation', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const output = await isolatedProgram(
    `
$ErrorActionPreference='Stop'
. (Join-Path $env:AUDIT_DIRECTORY 'input.ps1')
try {
  Native-BackgroundFailure 'drag' ([Exception]::new('input_cleanup_unconfirmed: release failed')) 'hwnd:0x1'
  throw 'missing safety failure'
} catch {
  if ($_.Exception.Message -notmatch '^input_cleanup_unconfirmed:') { throw }
}
[Console]::WriteLine('CLEANUP_GUARD_OK')
`,
    { 'input.ps1': PS_INPUT }
  );
  assert.equal(output, 'CLEANUP_GUARD_OK');
});
