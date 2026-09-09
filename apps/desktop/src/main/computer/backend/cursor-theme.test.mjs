import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';

// Exercise ownership and rollback with fake handles; never change system cursors.
test('cursor theme restores original handles, rolls back partial activation and fails closed on restoration failure', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-cursor-theme-'));
  try {
    await writeFile(join(directory, 'native.cs'), MIXDOG_HOST_CSHARP + `
public class FakeCursorTheme : MixCursorThemeApi {
  public int Applied, Restored, Freed, Resets;
  public bool FailApply, FailRestore, ResetWorks = true;
  public System.IntPtr Save(uint role) { return new System.IntPtr((int)role); }
  public void Apply(uint role) { Applied++; if(FailApply && Applied == 2) throw new System.Exception("apply failed"); }
  public bool Restore(uint role, System.IntPtr backup) {
    if(backup.ToInt64() != role) throw new System.Exception("wrong original");
    Restored++; return !FailRestore;
  }
  public bool ResetConfiguredScheme() { Resets++; return ResetWorks; }
  public void Free(System.IntPtr backup) { Freed++; }
}
`);
    await writeFile(join(directory, 'test.ps1'), String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:CURSOR_TEST_DIRECTORY 'native.cs')))
$api = New-Object FakeCursorTheme
$lease = New-Object MixCursorThemeLease($api, ([uint32[]]@(1,2,3)))
$lease.Activate()
$lease.Dispose()
$lease.Dispose()
if ($api.Applied -ne 3 -or $api.Restored -ne 3 -or $api.Freed -ne 3 -or $api.Resets -ne 0) { throw 'normal restoration failed' }
$api = New-Object FakeCursorTheme
$api.FailApply = $true
$lease = New-Object MixCursorThemeLease($api, ([uint32[]]@(1,2,3)))
try { $lease.Activate(); throw 'missing activation error' } catch {
  if ($_.Exception.ToString() -notmatch 'apply failed') { throw }
} finally { $lease.Dispose() }
if ($api.Restored -ne 2 -or $api.Freed -ne 3) { throw 'partial activation was not rolled back' }
$api = New-Object FakeCursorTheme
$api.FailRestore = $true
$lease = New-Object MixCursorThemeLease($api, ([uint32[]]@(1)))
$lease.Activate()
$lease.Dispose()
if ($api.Resets -ne 1 -or $api.Freed -ne 1) { throw 'configured scheme fallback failed' }
$api = New-Object FakeCursorTheme
$api.FailRestore = $true
$api.ResetWorks = $false
$lease = New-Object MixCursorThemeLease($api, ([uint32[]]@(1)))
$lease.Activate()
try { $lease.Dispose(); throw 'missing cleanup error' } catch {
  if ($_.Exception.ToString() -notmatch 'input_cleanup_unconfirmed') { throw }
}
if ($api.Freed -ne 0) { throw 'lost original before recovery' }
$api.FailRestore = $false
$lease.Dispose()
if ($api.Freed -ne 1) { throw 'recovery retry leaked original' }
[Console]::WriteLine('CURSOR_THEME_GUARDS_OK')
`);
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      { timeout: 20000, windowsHide: true, env: { ...process.env, CURSOR_TEST_DIRECTORY: directory } });
    assert.match(result.stdout, /CURSOR_THEME_GUARDS_OK/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
