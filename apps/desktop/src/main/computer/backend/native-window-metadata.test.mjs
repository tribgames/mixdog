import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';

test('native metadata identifies the process parent and reads OBJID_MENU without traversing a client provider', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-native-window-metadata-'));
  try {
    await writeFile(join(directory, 'native.cs'), MIXDOG_HOST_CSHARP);
    const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Accessibility
$refs = @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location)
Add-Type -ReferencedAssemblies $refs -TypeDefinition ([IO.File]::ReadAllText((Join-Path $env:METADATA_FIXTURE 'native.cs')))
$before = [MixWin32]::Foreground()
$form = [Windows.Forms.Form]::new()
$menu = [Windows.Forms.MainMenu]::new()
[void]$menu.MenuItems.Add([Windows.Forms.MenuItem]::new('&Window'))
$form.Menu = $menu
try {
  # A hidden fixture owns these handles; no desktop input or focus change.
  $handle = $form.Handle
  $info = [MixWin32]::Info($handle)
  $nodes = @([MixMsaa]::MenuSnapshot($handle, $info.Id, 50))
  @{
    pid = $info.Pid
    parentPid = $info.ParentPid
    ownPid = $PID
    names = @($nodes | ForEach-Object { ([string]$_.Name).Replace('&','') })
    selfIsChild = [MixWin32]::IsChildProcessWindow($handle,$handle)
    foregroundPreserved = ([MixWin32]::Foreground() -eq $before)
  } | ConvertTo-Json -Compress
} finally {
  $form.Dispose()
  $menu.Dispose()
}
`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 20_000,
      env: { ...process.env, METADATA_FIXTURE: directory },
    });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.pid, result.ownPid);
    assert.equal(result.parentPid, process.pid);
    assert.ok(result.names.includes('Window'));
    assert.equal(result.selfIsChild, false);
    assert.equal(result.foregroundPreserved, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
