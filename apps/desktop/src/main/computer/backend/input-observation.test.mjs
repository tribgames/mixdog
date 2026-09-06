import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';

test('native input ledger uses event origin, retains physical intervention, and handles tick wrap', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-input-ledger-'));
  try {
    await writeFile(join(directory, 'native.cs'), MIXDOG_HOST_CSHARP);
    await writeFile(join(directory, 'test.ps1'), String.raw`
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
[Console]::WriteLine('ledger passed')
`);
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')], {
      windowsHide: true, timeout: 30_000, env: { ...process.env, AUDIT_DIRECTORY: directory },
    });
    assert.equal(stdout.trim(), 'ledger passed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
