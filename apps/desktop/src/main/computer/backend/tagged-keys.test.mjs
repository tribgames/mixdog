import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';

test('tagged key streams preserve grouping, repeats and literal escapes; invalid streams emit nothing; release survives interruption', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-tagged-keys-'));
  try {
    await writeFile(join(directory, 'native.cs'), MIXDOG_HOST_CSHARP + String.raw`
public class FakeKeySink : IMixKeySink {
  public string Events = "";
  public bool FailTap, FailUp;
  public void Down(ushort key) { Events += "D" + key + ";"; }
  public void Up(ushort key) { Events += "U" + key + ";"; if (FailUp && key == 18) throw new System.Exception("release"); }
  public void Tap(ushort key) { Events += "K" + key + ";"; if (FailTap) throw new System.Exception("interrupt"); }
  public void Text(string text) { Events += "T" + text + ";"; }
}
`);
    await writeFile(join(directory, 'test.ps1'), String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'native.cs')))
$sink = New-Object FakeKeySink
[MixTaggedKeys]::Send('^(ab){TAB 2}{+}{{}{}}~', $sink)
if ($sink.Events -ne 'D17;K65;K66;U17;K9;K9;T+;T{;T};K13;') { throw $sink.Events }
foreach ($text in @('x%{F4}', '%(ab{F4})', 'a{TAB 101}', 'abc(', 'text^')) {
  $sink = New-Object FakeKeySink
  $rejected = $false
  try { [MixTaggedKeys]::Send($text, $sink) } catch { $rejected = $true }
  if (-not $rejected -or $sink.Events) { throw ('partial input for invalid stream: ' + $text) }
}
$sink = New-Object FakeKeySink
$sink.FailTap = $true; $sink.FailUp = $true
try { [MixTaggedKeys]::Send('^%a', $sink) } catch {}
if (-not $sink.Events.EndsWith('U18;U17;')) { throw ('not all modifiers released: ' + $sink.Events) }
[Console]::WriteLine('tagged keys passed')
`);
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')], {
      windowsHide: true, timeout: 30_000, env: { ...process.env, AUDIT_DIRECTORY: directory },
    });
    assert.equal(stdout.trim(), 'tagged keys passed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
