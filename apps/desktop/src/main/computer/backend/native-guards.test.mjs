import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { powershellHostProgram } from './program.ts';
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
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')], {
      windowsHide: true, timeout: 30_000,
      env: { ...process.env, AUDIT_DIRECTORY: directory },
    });
    return stdout.trim();
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('resident native program parses and its C# compiles without touching the desktop', {
  skip: process.platform !== 'win32',
}, async () => {
  const output = await isolatedProgram(String.raw`
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
`, { 'host.ps1': powershellHostProgram(), 'native.cs': MIXDOG_HOST_CSHARP });
  assert.equal(output, 'compiled');
});

test('native authority and drag endpoint guards reject before any desktop effect', {
  skip: process.platform !== 'win32',
}, async () => {
  const output = await isolatedProgram(String.raw`
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
`, { 'authorization.ps1': PS_AUTHORIZATION, 'input.ps1': PS_INPUT });
  const rows = JSON.parse(output);
  assert.deepEqual(rows.map((row) => row.sent), [false, false, false, true]);
  assert.match(rows[0].error, /policy_expired/);
  assert.match(rows[1].error, /policy_denied/);
  assert.match(rows[2].error, /target_mismatch/);
});

test('all foreground native actions keep one intervention scope even on failure, while reads do not acquire one', {
  skip: process.platform !== 'win32',
}, async () => {
  const output = await isolatedProgram(String.raw`
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
`, { 'runtime.ps1': PS_RUNTIME });
  assert.equal(output, 'scoped');
});
