import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

test('semantic background feedback reports target points without replaying input or exposing text', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async () => {
  const sourcePath = fileURLToPath(new URL('./sources/input.ps1', import.meta.url));
  const program = String.raw`
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($env:FEEDBACK_SOURCE_PATH)
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
foreach ($name in @('Show-ReferencePointer', 'Invoke-BackgroundSemantic')) {
  $function = $ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true)[0]
  Invoke-Expression $function.Extent.Text
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class MixWin32 {
  public static object PointerProgress = new object();
  public static int PointerEventsFailed;
  public static List<string> Events = new List<string>();
  public static void ReportPointer(int x,int y,bool held,string phase) {
    Events.Add(x + "," + y + "," + phase);
  }
}
'@
function Get-RefRecord($ref) { return @{ WindowId='hwnd:0x123' } }
function Get-RefTopHandle($record) { return [IntPtr]0x123 }
function Get-ElPoint($ref,$requireTopmost) {
  if ($requireTopmost) { throw 'feedback must not require foreground' }
  if ($script:missingBounds) { throw 'no visual bounds' }
  return @(320,240,[IntPtr]0x123)
}
function Invoke-BackgroundWindow($target,$operation) {
  if ($target -ne [IntPtr]0x123) { throw 'wrong target' }
  $script:inputs++
  return & $operation
}
$script:inputs = 0
$clock = [Diagnostics.Stopwatch]::StartNew()
$result = Invoke-BackgroundSemantic 's1:e0' { return @{ delivery_accepted=$true; text='private input' } }
if ($clock.ElapsedMilliseconds -lt 300) { throw 'input acted before the presented pointer could arrive' }
if ($result.text -ne 'private input') { throw 'input result changed' }
if (([MixWin32]::Events -join ';') -ne '320,240,prepare;320,240,release') { throw 'missing click feedback' }
[MixWin32]::Events.Clear()
$null = Invoke-BackgroundSemantic 's1:e0' { return @{ delivery_accepted=$true } } 'type'
if (([MixWin32]::Events -join ';') -ne '320,240,prepare;320,240,type') { throw 'missing typing feedback' }
[MixWin32]::Events.Clear()
$null = Invoke-BackgroundSemantic 's1:e0' { return @{ delivery_accepted=$false } }
if (([MixWin32]::Events -join ';') -ne '320,240,prepare') { throw 'refusal reported a delivered click' }
$null = Invoke-BackgroundSemantic 's1:e0' { return $null }
if (([MixWin32]::Events -join ';') -ne '320,240,prepare;320,240,prepare') { throw 'native fallback reported a delivered click' }
[MixWin32]::Events.Clear()
$null = Invoke-BackgroundSemantic 's1:e0' {
  $script:missingBounds = $true
  return @{ delivery_accepted=$true }
}
if (([MixWin32]::Events -join ';') -ne '320,240,prepare;320,240,release') {
  throw 'a target disappearing after dispatch lost the original click feedback'
}
if ([MixWin32]::PointerEventsFailed -ne 0) { throw 'completed input queried the now-invalid target again' }
$script:missingBounds = $true
$clock.Restart()
$null = Invoke-BackgroundSemantic 's1:e0' { return @{ delivery_accepted=$true } }
if ($clock.ElapsedMilliseconds -ge 300) { throw 'input waited for a pointer that was never presented' }
if ([MixWin32]::PointerEventsFailed -ne 1) { throw 'visual failure not recorded' }
if ($script:inputs -ne 6) { throw 'input replayed or blocked by visual failure' }
[Console]::WriteLine('BACKGROUND_FEEDBACK_OK')
`;
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', program],
    { windowsHide: true, timeout: 20000, env: { ...process.env, FEEDBACK_SOURCE_PATH: sourcePath } }
  );
  assert.equal(stdout.trim(), 'BACKGROUND_FEEDBACK_OK');
});
