import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execute = promisify(execFile);
const windows = { skip: process.platform !== 'win32', timeout: 20_000 };

async function nativeFixture(body) {
  const script = String.raw`
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
  const { stdout } = await execute('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    windowsHide: true, timeout: 15_000,
    env: { ...process.env,
      MIXDOG_FIXTURE_INPUT_SOURCE: fileURLToPath(new URL('./sources/input.ps1', import.meta.url)) },
  });
  return JSON.parse(stdout.trim());
}

test('menu dispatch stays in its live branch or an owned popup, never another app', windows, async () => {
  const rows = await nativeFixture(String.raw`
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
    Windows.Clear(); Invoked.Clear();
    var root = new MenuElement("target", 1);
    var file = new MenuElement("File", 1) { Expands = true };
    root.Children.Add(file); Windows[1] = root;
    Windows[2] = new MenuElement("foreign", 2);
    Windows[2].Children.Add(new MenuElement("Save", 2));
    if (mode == "owned") {
      Windows[3] = new MenuElement("popup", 3);
      Windows[3].Children.Add(new MenuElement("Save", 3));
    } else if (mode != "missing") {
      var save = new MenuElement("Save", 1);
      save.Current.IsEnabled = mode != "disabled";
      file.Children.Add(save);
      if (mode == "ambiguous") file.Children.Add(new MenuElement("Save", 1));
    }
  }
}
public static class MixWin32 {
  public static string[] RelatedWindowIds(IntPtr owner) {
    return MenuAutomation.Windows.ContainsKey(3) ? new [] {"hwnd:0x1","hwnd:0x3"} : new [] {"hwnd:0x1"};
  }
  public static IntPtr ParseWindowId(string value) { return new IntPtr(Convert.ToInt32(value.Substring(7), 16)); }
  public static bool IsOwnedBy(IntPtr candidate, IntPtr owner) { return candidate.ToInt32() == 3 && owner.ToInt32() == 1; }
}
'@
$AE = [MenuAutomation]
$TS = [System.Windows.Automation.TreeScope]
foreach ($name in @('Get-MenuCandidates','Expand-MenuElement','Do-InvokeMenu','New-ActionResult')) {
  . (Import-InputFunction $name)
}
function Resolve-WindowInfo($window,$id) { return @{Handle=[IntPtr]1; Id='hwnd:0x1'} }
function Find-Window($window,$id) { return [MenuAutomation]::FromHandle([IntPtr]1) }
function Get-TopWindow($element) { return $element }
function Get-MsaaMenuCandidates($info,$name) { return @() }
function Assert-ExecutionAuthorization($request,$handle) {}
function Invoke-BackgroundWindow($target,$operation) { & $operation }
$rows = @()
foreach ($mode in @('missing','valid','owned','ambiguous','disabled')) {
  [MenuAutomation]::Configure($mode)
  $script:CurrentRequest = @{action='invoke_menu';window_id='hwnd:0x1';path=@('File','Save')}
  $errorText = ''
  try { $null = Do-InvokeMenu $script:CurrentRequest } catch { $errorText = $_.Exception.Message }
  $rows += @{mode=$mode; invoked=@([MenuAutomation]::Invoked.ToArray()); error=$errorText}
}
$rows | ConvertTo-Json -Compress -Depth 5
`);
  const byMode = Object.fromEntries(rows.map(row => [row.mode, row]));
  assert.deepEqual(byMode.missing.invoked, []);
  assert.match(byMode.missing.error, /menu_path_not_found/);
  assert.deepEqual(byMode.valid.invoked, [1]);
  assert.deepEqual(byMode.owned.invoked, [3]);
  for (const [mode, error] of [['ambiguous', 'menu_path_ambiguous'], ['disabled', 'menu_item_disabled']]) {
    assert.deepEqual(byMode[mode].invoked, []);
    assert.match(byMode[mode].error, new RegExp(error));
  }
});

test('foreground drift during preparation prevents the input body from running', windows, async () => {
  const result = await nativeFixture(String.raw`
Add-Type @'
using System;
public static class MixInputObservation {
  public static Action DispatchAuthorization;
  public static void Begin() {}
  public static void AssertContinue() { if (DispatchAuthorization != null) DispatchAuthorization(); }
  public static void End() {}
}
public sealed class MixCursorTheme : IDisposable {
  public static MixCursorTheme Begin() { MixWin32.Current = new IntPtr(2); return new MixCursorTheme(); }
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
foreach ($name in @('Invoke-ForegroundInput','New-ActionResult')) { . (Import-InputFunction $name) }
function Wait-UserInputIdle { return 0 }
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

test('accessibility scrolling checks authorization again after provider lookup and before every increment', windows, async () => {
  const result = await nativeFixture(String.raw`
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
});

test('ref click uses native messages only when no semantic pattern exists, never after an uncertain semantic attempt', windows, async () => {
  const rows = await nativeFixture(String.raw`
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
  $element=[pscustomobject]@{Current=@{NativeWindowHandle=1}}
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
});
