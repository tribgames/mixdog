import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';

test('native input ledger uses event origin, retains physical intervention, and handles tick wrap', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-input-ledger-'));
  try {
    await writeFile(join(directory, 'native.cs'), MIXDOG_HOST_CSHARP);
    await writeFile(
      join(directory, 'test.ps1'),
      `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'native.cs')))
$ledger = New-Object MixInputLedger 1000
$ledger.Record($true, 1001)
$ledger.Record($false, 1001)
$ledger.Record($true, 1002)
if ($ledger.ForeignSequence -ne 1) { throw 'intervention lost under a later own input' }
if (-not $ledger.LatestOwn) { throw 'own event was not distinguished' }
$ledger.Record($true, [uint32]::MaxValue)
$ledger.Record($true, 0)
if ($ledger.ForeignSequence -ne 1 -or $ledger.LatestTick -ne 0) { throw 'tick wrap changed provenance' }
$ledger.Record($false, 0)
if ($ledger.ForeignSequence -ne 2) { throw 'same-tick external event was missed' }
# A reserved key Windows injects during an app's activation keeps the clock
# current without reading as someone else's input.
$ledger.RecordNeutral(5)
if ($ledger.ForeignSequence -ne 2 -or $ledger.LatestTick -ne 5) { throw 'neutral input changed provenance or lost the clock' }
# An unaccounted clock change counts once as foreign input and stays open.
if (-not $ledger.Observe(5) -or $ledger.Gap) { throw 'an accounted clock opened a gap' }
if ($ledger.Observe(4)) { throw 'an earlier (non-monotonic) unaccounted tick was accepted' }
if ($ledger.ForeignSequence -ne 3 -or -not $ledger.Gap) { throw 'gap was not counted as foreign input' }
if ($ledger.Observe(9) -or $ledger.ForeignSequence -ne 3) { throw 'one unresolved gap counted more than once' }
$ledger.Record($true, 9)
if ($ledger.Observe(9) -or -not $ledger.Gap -or $ledger.ForeignSequence -ne 3) { throw 'own event restoring tick equality closed the gap' }
$ledger.Record($false, 9)
if ($ledger.ForeignSequence -ne 4) { throw 'same-tick foreign event during a gap was missed' }
# Quiet window: desktop access, nothing held and a still clock over enough
# observations and enough elapsed time; any input restarts it.
if ($ledger.ObserveQuiet($true, $false, 9, 0)) { throw 'one observation confirmed quiet' }
if ($ledger.ObserveQuiet($true, $false, 9, 50)) { throw 'two observations confirmed quiet' }
if ($ledger.ObserveQuiet($true, $false, 9, 100)) { throw 'quiet confirmed before the elapsed window' }
if ($ledger.Resynchronize($true, $false, 9) -or -not $ledger.Gap) { throw 'resynced without confirmed quiet' }
foreach ($blocked in @(@($false, $false), @($true, $true))) {
  $null = $ledger.ObserveQuiet($true, $false, 9, 1000)
  $null = $ledger.ObserveQuiet($true, $false, 9, 1100)
  if ($ledger.ObserveQuiet($blocked[0], $blocked[1], 9, 1400)) { throw 'quiet confirmed without desktop access or with input held' }
}
$null = $ledger.ObserveQuiet($true, $false, 9, 2000)
$null = $ledger.ObserveQuiet($true, $false, 9, 2100)
$ledger.Record($true, 10)
if ($ledger.ObserveQuiet($true, $false, 10, 2400)) { throw 'quiet survived an input event' }
$null = $ledger.ObserveQuiet($true, $false, 10, 2500)
if ($ledger.ObserveQuiet($true, $false, 11, 2900)) { throw 'quiet survived a clock change' }
$null = $ledger.ObserveQuiet($true, $false, 11, 3000)
if (-not $ledger.ObserveQuiet($true, $false, 11, 3300)) { throw 'confirmed quiet was not recognized' }
if ($ledger.Resynchronize($true, $false, 12) -or -not $ledger.Gap) { throw 'resynced across a clock change' }
foreach ($elapsed in 4000, 4100, 4400) { $null = $ledger.ObserveQuiet($true, $false, 11, $elapsed) }
if ($ledger.Resynchronize($true, $true, 11) -or -not $ledger.Gap) { throw 'resynced with input held' }
foreach ($elapsed in 5000, 5100, 5400) { $null = $ledger.ObserveQuiet($true, $false, 11, $elapsed) }
if (-not $ledger.Resynchronize($true, $false, 11) -or $ledger.Gap) { throw 'confirmed quiet did not resync' }
if ($ledger.ForeignSequence -ne 4 -or $ledger.LatestTick -ne 11) { throw 'resync rebased the sequence or lost the clock' }
if (-not $ledger.Observe(11)) { throw 'resynced ledger is not consistent' }
# Equality only: a wrapped tick is just another unequal tick.
if ($ledger.Observe([uint32]::MaxValue) -or $ledger.ForeignSequence -ne 5) { throw 'wrapped unaccounted tick was not a gap' }
if (-not [MixInputObservation]::IsUnassignedVirtualKey(0xB9)) { throw 'the activation key 0xB9 counts as typing' }
foreach ($vk in 0x41, 0x0D, 0x10, 0xBA, 0xDB) {
  if ([MixInputObservation]::IsUnassignedVirtualKey($vk)) { throw "a real key was ignored: $vk" }
}
foreach ($name in @('ApplicationFrameWindow', 'Windows.UI.Core.CoreWindow', 'applicationframewindow')) {
  if ([MixWin32]::SupportsBackgroundKeyboardClass($name)) { throw "unsupported keyboard host accepted: $name" }
}
if (-not [MixWin32]::SupportsBackgroundKeyboardClass('Edit')) { throw 'native edit keyboard route blocked' }
$start = [MixWin32]::CursorMotionPoint(-1200, -300, 3100, 1050, 0, 20)
$middle = [MixWin32]::CursorMotionPoint(-1200, -300, 3100, 1050, 10, 20)
$end = [MixWin32]::CursorMotionPoint(-1200, -300, 3100, 1050, 20, 20)
if ($start.x -ne -1200 -or $start.y -ne -300) { throw 'physical motion start mismatch' }
if ($middle.x -le $start.x -or $middle.x -ge $end.x) { throw 'physical motion has no intermediate travel' }
if ($end.x -ne 3100 -or $end.y -ne 1050) { throw 'physical motion endpoint mismatch' }
[Console]::WriteLine('ledger passed')
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
    assert.equal(stdout.trim(), 'ledger passed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
