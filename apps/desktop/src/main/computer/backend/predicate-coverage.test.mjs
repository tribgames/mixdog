import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { PS_INPUT } from './ps-input.ts';

test('native predicate reads report empty, truncated and incomplete provider coverage', {
  skip: process.platform !== 'win32',
}, async () => {
  // Mock provider boundaries, not desktop windows or native input.
  const script = String.raw`
class MixMsaa {
  static [bool] $Complete = $true
  static [object] SnapshotWithStatus([object]$handle, [string]$id, [int]$maximum) {
    return @{Nodes=@(); Complete=[MixMsaa]::Complete}
  }
}
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement];
$TS = [System.Windows.Automation.TreeScope];
${PS_INPUT}
function Format-ObservationValue($value, $maximum = 120) {
  return ([string]$value).Substring(0, [Math]::Min(([string]$value).Length, $maximum))
}
function Resolve-WindowInfo($title, $id) { return @{Id='hwnd:0x1'; Title='fixture'; Handle=[IntPtr]1} }
$mockWindow = [pscustomobject]@{}
$mockWindow | Add-Member ScriptMethod FindAll { param($scope, $condition) return $script:elements }
function Find-Window($title, $id) { return $mockWindow }
$rows = @()
foreach ($case in @('empty','complete','truncated','long-text','partial-provider')) {
  [MixMsaa]::Complete = $case -ne 'partial-provider'
  $names = switch ($case) {
    'empty' { @() }
    'truncated' { @('one','two','error') }
    'long-text' { @('x' * 201) }
    default { @('ready') }
  }
  $script:elements = @($names | ForEach-Object {
    [pscustomobject]@{ Cached=[pscustomobject]@{
      IsOffscreen=$false; Name=$_; IsEnabled=$true; ControlType=[System.Windows.Automation.ControlType]::Text
    }}
  })
  $result = Get-WindowPredicates ([pscustomobject]@{
    window_id='hwnd:0x1'; window=$null; max_elements=2; include_elements=$true
  })
  $rows += @{case=$case; complete=$result.text_complete; returned=$result.returned}
}
$rows | ConvertTo-Json -Compress
`;
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-predicate-coverage-'));
  const path = join(directory, 'probe.ps1');
  try {
    await writeFile(path, script);
    const { stdout } = await promisify(execFile)('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path,
    ], { windowsHide: true, timeout: 10_000 });
    const results = JSON.parse(stdout.trim());
    assert.deepEqual(results.map((row) => [row.case, row.complete, row.returned]), [
      ['empty', false, 0],
      ['complete', true, 1],
      ['truncated', false, 2],
      ['long-text', false, 1],
      ['partial-provider', false, 1],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
