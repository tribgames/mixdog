import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_BOUNDED_UIA_CSHARP } from './native-source.ts';

// Stub MSAA provider: a walk that finds `Count` nodes and counts every refresh.
const MSAA_STUB = `
public sealed class MixMsaaNode {
  public static int Refreshes;
  public bool Refresh() { Refreshes++; return true; }
}
public static class MixMsaa {
  public static int Count;
  public static MixMsaaNode[] Snapshot(System.IntPtr hwnd, string windowId, int maximum) {
    var nodes = new MixMsaaNode[Count];
    for (int i = 0; i < Count; i++) nodes[i] = new MixMsaaNode();
    return nodes;
  }
}
`;

test('an over-limit MSAA walk is refused before any node is refreshed, with or without a deadline', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-bounded-uia-'));
  try {
    await writeFile(join(directory, 'native.cs'), `${MSAA_STUB}\n${MIXDOG_BOUNDED_UIA_CSHARP}`);
    await writeFile(
      join(directory, 'test.ps1'),
      `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -ReferencedAssemblies @('System.dll', 'System.Core.dll',
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.TreeScope].Assembly.Location,
    [System.Windows.Rect].Assembly.Location) -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'native.cs')))
[MixMsaa]::Count = 5000
foreach ($deadline in @($null, (New-Object MixUiaDeadline 5000))) {
  [MixMsaaNode]::Refreshes = 0
  $refused = ''
  try { [void][MixBoundedUia]::MsaaSnapshot($deadline, [IntPtr]1, 'hwnd:0x1', 5000, 1) }
  catch { $refused = $_.Exception.InnerException.Message }
  if ($refused -ne 'accessibility candidate limit exceeded: 5001 > 5000; narrow the role/query') { throw "not refused: $refused" }
  if ([MixMsaaNode]::Refreshes -ne 0) { throw "refreshed $([MixMsaaNode]::Refreshes) nodes before the limit check" }
}
# At the limit the walk is still served and every node refreshed.
$read = [MixBoundedUia]::MsaaSnapshot($null, [IntPtr]1, 'hwnd:0x1', 5000, 0)
if ($read.Candidates -ne 5000 -or $read.Nodes.Length -ne 5000 -or [MixMsaaNode]::Refreshes -ne 5000) { throw 'an in-limit walk was not served' }
'ok'
`
    );
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(directory, 'test.ps1')],
      { windowsHide: true, timeout: 60_000, env: { ...process.env, AUDIT_DIRECTORY: directory } }
    );
    assert.equal(stdout.trim(), 'ok');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
