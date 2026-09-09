import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { PS_INPUT } from './ps-input.ts';

test('pointer modifiers apply to the gesture and all owned keys release after partial failure', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-pointer-modifiers-'));
  try {
    await writeFile(join(directory, 'input.ps1'), PS_INPUT);
    await writeFile(join(directory, 'test.ps1'), String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Collections.Generic;
public static class MixWin32 {
  public static List<string> Events = new List<string>();
  public static bool FailDown, FailUp;
  public static void KeyDown(ushort key) { Events.Add("down" + key); if(FailDown && key == 16) throw new Exception("blocked"); }
  public static void KeyUp(ushort key) { Events.Add("up" + key); if(FailUp && key == 16) throw new Exception("blocked"); }
}
'@
. (Join-Path $env:FIXTURE_DIRECTORY 'input.ps1')
$results=@()
foreach($scenario in @('normal','down_failure','gesture_failure','release_failure')) {
  [MixWin32]::Events.Clear()
  [MixWin32]::FailDown=$scenario -eq 'down_failure'
  [MixWin32]::FailUp=$scenario -eq 'release_failure'
  $failure=''
  try { Invoke-PointerModifiers 'ctrl+shift' {
    [MixWin32]::Events.Add('gesture')
    if($scenario -eq 'gesture_failure') { throw 'user_input_active' }
  } } catch { $failure=$_.Exception.Message }
  $results+=@{scenario=$scenario; events=@([MixWin32]::Events); error=$failure}
}
[Console]::WriteLine(($results | ConvertTo-Json -Compress -Depth 4))
`);
    const result = await promisify(execFile)('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      { timeout: 15000, windowsHide: true, env: { ...process.env, FIXTURE_DIRECTORY: directory } });
    const rows = JSON.parse(result.stdout.trim());
    assert.deepEqual(rows[0].events, ['down17', 'down16', 'gesture', 'up16', 'up17']);
    assert.deepEqual(rows[1].events, ['down17', 'down16', 'up17']);
    assert.deepEqual(rows[2].events, rows[0].events);
    assert.match(rows[2].error, /user_input_active/);
    assert.deepEqual(rows[3].events, rows[0].events);
    assert.match(rows[3].error, /input_cleanup_unconfirmed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
