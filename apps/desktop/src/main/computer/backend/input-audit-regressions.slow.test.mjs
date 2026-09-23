import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import { powershellHostProgram } from './program.ts';

const execute = promisify(execFile);
const windows = { skip: process.platform !== 'win32', timeout: 20_000 };
const directory = await mkdtemp(join(tmpdir(), 'mixdog-input-audit-'));
after(() => rm(directory, { recursive: true, force: true }));
const sourcePath = join(directory, 'backend.ps1');
// Parse the shipped program, not a template with unresolved policy placeholders.
await writeFile(sourcePath, powershellHostProgram(), 'utf8');

async function nativeFixture(body) {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $env:MIXDOG_FIXTURE_INPUT_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'input source did not parse' }
function Import-InputFunction([string]$name) {
  $node = $ast.Find({
    param($candidate)
    $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -eq $name
  }, $true)
  if ($null -eq $node) { throw "input function unavailable: $name" }
  return [scriptblock]::Create($node.Extent.Text)
}
${body}
`;
  const { stdout } = await execute(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, MIXDOG_FIXTURE_INPUT_SOURCE: sourcePath },
    }
  );
  return JSON.parse(stdout.trim());
}

test('terminating a process needs repeated intent and spares a window that still answers', windows, async () => {
  const result = await nativeFixture(`
Add-Type -TypeDefinition @'
using System;
public static class MixWin32 {
  public static bool Responding = true;
  public static bool IsWindowResponding(IntPtr handle) { return Responding; }
  public static bool IsWindowHandle(IntPtr handle) { return true; }
}
'@
function Assert-ExecutionAuthorization($request, $target) { throw 'a refused terminate must stop before authorization' }
function Resolve-WindowInfo($window, $windowId) { return @{ Id = 'hwnd:0x1'; Handle = [IntPtr]1; Pid = 4242 } }
foreach ($name in @('New-ActionResult','Do-TerminateProcess')) { . (Import-InputFunction $name) }
$rows = @()
foreach ($request in @(@{ window_id = 'hwnd:0x1' }, @{ window_id = 'hwnd:0x1'; confirm = 'terminate' })) {
  $reply = Do-TerminateProcess $request
  $rows += @{ message = [string]$reply.text; code = [string]$reply.code; effect = [string]$reply.effect; verified = [bool]$reply.verified }
}
@{ rows = @($rows) } | ConvertTo-Json -Depth 4 -Compress
`);
  // Killing a process has nothing to undo, so both gates refuse before any authorization runs.
  assert.match(result.rows[0].message, /confirm=terminate is required/);
  assert.match(result.rows[1].message, /still answers messages/);
  assert.deepEqual(
    result.rows.map((row) => row.code),
    ['confirmation_required', 'window_still_responding']
  );
  assert.deepEqual(
    result.rows.map((row) => [row.effect, row.verified]),
    [
      ['suspected_noop', false],
      ['suspected_noop', false],
    ]
  );
});

/** A packaged app has only a stub executable, so the name has to reach the
 *  activation route; an unpackaged Start entry goes through its catalogue id, and
 *  anything that names a file or a URL stays with the plain shell. */
async function launchRouting() {
  const routed = await nativeFixture(String.raw`
