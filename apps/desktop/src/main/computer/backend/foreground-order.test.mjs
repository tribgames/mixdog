import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { PS_INPUT } from './ps-input.ts';

test('covered semantic click prepares focus then rechecks before physical movement', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-foreground-order-'));
  try {
    await writeFile(join(directory, 'input.ps1'), PS_INPUT);
    await writeFile(join(directory, 'test.ps1'), String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
public static class MixWin32 {
  public static List<string> Events = new List<string>();
  public static IntPtr WindowAtPoint(int x, int y) { return new IntPtr(1); }
  public static void GlideCursor(IntPtr window, int x, int y) { Events.Add("move"); }
  public static void Click(int x, int y) { Events.Add("click"); }
  public static void MouseWheel(int clicks) { Events.Add("scroll"); }
  public static void MouseHWheel(int clicks) { Events.Add("horizontal"); }
}
'@
. (Join-Path $env:FIXTURE_DIRECTORY 'input.ps1')
$script:focused = $false
$script:blocked = $false
function Get-RefRecord($ref) { return @{} }
function Get-ObservableTargetState($record, $action) { return $null }
function Resolve-WindowInfo($window, $id) { return @{ Handle = [IntPtr]1; Id = 'hwnd:0x1' } }
function Get-ElPoint($ref, $requireTopmost = $true) {
  if ($requireTopmost) {
    [MixWin32]::Events.Add('recheck')
    if (-not $script:focused -or $script:blocked) { throw 'fixture_covered' }
  } else { [MixWin32]::Events.Add('resolve') }
  return @(100, 200, [IntPtr]1)
}
function Invoke-ForegroundInput($target, $action, $body, $pointerMayActivate) {
  [MixWin32]::Events.Add('focus')
  $script:focused = $true
  & $body
}
$request = @{ action = 'click'; delivery = 'foreground'; ref = 's1:e0'; window_id = 'hwnd:0x1' }
Do-ClickFamily $request 'click'
if (([MixWin32]::Events -join ',') -ne 'resolve,focus,recheck,move,click') { throw 'wrong input order' }
[MixWin32]::Events.Clear()
$script:focused = $false
$script:blocked = $true
try { Do-ClickFamily $request 'click'; throw 'missing refusal' } catch {
  if ($_.Exception.Message -ne 'fixture_covered') { throw }
}
if (([MixWin32]::Events -join ',') -ne 'resolve,focus,recheck') { throw 'input sent through blocker' }
[Console]::WriteLine('FOREGROUND_ORDER_OK')
$script:blocked = $false
$script:focused = $false
[MixWin32]::Events.Clear()
$request.action='scroll'; $request.direction='down'; $request.amount=1
Do-Scroll $request
if (([MixWin32]::Events -join ',') -ne 'resolve,focus,recheck,move,scroll') { throw 'scroll did not preserve foreground delivery' }
[MixWin32]::Events.Clear()
$script:focused=$false; $script:blocked=$true
try { Do-Scroll $request; throw 'missing refusal' } catch {
  if ($_.Exception.Message -ne 'fixture_covered') { throw }
}
if (([MixWin32]::Events -join ',') -ne 'resolve,focus,recheck') { throw 'scroll sent through blocker' }
[Console]::WriteLine('SCROLL_ORDER_OK')
`);
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      { timeout: 20000, windowsHide: true, env: { ...process.env, FIXTURE_DIRECTORY: directory } });
    assert.match(result.stdout, /FOREGROUND_ORDER_OK/);
    assert.match(result.stdout, /SCROLL_ORDER_OK/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
