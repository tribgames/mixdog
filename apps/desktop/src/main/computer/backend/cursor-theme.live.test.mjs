import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';

test('real Windows cursor changes and restores after normal completion and worker-tree termination', {
  skip: process.platform !== 'win32' || process.env.MIXDOG_CURSOR_LIVE_TEST !== '1', timeout: 45000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-cursor-live-'));
  try {
    await writeFile(join(directory, 'native.cs'), MIXDOG_HOST_CSHARP + `
public static class CursorDigest {
  public static string Read() {
    var api = new MixWindowsCursorThemeApi();
    var handle = api.Save(32512);
    try {
      using(var icon = System.Drawing.Icon.FromHandle(handle))
      using(var bitmap = icon.ToBitmap())
      using(var stream = new System.IO.MemoryStream()) {
        bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
        return System.Convert.ToBase64String(stream.ToArray());
      }
    } finally { api.Free(handle); }
  }
}
`);
    await writeFile(join(directory, 'worker.ps1'), String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
[void][Reflection.Assembly]::LoadFrom((Join-Path $env:CURSOR_TEST_DIRECTORY 'native.dll'))
[MixInputObservation]::Begin()
$lease = [MixCursorTheme]::Begin()
[IO.File]::WriteAllText((Join-Path $env:CURSOR_TEST_DIRECTORY 'active'), 'ready')
Start-Sleep -Seconds 30
$lease.Dispose()
`);
    await writeFile(join(directory, 'test.ps1'), String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
$dll = Join-Path $env:CURSOR_TEST_DIRECTORY 'native.dll'
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -OutputAssembly $dll -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:CURSOR_TEST_DIRECTORY 'native.cs')))
[void][Reflection.Assembly]::LoadFrom($dll)
$original = [CursorDigest]::Read()
[MixInputObservation]::Begin()
$lease = [MixCursorTheme]::Begin()
try {
  if ([CursorDigest]::Read() -eq $original) { throw 'system cursor did not change' }
} finally { $lease.Dispose(); [MixInputObservation]::End() }
if ([CursorDigest]::Read() -ne $original) { throw 'normal restoration differs from original' }
$worker = Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-File',('"' + (Join-Path $env:CURSOR_TEST_DIRECTORY 'worker.ps1') + '"')) -WindowStyle Hidden -PassThru
try {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while (-not [IO.File]::Exists((Join-Path $env:CURSOR_TEST_DIRECTORY 'active'))) {
    if ($worker.HasExited -or $clock.ElapsedMilliseconds -gt 15000) { throw 'worker did not activate theme' }
    Start-Sleep -Milliseconds 50
  }
  if ([CursorDigest]::Read() -eq $original) { throw 'worker theme not visible in OS cursor resource' }
  & taskkill.exe /PID $worker.Id /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'test worker termination failed' }
  $clock.Restart()
  while ([CursorDigest]::Read() -ne $original -and $clock.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 50 }
  if ([CursorDigest]::Read() -ne $original) { throw 'independent watchdog did not restore after worker death' }
} finally {
  if (-not $worker.HasExited) { $worker.Kill(); $worker.WaitForExit() }
}
[Console]::WriteLine('CURSOR_REAL_RESTORATION_OK')
`);
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      { timeout: 35000, windowsHide: true, env: { ...process.env, CURSOR_TEST_DIRECTORY: directory } });
    assert.match(result.stdout, /CURSOR_REAL_RESTORATION_OK/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      .catch(error => console.error('Test artifacts retained:', directory, error.code));
  }
});