Add-Type -TypeDefinition @'
using System;
public static class MixWin32 {
  public static string Activated = "";
  public static string Shelled = "";
  public static int ActivateAppId(string appId) { Activated = appId; return 4242; }
  public static int LaunchWithoutActivation(string target) { Shelled = target; return 7; }
}
'@
function Assert-ExecutionAuthorization($request, $target) { }
function Get-StartApps {
  # ASCII names only: the fixture reads this back through the console code page.
  return @(
    [pscustomobject]@{ Name = 'Calculator'; AppID = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
    [pscustomobject]@{ Name = 'Settings hub'; AppID = 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel' },
    [pscustomobject]@{ Name = 'Settings helper'; AppID = 'Microsoft.SettingsHelper_8wekyb3d8bbwe!App' },
    [pscustomobject]@{ Name = 'Notepad++'; AppID = '{6D809377-6AF0-444B-8957-A3773F02200E}\Notepad++\notepad++.exe' },
    [pscustomobject]@{ Name = 'FanControl'; AppID = '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\FanControl\FanControl.exe' }
  )
}
function Import-Module { param([string]$Name, $ErrorAction) }
foreach ($name in @('New-ActionResult','Get-InstalledApps','Find-InstalledApp','Do-Launch','Do-ListInstalledApps')) {
  . (Import-InputFunction $name)
}
$rows = @()
foreach ($target in @('Calculator', 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', 'Notepad++', 'Calc', 'C:\tools\editor.exe', 'https://example.invalid/', 'control.exe')) {
  [MixWin32]::Activated = ''; [MixWin32]::Shelled = ''
  $failure = ''
  $result = $null
  try { $result = Do-Launch $target } catch { $failure = [string]$_.Exception.Message }
  $rows += @{
    target = $target
    failure = $failure
    path = [string]$result.path
    launched = [int]$result.pid
    app_id = [string]$result.app_id
    activated = [MixWin32]::Activated
    shelled = [MixWin32]::Shelled
  }
}
$ambiguous = ''
try { [void](Do-Launch 'Settings') } catch { $ambiguous = [string]$_.Exception.Message }
$catalogue = Do-ListInstalledApps @{ query = 'Calc' }
@{ rows = @($rows); ambiguous = $ambiguous; catalogue = $catalogue.text } | ConvertTo-Json -Depth 5 -Compress
`);
  const byTarget = Object.fromEntries(routed.rows.map((row) => [row.target, row]));
  assert.deepEqual(
    routed.rows.map((row) => row.failure),
    ['', '', '', '', '', '', '']
  );
  // An executable name goes to the shell even when another app's catalogue id
  // ends with it ("...\FanControl\FanControl.exe").
  assert.equal(byTarget['control.exe'].path, 'windows_shell');
  assert.equal(byTarget['control.exe'].shelled, 'control.exe');
  assert.equal(byTarget['control.exe'].app_id, '');
  // An unpackaged Start entry has no plain path to run, so its catalogue id is
  // what makes the name a user says launchable at all.
  const unpackaged = byTarget['Notepad++'];
  assert.equal(unpackaged.path, 'apps_folder');
  assert.equal(
    unpackaged.shelled,
    'shell:AppsFolder\\{6D809377-6AF0-444B-8957-A3773F02200E}\\Notepad++\\notepad++.exe'
  );
  assert.equal(unpackaged.activated, '');
  // "Calc" matches the packaged calculator and nothing else, so it still resolves.
  assert.equal(byTarget.Calc.path, 'app_activation');
  const packaged = byTarget.Calculator;
  assert.equal(packaged.path, 'app_activation');
  // The broker owns the process, so this is the only route that reports the real pid.
  assert.equal(packaged.launched, 4242);
  assert.equal(packaged.app_id, 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App');
  assert.equal(packaged.shelled, '');
  assert.equal(byTarget['Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'].path, 'app_activation');
  for (const target of ['C:\\tools\\editor.exe', 'https://example.invalid/']) {
    assert.equal(byTarget[target].path, 'windows_shell');
    assert.equal(byTarget[target].activated, '');
    assert.equal(byTarget[target].shelled, target);
  }
  // Two installed apps matching one word is a guess, so nothing launches.
  assert.match(routed.ambiguous, /launch failed \[ambiguous_app\/0\]/);
  const catalogue = JSON.parse(routed.catalogue);
  assert.equal(catalogue.catalogue_total, 5);
  assert.deepEqual(
    catalogue.installed.map((entry) => entry.name),
    ['Calculator']
  );
}

test('a launch failure keeps its shell error category through the native wrapper', windows, async () => {
  const result = await nativeFixture(String.raw`
Add-Type -TypeDefinition @'
using System;
public static class MixWin32 {
  public static int Code = 2;
  public static int LaunchWithoutActivation(string target) {
    throw new System.ComponentModel.Win32Exception(Code);
  }
}
'@
function Assert-ExecutionAuthorization($request, $target) { }
. (Import-InputFunction 'New-ActionResult')
. (Import-InputFunction 'Find-InstalledApp')
. (Import-InputFunction 'Do-Launch')
$messages = New-Object System.Collections.ArrayList
foreach ($code in 2, 5, 31, 1223, 87) {
  [MixWin32]::Code = $code
  try { [void](Do-Launch 'C:\mixdog-missing-fixture.exe') }
  catch { [void]$messages.Add([string]$_.Exception.Message) }
}
@{ messages = @($messages) } | ConvertTo-Json -Depth 3 -Compress
`);
  // A native call arrives wrapped, so the category depends on unwrapping it.
  assert.equal(result.messages.length, 5);
  assert.match(result.messages[0], /launch failed \[target_not_found\/2\]/);
  await launchRouting();
  assert.match(result.messages[1], /launch failed \[access_denied\/5\]/);
  assert.match(result.messages[2], /launch failed \[no_file_association\/31\]/);
  assert.match(result.messages[3], /launch failed \[launch_cancelled\/1223\]/);
  assert.match(result.messages[4], /launch failed \[shell_launch_failed\/87\]/);
});

test('background value input skips a browser tab that only echoes the write', windows, async () => {
  const result = await nativeFixture(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
public static class MixWin32 {
  public static bool WebContent = false;
  public static bool IsWebContentHost(IntPtr window) { return WebContent; }
}
'@
$script:HasValuePattern = $true
$element = New-Object psobject
Add-Member -InputObject $element -MemberType NoteProperty -Name Current -Value ([pscustomobject]@{ ClassName = 'Edit' })
Add-Member -InputObject $element -MemberType ScriptMethod -Name TryGetCurrentPattern -Value {
  param($pattern, $target)
  return $script:HasValuePattern
}
function Get-TopWindow($el) { return @{ Current = @{ NativeWindowHandle = 1 } } }
foreach ($name in @('Test-BackgroundValueTarget', 'Test-IgnoredValueWrite')) { . (Import-InputFunction $name) }
$record = @{ Kind = 'uia'; Element = $element }
$native = Test-BackgroundValueTarget $record
[MixWin32]::WebContent = $true
$web = Test-BackgroundValueTarget $record
[MixWin32]::WebContent = $false
$element.Current.ClassName = 'XLSpreadsheetCell'
$excel = Test-BackgroundValueTarget $record
$element.Current.ClassName = 'Edit'
$script:HasValuePattern = $false
$plain = Test-BackgroundValueTarget $record
$msaa = Test-BackgroundValueTarget @{ Kind = 'msaa' }
@{ native = $native; web = $web; excel = $excel; plain = $plain; msaa = $msaa } | ConvertTo-Json -Compress
`);
  assert.equal(result.native, true);
  assert.equal(result.web, false);
  // An Excel cell echoes the write without entering it, like a browser tab.
  assert.equal(result.excel, false);
  assert.equal(result.plain, false);
  assert.equal(result.msaa, true);
});

