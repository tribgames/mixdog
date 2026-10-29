import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { PS_INPUT } from './ps-input.ts';
import { PS_OBSERVATION } from './ps-observation.ts';

test('predicate snapshots preserve punctuation, use cached values and retain coverage', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-predicate-observation-'));
  const format = PS_OBSERVATION.slice(
    PS_OBSERVATION.indexOf('function Format-ObservationValue('),
    PS_OBSERVATION.indexOf('\n# Pattern availability')
  );
  const cached = PS_OBSERVATION.slice(
    PS_OBSERVATION.indexOf('function Get-CachedFlag('),
    PS_OBSERVATION.indexOf('\nfunction Get-ElementObservation(')
  );
  const predicates = PS_INPUT.slice(
    PS_INPUT.indexOf('function Get-WindowPredicates('),
    PS_INPUT.indexOf('\n# Menu entries by exact label')
  );
  try {
    const fixture = join(directory, 'fixture.ps1');
    await writeFile(
      fixture,
      `\uFEFF
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
public sealed class PredicateNode {
    public string Name = "MSAA \\"label\\"";
    public string Value = "C:\\\\test\\\\file.txt";
    public string ControlType = "Edit";
    public int Width = 100, Height = 20;
    public bool Enabled = true;
    public bool Refresh() { throw new System.Exception("snapshot must not be read twice"); }
}
public sealed class PredicateSnapshot {
    public PredicateNode[] Nodes = new[] { new PredicateNode() };
    public bool Complete = true;
}
public static class MixMsaa {
    public static PredicateSnapshot SnapshotWithStatus(object handle, string id, int maximum) {
        return new PredicateSnapshot();
    }
}
'@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
function Resolve-WindowInfo { return @{ Id = 'hwnd:fixture'; Handle = 1; Title = 'fixture'; ClassName = 'Chrome_WidgetWin_1' } }
function Assert-AccessibleIntegrity($info) {}
$script:FixtureValue = '한글 "정확" ''따옴표'' C:\\test\\file.txt'
$script:ValueUnavailable = $false
$el = [pscustomobject]@{
    Cached = [pscustomobject]@{
        Name = '검색 "정확"'
        ControlType = [System.Windows.Automation.ControlType]::Edit
        IsOffscreen = $false
        IsEnabled = $true
    }
}
$el | Add-Member ScriptMethod GetCachedPropertyValue {
    param($property, $ignoreDefault)
    if ($property.Id -eq [System.Windows.Automation.ValuePattern]::ValueProperty.Id) {
        if ($script:ValueUnavailable) { return [System.Windows.Automation.AutomationElement]::NotSupported }
        return $script:FixtureValue
    }
    if ($property.Id -eq [System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty.Id) { return $true }
    return $false
}
$el | Add-Member ScriptMethod TryGetCurrentPattern { throw 'live pattern reads are not part of the cached snapshot' }
$script:FixtureElements = @($el)
$win = [pscustomobject]@{}
$win | Add-Member ScriptMethod FindAll { return ,$script:FixtureElements }
function Find-Window { return $win }
${format}
${cached}
${predicates}
$req = @{ window_id = 'hwnd:fixture'; max_elements = 400 }
$complete = Get-WindowPredicates $req
$script:ValueUnavailable = $true
$unavailable = Get-WindowPredicates $req
$script:ValueUnavailable = $false
$script:FixtureValue = 'x' * 201
$truncated = Get-WindowPredicates $req
$limited = Get-WindowPredicates @{ window_id = 'hwnd:fixture'; max_elements = 1 }
@{ complete = $complete; unavailable = $unavailable; truncated = $truncated; limited = $limited } | ConvertTo-Json -Depth 8 -Compress
`
    );
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', fixture],
      { windowsHide: true, timeout: 30_000 }
    );
    const { complete, unavailable, truncated, limited } = JSON.parse(stdout);
    assert.equal(complete.text_complete, true);
    assert.equal(complete.elements[0].name, '검색 "정확"');
    assert.equal(complete.elements[0].value, '한글 "정확" \'따옴표\' C:\\test\\file.txt');
    assert.equal(complete.elements[1].name, 'MSAA "label"');
    assert.equal(complete.elements[1].value, 'C:\\test\\file.txt');
    assert.equal(unavailable.text_complete, false);
    assert.equal(unavailable.elements[0].value, '');
    assert.equal(truncated.text_complete, false);
    assert.equal(truncated.elements[0].value.length, 200);
    assert.equal(limited.text_complete, false);
    assert.equal(limited.elements.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
