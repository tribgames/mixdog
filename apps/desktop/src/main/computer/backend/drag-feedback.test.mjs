import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';

test('drag completion and interrupted movement both end with release feedback', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  // Execute the actual gesture with an isolated input transport, never user32.
  const start = MIXDOG_HOST_CSHARP.indexOf('  public static void Drag(');
  const end = MIXDOG_HOST_CSHARP.indexOf('  // Named MouseWheel:', start);
  const gesture = MIXDOG_HOST_CSHARP.slice(start, end);
  const source = `
using System;
using System.Collections.Generic;
public static class GestureFixture {
  public struct POINT { public int x, y; }
  public const uint LDOWN = 2, LUP = 4;
  public static List<string> Events = new List<string>();
  public static bool Interrupt;
  static POINT point;
  static void AssertDragTarget(IntPtr target, int x, int y) {}
  static void GlideCursor(IntPtr target, int x, int y) { point.x=x; point.y=y; }
  static bool SetCursorPos(int x, int y) {
    if (Interrupt) throw new Exception("fixture interrupted");
    point.x=x; point.y=y; return true;
  }
  static POINT Cursor() { return point; }
  static void mouse_event(uint flags, int x, int y, int data, IntPtr extra) {
    Events.Add(flags == LUP ? "release" : "press");
  }
  static void ReportPointer(int x, int y, bool held) { Events.Add(held ? "drag" : "move"); }
${gesture}
}`;
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-drag-feedback-'));
  try {
    await writeFile(join(directory, 'gesture.cs'), source);
    const program = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $env:DRAG_FIXTURE 'gesture.cs')))
foreach ($interrupt in @($false, $true)) {
  [GestureFixture]::Events.Clear()
  [GestureFixture]::Interrupt = $interrupt
  try { [GestureFixture]::Drag(10,10,20,20,[IntPtr]1) } catch {
    if (-not $interrupt -or $_.Exception.ToString() -notmatch 'fixture interrupted') { throw }
  }
  [Console]::WriteLine(([GestureFixture]::Events -join ','))
}
`;
    const { stdout } = await promisify(execFile)('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', program],
      { windowsHide: true, timeout: 20000, env: { ...process.env, DRAG_FIXTURE: directory } });
    const rows = stdout.trim().split(/\r?\n/).map(row => row.split(','));
    assert.equal(rows.length, 2);
    for (const events of rows) {
      assert.equal(events.at(-1), 'release');
      assert.equal(events.filter(event => event === 'release').length, 1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