test('background type reaches a value-settable element without a native keyboard target', windows, async () => {
  const result = await nativeFixture(`
Add-Type -TypeDefinition @'
using System;
public static class MixWin32 {
  public static string WindowId(IntPtr h) { return "hwnd:0x" + h.ToInt64().ToString("x"); }
}
'@
$script:ValueWrites = New-Object System.Collections.ArrayList
$script:Settable = $true
$script:NativeTarget = [IntPtr]::Zero
$script:PostRoute = $false
function Get-RefRecord($ref) { return @{ Kind = 'uia'; Element = 'element'; WindowId = 'hwnd:0x1' } }
function Get-RefTopHandle($record) { return [IntPtr]1 }
function Get-ExactNativeElementHandle($element) { return $script:NativeTarget }
function Test-BackgroundValueTarget($record) { return $script:Settable }
function Test-BackgroundKeyboardRoute($top, $preferred) { return $script:PostRoute }
function Invoke-BackgroundSemantic($ref, [scriptblock]$operation, $effect = 'release') { return & $operation }
function Do-SetValue($ref, $text) {
  [void]$script:ValueWrites.Add($text)
  return New-ActionResult 'set_value' 'uia_value' 'confirmed' $true "set $ref value through UIA; readback=True" $null 'background' 'hwnd:0x1'
}
. (Import-InputFunction 'New-ActionResult')
. (Import-InputFunction 'Background-Unavailable')
. (Import-InputFunction 'Do-Type')
$valued = Do-Type @{ delivery = 'background'; ref = 's1:e1'; text = 'parity' }
$script:NativeTarget = [IntPtr]2
$xamlHost = Do-Type @{ delivery = 'background'; ref = 's1:e1'; text = 'parity' }
$script:NativeTarget = [IntPtr]::Zero
$script:Settable = $false
$refused = Do-Type @{ delivery = 'background'; ref = 's1:e1'; text = 'parity' }
@{
  valued = $valued
  xaml_host = $xamlHost
  refused = $refused
  write_count = $script:ValueWrites.Count
  write_first = [string]$script:ValueWrites[0]
} | ConvertTo-Json -Depth 5 -Compress
`);
  assert.equal(result.valued.action, 'type');
  assert.equal(result.valued.path, 'uia_value');
  assert.equal(result.valued.delivery_accepted, true);
  // A XAML/WinUI host has a native child but drops posted characters.
  assert.equal(result.xaml_host.action, 'type');
  assert.equal(result.xaml_host.path, 'uia_value');
  assert.equal(result.write_count, 2);
  assert.equal(result.write_first, 'parity');
  assert.equal(result.refused.code, 'background_unsupported');
  assert.equal(result.refused.delivery_accepted, false);
  assert.match(result.refused.text, /no settable value/);
});

test(
  'native post-input observation survives a closed dialog without weakening pre-dispatch checks',
  windows,
  async () => {
    const result = await nativeFixture(`
Add-Type -TypeDefinition @'
using System;
public class Info { public string OwnerId = "hwnd:0x2"; }
public class Point { public int X = 10, Y = 20; }
public class Evidence { public bool Ready = true; public string Generation = "monitor"; public int Sequence = 0; }
public static class MixWin32 {
  public static bool TargetExists = true;
  public static bool IsWindowHandle(IntPtr h) { return h == new IntPtr(2) || (h == new IntPtr(1) && TargetExists); }
  public static IntPtr ParseWindowId(string s) { return new IntPtr(s == "hwnd:0x1" ? 1 : 2); }
  public static string WindowId(IntPtr h) { return "hwnd:0x" + h.ToInt64().ToString("x"); }
  public static IntPtr Foreground() { return new IntPtr(2); }
  public static Info Info(IntPtr h) { return new Info(); }
  public static Point Cursor() { return new Point(); }
  public static int InputTick() { return 100; }
  public static bool IsOwnedBy(IntPtr a, IntPtr b) { return false; }
  public static bool IsChildProcessWindow(IntPtr candidate, IntPtr parent) { return false; }
}
public static class MixInputObservation { public static Evidence Read() { return new Evidence(); } }
'@
function Get-CurrentSession { return @{ OriginalFocus = [IntPtr]2; LastFocus = [IntPtr]1 } }
function Resolve-WindowInfo($title, $id) {
  if (-not [MixWin32]::TargetExists) { throw 'window_id is stale or invalid' }
  return @{ Handle = [IntPtr]1 }
}
function Get-PhysicalInputIdleMs { return [int]::MaxValue }
. (Import-InputFunction 'Get-InputRecoveryState')
$before = Get-InputRecoveryState @{ window_id = 'hwnd:0x1' }
[MixWin32]::TargetExists = $false
$rejected = $false
try { Get-InputRecoveryState @{ window_id = 'hwnd:0x1' } | Out-Null } catch { $rejected = $true }
$after = Get-InputRecoveryState @{ window_id = 'hwnd:0x1'; after_input = $true }
@{ before = $before; after = $after; rejected = $rejected } | ConvertTo-Json -Depth 5 -Compress
`);
    assert.equal(result.before.target_owner_window_id, 'hwnd:0x2');
    assert.equal(result.rejected, true);
    assert.equal(result.after.target_exists, false);
    assert.equal(result.after.target_window_id, 'hwnd:0x1');
    assert.equal(result.after.input_observer_ready, true);
    assert.equal(result.after.input_monitor_id, result.before.input_monitor_id);
  }
);

