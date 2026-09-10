import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MIXDOG_INPUT_TRANSPORT_CSHARP } from './native-source.ts';

test('ownership survives an input worker exit and refuses an unacknowledged native prefix', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-owned-input-'));
  const assembly = join(directory, 'ownership.dll');
  const source = MIXDOG_INPUT_TRANSPORT_CSHARP + `
public static class OwnershipFixture {
  public static void Press(int marker) {
    var tag = new System.IntPtr(marker);
    MixNativeInput.DeliverTracked(new [] { MixNativeInput.Key(0x11,0,0,tag), MixNativeInput.Mouse(2,tag) },
      tag, delegate(MixNativeInput.INPUT[] inputs) { return (uint)inputs.Length; });
  }
  public static void Check(int marker) {
    var tag = new System.IntPtr(marker);
    int released = 0;
    MixNativeInput.ReleaseOwned(tag, delegate(MixNativeInput.INPUT[] inputs) {
      var input = inputs[0];
      if (input.type == 1 ? input.U.ki.wVk != 0x11 || input.U.ki.dwFlags != 2 : input.U.mi.dwFlags != 4)
        throw new System.Exception("unowned input was released");
      released++;
      return 1;
    });
    if (released != 2) throw new System.Exception("worker ownership was lost");
    MixNativeInput.ReleaseOwned(tag, delegate(MixNativeInput.INPUT[] inputs) { released++; return 1; });
    if (released != 2) throw new System.Exception("completed releases were repeated");
    try {
      MixNativeInput.DeliverTracked(new [] { MixNativeInput.Key(13,0,0,tag) }, tag,
        delegate(MixNativeInput.INPUT[] inputs) { throw new System.Exception("lost delivery receipt"); });
    } catch (System.Exception) { }
    try {
      MixNativeInput.ReleaseOwned(tag, delegate(MixNativeInput.INPUT[] inputs) { released++; return 1; });
      throw new System.Exception("missing ownership uncertainty");
    } catch (System.Exception error) {
      if (!error.Message.StartsWith("input_cleanup_unconfirmed:")) throw;
    }
    if (released != 2) throw new System.Exception("guessed an unacknowledged prefix");
  }
}`;
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString('base64')}'))) -OutputAssembly ${quote(assembly)}
[void][Reflection.Assembly]::LoadFrom(${quote(assembly)})
$marker = $PID + 2000000
[MixNativeInput]::InitializeOwnership([IntPtr]$marker)
$childSource = "[void][Reflection.Assembly]::LoadFrom('${assembly.replaceAll("'", "''")}'); [OwnershipFixture]::Press($marker); [Console]::WriteLine('OWNED'); [Threading.Thread]::Sleep(60000)"
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = 'powershell.exe'
$info.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childSource))
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$child = [Diagnostics.Process]::Start($info)
try {
  $ready = $child.StandardOutput.ReadLineAsync()
  if (-not $ready.Wait(10000) -or $ready.Result -ne 'OWNED') { throw 'ownership fixture failed to start' }
  $child.Kill()
  if (-not $child.WaitForExit(3000)) { throw 'fixture worker did not stop' }
  [OwnershipFixture]::Check($marker)
  [Console]::WriteLine('OWNERSHIP_OK')
} finally {
  if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit(3000) | Out-Null }
  $child.Dispose()
}`;
  try {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$source=[Console]::In.ReadToEnd(); & ([scriptblock]::Create($source))'],
    { windowsHide: true, timeout: 25000 });
    const completed = new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout)));
    });
    child.stdin.end(script);
    assert.match(await completed, /OWNERSHIP_OK/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
