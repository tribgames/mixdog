import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';

test('tagged key streams preserve grouping, repeats and literal escapes; invalid streams emit nothing; release survives interruption', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-tagged-keys-'));
  try {
    await writeFile(
      join(directory, 'native.cs'),
      MIXDOG_HOST_CSHARP +
        `
public class FakeKeySink : IMixKeySink {
  public string Events = "";
  public bool FailTap, FailUp;
  public void Down(ushort key) { Events += "D" + key + ";"; }
  public void Up(ushort key) { Events += "U" + key + ";"; if (FailUp && key == 18) throw new System.Exception("release"); }
  public void Tap(ushort key) { Events += "K" + key + ";"; if (FailTap) throw new System.Exception("interrupt"); }
  public void Text(string text) { Events += "T" + text + ";"; }
}
`
    );
    await writeFile(
      join(directory, 'test.ps1'),
      `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'native.cs')))
$sink = New-Object FakeKeySink
[MixTaggedKeys]::Send('^(ab){TAB 2}{+}{{}{}}~', $sink)
if ($sink.Events -ne 'D17;K65;K66;U17;K9;K9;T+;T{;T};K13;') { throw $sink.Events }
# An upper-case letter names the same key as its lower-case twin: a chord must
# not gain a shift the caller never asked for (Ctrl+S is not Ctrl+Shift+S).
$sink = New-Object FakeKeySink
[MixTaggedKeys]::Send('^S', $sink)
if ($sink.Events -ne 'D17;K83;U17;') { throw ('upper-case letter gained a shift: ' + $sink.Events) }
$sink = New-Object FakeKeySink
[MixTaggedKeys]::Send('^+s', $sink)
if ($sink.Events -ne 'D17;D16;K83;U16;U17;') { throw ('explicit shift lost: ' + $sink.Events) }
# A glyph that needs shift to exist still carries it.
$sink = New-Object FakeKeySink
[MixTaggedKeys]::Send('^?', $sink)
if ($sink.Events -ne 'D17;D16;K191;U16;U17;') { throw ('shifted glyph lost its shift: ' + $sink.Events) }
# '#' holds the Windows key around its target; alone it is the character.
$sink = New-Object FakeKeySink
[MixTaggedKeys]::Send('#r', $sink)
if ($sink.Events -ne 'D91;K82;U91;') { throw ('windows chord: ' + $sink.Events) }
$sink = New-Object FakeKeySink
[MixTaggedKeys]::Send('^#{RIGHT}', $sink)
if ($sink.Events -ne 'D17;D91;K39;U91;U17;') { throw ('ctrl+windows chord: ' + $sink.Events) }
$sink = New-Object FakeKeySink
[MixTaggedKeys]::Send('#', $sink)
if ($sink.Events -ne 'T#;') { throw ('lone hash: ' + $sink.Events) }
$sink = New-Object FakeKeySink
[MixTaggedKeys]::Send('{LWIN}', $sink)
if ($sink.Events -ne 'K91;') { throw ('windows key tap: ' + $sink.Events) }
foreach ($text in @('x%{F4}', '%(ab{F4})', 'a{TAB 101}', 'abc(', 'text^', '#l', '+#L', '#(al)')) {
  $sink = New-Object FakeKeySink
  $rejected = $false
  try { [MixTaggedKeys]::Send($text, $sink) } catch { $rejected = $true }
  if (-not $rejected -or $sink.Events) { throw ('partial input for invalid stream: ' + $text) }
}
# A modifier named alone is a key that can be held and released.
$sink = New-Object FakeKeySink
[MixTaggedKeys]::Hold('{SHIFT}', $true, $sink)
[MixTaggedKeys]::Hold('{SHIFT}', $false, $sink)
if ($sink.Events -ne 'D16;U16;') { throw ('modifier hold did not press its own key: ' + $sink.Events) }
$sink = New-Object FakeKeySink
$sink.FailTap = $true; $sink.FailUp = $true
try { [MixTaggedKeys]::Send('^%a', $sink) } catch {}
if (-not $sink.Events.EndsWith('U18;U17;')) { throw ('not all modifiers released: ' + $sink.Events) }
[Console]::WriteLine('tagged keys passed')
`
    );
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      {
        windowsHide: true,
        timeout: 30_000,
        env: { ...process.env, AUDIT_DIRECTORY: directory },
      }
    );
    assert.equal(stdout.trim(), 'tagged keys passed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