test('menu dispatch stays in its live branch or an owned popup, never another app', windows, async () => {
  const rows = await nativeFixture(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll',
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Windows.Automation;
public sealed class MenuProperties {
  public string Name;
  public bool IsEnabled = true, IsOffscreen;
  public int NativeWindowHandle;
}
public sealed class MenuPattern {
  public MenuPattern Current { get { return this; } }
  public string ExpandCollapseState = "Collapsed";
  public int Window;
  public void Expand() { ExpandCollapseState = "Expanded"; }
  public void Invoke() { MenuAutomation.Invoked.Add(Window); }
}
public sealed class MenuElement {
  public MenuProperties Current = new MenuProperties();
  public List<MenuElement> Children = new List<MenuElement>();
  public bool Expands;
  public MenuElement(string name, int window) { Current.Name = name; Current.NativeWindowHandle = window; }
  public MenuElement[] FindAll(TreeScope scope, Condition condition) {
    var result = new List<MenuElement>();
    foreach (var child in Children) {
      result.Add(child); result.AddRange(child.FindAll(scope, condition));
    }
    return result.ToArray();
  }
  public bool TryGetCurrentPattern(AutomationPattern pattern, out object value) {
    value = null;
    if ((Expands && pattern == ExpandCollapsePattern.Pattern) || (!Expands && pattern == InvokePattern.Pattern)) {
      value = new MenuPattern {Window = Current.NativeWindowHandle}; return true;
    }
    return false;
  }
}
public static class MenuAutomation {
  public static Dictionary<int, MenuElement> Windows = new Dictionary<int, MenuElement>();
  public static List<int> Invoked = new List<int>();
  public static AutomationProperty ControlTypeProperty { get { return AutomationElement.ControlTypeProperty; } }
  public static MenuElement RootElement { get { return Windows[2]; } }
  public static MenuElement FromHandle(IntPtr handle) { return Windows[handle.ToInt32()]; }
  public static void Configure(string mode) {
    Windows.Clear(); Invoked.Clear(); MixWin32.Keys.Clear();
    var root = new MenuElement("target", 1);
    var file = new MenuElement(mode == "localized" ? "File(&F)" : "File", 1) { Expands = true };
    root.Children.Add(file); Windows[1] = root;
    Windows[2] = new MenuElement("foreign", 2);
    Windows[2].Children.Add(new MenuElement("Save", 2));
    if (mode == "owned") {
      Windows[3] = new MenuElement("popup", 3);
      Windows[3].Children.Add(new MenuElement("Save", 3));
    } else if (mode != "missing") {
      var save = new MenuElement(mode == "localized" ? "Save(&S)...\tCtrl+S" : "Save", 1);
      save.Current.IsEnabled = mode != "disabled";
      file.Children.Add(save);
      if (mode == "ambiguous") file.Children.Add(new MenuElement("Save", 1));
    }
  }
}
public static class MixWin32 {
  public static List<string> Keys = new List<string>();
  public static string BackgroundKeys(IntPtr top, IntPtr preferred, string keys) { Keys.Add(keys); return "sent"; }
  public static string[] RelatedWindowIds(IntPtr owner) {
    return MenuAutomation.Windows.ContainsKey(3) ? new [] {"hwnd:0x1","hwnd:0x3"} : new [] {"hwnd:0x1"};
  }
  public static IntPtr ParseWindowId(string value) { return new IntPtr(Convert.ToInt32(value.Substring(7), 16)); }
  public static bool IsOwnedBy(IntPtr candidate, IntPtr owner) { return candidate.ToInt32() == 3 && owner.ToInt32() == 1; }
}
'@
$AE = [MenuAutomation]
$TS = [System.Windows.Automation.TreeScope]
foreach ($name in @('Normalize-MenuLabel','Get-MenuCandidates','Expand-MenuElement','Do-InvokeMenu','New-ActionResult')) {
  . (Import-InputFunction $name)
}
function Resolve-WindowInfo($window,$id) { return @{Handle=[IntPtr]1; Id='hwnd:0x1'} }
function Find-Window($window,$id) { return [MenuAutomation]::FromHandle([IntPtr]1) }
function Get-TopWindow($element) { return $element }
function Get-MsaaMenuCandidates($info,$name) { return @() }
function Invoke-Win32MenuPath($req,$info,$path) { return $null }
function Assert-ExecutionAuthorization($request,$handle) {}
function Invoke-BackgroundWindow($target,$operation) { & $operation }
$rows = @()
foreach ($mode in @('missing','valid','owned','ambiguous','disabled','localized')) {
  [MenuAutomation]::Configure($mode)
  $script:CurrentRequest = @{action='invoke_menu';window_id='hwnd:0x1';path=@('File','Save')}
  $errorText = ''
  try { $null = Do-InvokeMenu $script:CurrentRequest } catch { $errorText = $_.Exception.Message }
  $rows += @{mode=$mode; invoked=@([MenuAutomation]::Invoked.ToArray()); error=$errorText; keys=@([MixWin32]::Keys.ToArray())}
}
$rows | ConvertTo-Json -Compress -Depth 5
`);
  const byMode = Object.fromEntries(rows.map((row) => [row.mode, row]));
  assert.deepEqual(byMode.missing.invoked, []);
  assert.match(byMode.missing.error, /menu_path_not_found/);
  // A walk that opened a level and then failed leaves no menu on screen.
  assert.deepEqual(byMode.missing.keys, ['{ESC}']);
  assert.deepEqual(byMode.valid.invoked, [1]);
  assert.deepEqual(byMode.valid.keys, []);
  // A localized menu shows its access key as "(F)" and its accelerator after a
  // tab; the plain names still reach it.
  assert.equal(byMode.localized.error, '');
  assert.deepEqual(byMode.localized.invoked, [1]);
  assert.deepEqual(byMode.owned.invoked, [3]);
  assert.deepEqual(byMode.owned.keys, []);
  for (const [mode, error] of [
    ['ambiguous', 'menu_path_ambiguous'],
    ['disabled', 'menu_item_disabled'],
  ]) {
    assert.deepEqual(byMode[mode].invoked, []);
    assert.match(byMode[mode].error, new RegExp(error));
    assert.deepEqual(byMode[mode].keys, ['{ESC}']);
  }
});

test('classic menu bars resolve a whole path from their menu handles without opening a menu', windows, async () => {
  const rows = await nativeFixture(String.raw`
Add-Type @'
using System;
using System.Collections.Generic;
public static class MixWin32 {
  public static List<string> Announced = new List<string>();
  public static List<uint> Commands = new List<uint>();
  public sealed class MenuEntry { public string Label; public IntPtr SubMenu; public uint Id; public bool Enabled; }
  static MenuEntry E(string label, int sub, uint id, bool enabled) {
    return new MenuEntry { Label = label, SubMenu = new IntPtr(sub), Id = id, Enabled = enabled };
  }
  public static IntPtr WindowMenu(IntPtr hwnd) { return hwnd.ToInt32() == 1 ? new IntPtr(100) : IntPtr.Zero; }
  public static MenuEntry[] MenuEntries(IntPtr hwnd, IntPtr menu, int position, bool announce) {
    if (announce) Announced.Add(menu.ToInt32() + ":" + position);
    switch (menu.ToInt32()) {
      case 100: return new [] { E("File(&F)", 200, 0, true), E("View(&V)", 300, 0, true) };
      case 200: return new [] { E("&Save\tCtrl+S", 0, 11, true), E("Export...", 0, 12, false) };
      case 300: return new [] { E("Refresh", 0, 21, true), E("Refresh", 0, 22, true) };
      default: return new MenuEntry[0];
    }
  }
  public static void PostMenuCommand(IntPtr hwnd, uint id) { Commands.Add(id); }
}
'@
foreach ($name in @('Normalize-MenuLabel','Invoke-Win32MenuPath','New-ActionResult')) { . (Import-InputFunction $name) }
function Assert-ExecutionAuthorization($request,$handle) {}
$rows = @()
foreach ($case in @(
  @{ window = 1; path = @('File','Save') },
  @{ window = 1; path = @('File','Export') },
  @{ window = 1; path = @('View','Refresh') },
  @{ window = 1; path = @('File') },
  @{ window = 1; path = @('File','Print') },
  @{ window = 1; path = @('Help','About') },
  @{ window = 2; path = @('File','Save') }
)) {
  [MixWin32]::Announced.Clear(); [MixWin32]::Commands.Clear()
  $info = @{ Handle = [IntPtr]$case.window; Id = 'hwnd:0x' + $case.window }
  $reply = $null; $failure = ''
  try { $reply = Invoke-Win32MenuPath @{} $info $case.path } catch { $failure = [string]$_.Exception.Message }
  $rows += @{
    path = ($case.path -join '>') + '@' + $case.window
    route = if ($null -eq $reply) { '' } else { [string]$reply.path }
    failure = $failure
    commands = @([MixWin32]::Commands.ToArray())
    announced = @([MixWin32]::Announced.ToArray())
  }
}
$rows | ConvertTo-Json -Compress -Depth 5
`);
  const byPath = Object.fromEntries(rows.map((row) => [row.path, row]));
  // The localized "(F)", the ampersand and the tabbed accelerator all fall away.
  assert.equal(byPath['File>Save@1'].route, 'win32_menu');
  assert.deepEqual(byPath['File>Save@1'].commands, [11]);
  // Only the submenu is announced; the bar itself never opens.
  assert.deepEqual(byPath['File>Save@1'].announced, ['200:0']);
  assert.match(byPath['File>Export@1'].failure, /^menu_item_disabled/);
  assert.match(byPath['View>Refresh@1'].failure, /^menu_path_ambiguous/);
  assert.match(byPath['File@1'].failure, /^menu_item_not_invokable/);
  assert.match(byPath['File>Print@1'].failure, /^menu_path_not_found: .*; entries: Save, Export\.\.\.$/);
  for (const path of ['File>Export@1', 'View>Refresh@1', 'File@1', 'File>Print@1']) {
    assert.deepEqual(byPath[path].commands, [], path);
  }
  // A path the bar does not start with, or a window without a classic menu,
  // is left to the accessibility route.
  for (const path of ['Help>About@1', 'File>Save@2']) {
    assert.equal(byPath[path].route, '', path);
    assert.equal(byPath[path].failure, '', path);
  }
});

test('a value write inside a multi-selection is scoped to its own item first', windows, async () => {
  const rows = await nativeFixture(String.raw`
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes @'
using System.Collections.Generic;
using System.Windows.Automation;
public class FakeList { public bool Multi = true; public bool Frozen; public List<FakeItem> Selected = new List<FakeItem>(); }
public class FakeContainerCurrent {
  public FakeList List;
  public bool CanSelectMultiple { get { return List.Multi; } }
  public object[] GetSelection() { return List.Selected.ToArray(); }
}
public class FakeContainerPattern { public FakeContainerCurrent Current; }
public class FakeContainer {
  public FakeList List;
  public bool TryGetCurrentPattern(AutomationPattern pattern, out object value) {
    value = null;
    if (pattern != SelectionPattern.Pattern) return false;
    value = new FakeContainerPattern { Current = new FakeContainerCurrent { List = List } };
    return true;
  }
}
public class FakeItemCurrent {
  public FakeItem Item;
  public bool IsSelected { get { return Item.List.Selected.Contains(Item); } }
  public FakeContainer SelectionContainer { get { return new FakeContainer { List = Item.List }; } }
}
public class FakeItemPattern {
  public FakeItem Item;
  public FakeItemCurrent Current { get { return new FakeItemCurrent { Item = Item }; } }
  public void Select() { if (Item.List.Frozen) return; Item.List.Selected.Clear(); Item.List.Selected.Add(Item); }
}
public class FakeItem {
  public string Name; public FakeList List;
  public bool TryGetCurrentPattern(AutomationPattern pattern, out object value) {
    value = null;
    if (pattern != SelectionItemPattern.Pattern) return false;
    value = new FakeItemPattern { Item = this };
    return true;
  }
}
public class FakeField {
  public FakeItem Parent;
  public bool TryGetCurrentPattern(AutomationPattern pattern, out object value) { value = null; return false; }
}
public class FakeWalker { public object GetParent(object element) { var field = element as FakeField; return field == null ? null : field.Parent; } }
'@
. (Import-InputFunction 'Select-OwningItemAlone')
$Walker = New-Object FakeWalker
function Case($label, $multi, $frozen, $withParent) {
  $list = New-Object FakeList
  $list.Multi = $multi; $list.Frozen = $frozen
  $alpha = New-Object FakeItem -Property @{ Name = 'alpha'; List = $list }
  $beta = New-Object FakeItem -Property @{ Name = 'beta'; List = $list }
  $list.Selected.Add($alpha); if ($multi) { $list.Selected.Add($beta) }
  $field = New-Object FakeField
  if ($withParent) { $field.Parent = $beta }
  $scope = Select-OwningItemAlone $field
  return @{ label = $label; scope = [string]$scope; selected = @($list.Selected | ForEach-Object { $_.Name }) }
}
@(
  (Case 'multi' $true $false $true),
  (Case 'frozen' $true $true $true),
  (Case 'single' $false $false $true),
  (Case 'unowned' $true $false $false)
) | ConvertTo-Json -Compress -Depth 4
`);
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  // Two files selected: the written item becomes the only selection first.
  assert.equal(byLabel.multi.scope, '');
  assert.deepEqual(byLabel.multi.selected, ['beta']);
  // A selection that will not narrow blocks the write rather than widening it.
  assert.match(byLabel.frozen.scope, /2 items stay selected/);
  assert.deepEqual(byLabel.frozen.selected, ['alpha', 'beta']);
  // A single-select list and a field outside any item keep their state.
  assert.equal(byLabel.single.scope, '');
  assert.deepEqual(byLabel.single.selected, ['alpha']);
  assert.equal(byLabel.unowned.scope, '');
  assert.deepEqual(byLabel.unowned.selected, ['alpha', 'beta']);
});

test('MSAA menu paths never initialize an unavailable UIA provider', windows, async () => {
  const result = await nativeFixture(`
Add-Type @'
using System.Collections.Generic;
public sealed class MsaaMenuFixture {
  public static List<string> Invoked = new List<string>();
  readonly string name;
  public MsaaMenuFixture(string value) { name = value; }
  public void DoDefaultAction() { Invoked.Add(name); }
}
'@
foreach ($name in @('Do-InvokeMenu','New-ActionResult')) { . (Import-InputFunction $name) }
function Resolve-WindowInfo($window,$id) { return @{Handle=[IntPtr]1;Id='hwnd:0x1'} }
function Invoke-BackgroundWindow($target,$operation) { & $operation }
function Assert-ExecutionAuthorization($request,$handle) {}
$script:uiaCalls = 0
function Find-Window($window,$id) {
  $script:uiaCalls++
  throw 'fixture UIA provider unavailable'
}
function Get-MsaaMenuCandidates($info,$name) { return @([MsaaMenuFixture]::new($name)) }
function Invoke-Win32MenuPath($req,$info,$path) { return $null }
$reply = Do-InvokeMenu @{action='invoke_menu';window_id='hwnd:0x1';path=@('Window','General','Test Runner')}
@{uiaCalls=$script:uiaCalls;invoked=@([MsaaMenuFixture]::Invoked.ToArray());path=$reply.path} |
  ConvertTo-Json -Compress -Depth 5
`);
  assert.equal(result.uiaCalls, 0);
  assert.deepEqual(result.invoked, ['Window', 'General', 'Test Runner']);
  assert.equal(result.path, 'msaa_menu');
});

test('foreground drift during preparation prevents the input body from running', windows, async () => {
  const result = await nativeFixture(`
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
  // The watchdog lease is reserved before the target work and completed just
  // before dispatch, so the stub carries both halves like the real type.
  public static MixCursorThemeReservation Reserve() { return new MixCursorThemeReservation(); }
  public static MixCursorTheme Complete(MixCursorThemeReservation reservation, bool decorate) {
    MixWin32.Current = new IntPtr(2); return new MixCursorTheme();
  }
  public static MixCursorTheme Begin(bool decorate) { return Complete(Reserve(), decorate); }
  public static MixCursorTheme Begin() { return Begin(true); }
  public void Dispose() {}
}
public class FixturePoint { public int x=10, y=20; }
public static class MixWin32 {
  public static IntPtr Current = new IntPtr(1);
  public static bool IsWindowHandle(IntPtr value) { return value != IntPtr.Zero; }
  public static IntPtr Foreground() { return Current; }
  public static bool Focus(IntPtr value) { Current = value; return true; }
  public static string WindowId(IntPtr value) { return "hwnd:0x" + value.ToInt64().ToString("x"); }
  public static FixturePoint Cursor() { return new FixturePoint(); }
  public static int LastInjectionTick=1;
  public static void NoteInjection() {}
}
'@
foreach ($name in @('Invoke-ForegroundInput','New-ActionResult','Acquire-CursorTheme')) { . (Import-InputFunction $name) }
function Wait-UserInputIdle { return 0 }
# Keyboard feedback reads the target's focus before any key lands; the drift
# under test happens later, so the fixture answers it without a real window.
function Test-FocusMasked { return $false }
function Assert-ExecutionAuthorization($request,$handle) {}
function Remember-FocusOrigin($state,$previous,$target) {}
$script:state=@{LastFocus=[IntPtr]::Zero}
function Get-CurrentSession { return $script:state }
$script:CurrentRequest=@{action='type';window_id='hwnd:0x1';delivery='foreground'}
$script:dispatched=$false
$errorText=''
try {
  $null=Invoke-ForegroundInput ([IntPtr]1) 'type' { $script:dispatched=$true }
} catch { $errorText=$_.Exception.Message }
@{dispatched=$script:dispatched;error=$errorText} | ConvertTo-Json -Compress
`);
  assert.equal(result.dispatched, false);
  assert.match(result.error, /foreground_changed/);
});

test(
  'accessibility scrolling checks authorization again after provider lookup and before every increment',
  windows,
  async () => {
    const result = await nativeFixture(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll',
  [System.Windows.Automation.ScrollPattern].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location) -TypeDefinition @'
using System;
using System.Windows.Automation;
public class ScrollFixture {
  public static int Calls;
  public static bool Expired;
  public bool VerticallyScrollable = true;
  public double VerticalScrollPercent;
  public ScrollFixture Current { get { return this; } }
  public void Scroll(ScrollAmount horizontal, ScrollAmount vertical) { Calls++; }
}
public class ScrollElement {
  public int NativeWindowHandle = 1;
  public ScrollElement Current { get { return this; } }
  public bool TryGetCurrentPattern(AutomationPattern pattern, out object value) {
    value = new ScrollFixture(); ScrollFixture.Expired = true; return true;
  }
}
'@
. (Import-InputFunction 'Do-Scroll')
function Show-ReferencePointer($ref,$phase) {}
function Get-RefRecord($ref) { return @{Kind='uia';Element=[ScrollElement]::new()} }
function Get-TopWindow($element) { return $element }
function Assert-ExecutionAuthorization($request,$handle) {
  if ([ScrollFixture]::Expired -or [ScrollFixture]::Calls -ge 1) { throw 'computer_policy_expired: fixture authority expired' }
}
$errors = @()
try { Do-Scroll @{ref='r';direction='down';amount=2} } catch { $errors += $_.Exception.Message }
function Get-RefRecord($ref) {
  $element=[pscustomobject]@{Current=@{NativeWindowHandle=1}}
  $element | Add-Member ScriptMethod TryGetCurrentPattern {param($pattern,$value) $value.Value=[ScrollFixture]::new();return $true}
  return @{Kind='uia';Element=$element}
}
[ScrollFixture]::Expired=$false
try { Do-Scroll @{ref='r';direction='down';amount=2} } catch { $errors += $_.Exception.Message }
@{calls=[ScrollFixture]::Calls;errors=$errors} | ConvertTo-Json -Compress
`);
    assert.equal(result.calls, 1);
    assert.equal(result.errors.length, 2);
    for (const error of result.errors) assert.match(error, /computer_policy_expired/);
  }
);

test(
  'ref click uses native messages only when no semantic pattern exists, never after an uncertain semantic attempt',
  windows,
  async () => {
    const rows = await nativeFixture(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
public static class MixWin32 {
  public static int Clicks;
  public static string BackgroundPointer(IntPtr target,int x,int y,string kind,string modifiers) { Clicks++;return "hwnd:0x1"; }
  public static string WindowId(IntPtr target) { return "hwnd:0x1"; }
}
'@
foreach ($name in @('Do-ClickFamily','Do-Invoke')) { . (Import-InputFunction $name) }
function Invoke-BackgroundSemantic($ref,$body) { & $body }
function Get-RefRecord($ref) {
  $element=[pscustomobject]@{Current=@{NativeWindowHandle=1;IsEnabled=$true}}
  $element | Add-Member ScriptMethod TryGetCurrentPattern {param($pattern,$value) return $false}
  return @{Kind='uia';Element=$element}
}
function Get-TopWindow($element) { return $element }
function Get-PointArg($req) { return @(10,20,[IntPtr]1) }
function Get-ObservableTargetState($record,$action) { return @{} }
function Assert-ExecutionAuthorization($req,$target) {}
function Complete-NativeAction { return @{action='click';path='native'} }
function Native-BackgroundFailure($action,$exception) { throw $exception }
$rows=@()
$result=Do-ClickFamily @{action='click';ref='r'} 'click'
$rows+=@{path=$result.path;clicks=[MixWin32]::Clicks}
function Do-Invoke($ref,$allowNativeClick) { return @{action='invoke';path='uncertain';delivery_accepted=$false} }
$result=Do-ClickFamily @{action='click';ref='r'} 'click'
$rows+=@{path=$result.path;clicks=[MixWin32]::Clicks;action=$result.action}
$rows | ConvertTo-Json -Compress
`);
    assert.deepEqual(rows, [
      { path: 'native', clicks: 1 },
      { path: 'uncertain', clicks: 1, action: 'click' },
    ]);
  }
);

test(
  'ref clicks expand and collapse through UIA and reject disabled UIA/MSAA controls before input',
  windows,
  async () => {
    const rows = await nativeFixture(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies @('System.dll',
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location) -TypeDefinition @'
using System;
using System.Windows.Automation;
public sealed class ExpandFixture {
  public ExpandFixture Current { get { return this; } }
  public ExpandCollapseState ExpandCollapseState = ExpandCollapseState.Collapsed;
  public bool Changes = true;
  public int Calls;
  public void Expand() { Calls++; if (Changes) ExpandCollapseState = ExpandCollapseState.Expanded; }
  public void Collapse() { Calls++; if (Changes) ExpandCollapseState = ExpandCollapseState.Collapsed; }
}
public sealed class ElementFixture {
  public ElementFixture Current { get { return this; } }
  public bool IsEnabled = true;
  public ExpandFixture Pattern = new ExpandFixture();
  public int PatternQueries;
  public bool TryGetCurrentPattern(AutomationPattern pattern, out object value) {
    PatternQueries++;
    value = pattern == ExpandCollapsePattern.Pattern ? Pattern : null;
    return value != null;
  }
}
'@
foreach ($name in @('Do-Invoke','Do-ClickFamily','New-ActionResult','Background-Unavailable')) {
  . (Import-InputFunction $name)
}
function Invoke-BackgroundSemantic($ref,$body) { & $body }
function Get-RefRecord($ref) { return $script:record }
function Assert-ExecutionAuthorization($request,$handle) { $script:authorizations++ }
function Get-PointArg($request) { throw 'unexpected native fallback' }
$rows = @()
foreach ($mode in @('collapsed','expanded','partial','unchanged','disabled-uia','disabled-msaa')) {
  $script:authorizations = 0
  $element = [ElementFixture]::new()
  switch ($mode) {
    'expanded' { $element.Pattern.ExpandCollapseState = 'Expanded' }
    'partial' { $element.Pattern.ExpandCollapseState = 'PartiallyExpanded' }
    'unchanged' { $element.Pattern.Changes = $false }
    'disabled-uia' { $element.IsEnabled = $false }
  }
  $script:record = @{Kind='uia';Element=$element;WindowId='hwnd:0x1'}
  if ($mode -eq 'disabled-msaa') {
    $script:record = @{Kind='msaa';Msaa=@{Enabled=$false};WindowId='hwnd:0x1'}
  }
  $reply = Do-ClickFamily @{action='click';ref='r'} 'click'
  $rows += @{mode=$mode;reply=$reply;calls=$element.Pattern.Calls;
    state=[string]$element.Pattern.ExpandCollapseState;queries=$element.PatternQueries;
    authorizations=$script:authorizations}
}
$rows | ConvertTo-Json -Compress -Depth 6
`);
    const cases = Object.fromEntries(rows.map((row) => [row.mode, row]));
    for (const mode of ['collapsed', 'expanded', 'partial']) {
      assert.equal(cases[mode].reply.action, 'click');
      assert.equal(cases[mode].reply.path, 'uia_expand_collapse');
      assert.equal(cases[mode].reply.verified, true);
      assert.equal(cases[mode].calls, 1);
      assert.equal(cases[mode].authorizations, 1);
      assert.equal(cases[mode].state, mode === 'expanded' ? 'Collapsed' : 'Expanded');
    }
    assert.equal(cases.unchanged.reply.verified, false);
    assert.equal(cases.unchanged.reply.effect, 'unverifiable');
    assert.equal(cases.unchanged.calls, 1);
    for (const mode of ['disabled-uia', 'disabled-msaa']) {
      assert.equal(cases[mode].reply.code, 'element_disabled');
      assert.equal(cases[mode].reply.delivery_accepted, false);
      assert.equal(cases[mode].calls, 0);
      assert.equal(cases[mode].queries, 0);
      assert.equal(cases[mode].authorizations, 0);
    }
  }
);
