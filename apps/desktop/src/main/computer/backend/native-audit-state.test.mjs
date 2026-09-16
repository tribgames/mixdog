import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';
import { PS_RUNTIME } from './ps-runtime.ts';

test('native dispatch rejects old observations, clipped cursors, and stale message error codes without desktop input', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-native-audit-state-'));
  try {
    const observation = await readFile(new URL('./sources/InputObservation.cs', import.meta.url), 'utf8');
    const stateMethods = observation.slice(observation.indexOf('  public static void Begin()'));
    const messageMethods = MIXDOG_HOST_CSHARP.slice(
      MIXDOG_HOST_CSHARP.indexOf('  static UIntPtr SendMessageValue('),
      MIXDOG_HOST_CSHARP.indexOf('  static Action BindBackgroundRelease(')
    );
    const pointerMethods = MIXDOG_HOST_CSHARP.slice(
      MIXDOG_HOST_CSHARP.indexOf('  public static void AssertCursorPosition('),
      MIXDOG_HOST_CSHARP.indexOf('  static void AssertDragTarget(')
    );
    await writeFile(
      join(directory, 'fixture.cs'),
      `
using System;
public class MixInputSnapshot { public bool Ready; public string Generation; public long Sequence; }
public static class MixInputObservation {
  static int actionDepth;
  static long? actionSequence;
  public static Action DispatchAuthorization;
  public static MixInputSnapshot Snapshot = new MixInputSnapshot { Ready=true, Generation="original", Sequence=3 };
  public static MixInputSnapshot Read() { return Snapshot; }
  static MixInputSnapshot ReadMonitor(string id) { return new MixInputSnapshot { Ready=false, Generation=id }; }
${stateMethods}
public static class NativeFixture {
  public struct POINT { public int x,y; }
  public static int Presses, Releases, LastError=5;
  public static bool Clipped;
  static POINT point;
  const uint LDOWN=2,LUP=4,RDOWN=8,RUP=16,MDOWN=32,MUP=64,SMTO_BLOCK=1,SMTO_ABORTIFHUNG=2;
  static void SetCursorPos(int x,int y) { point.x=Clipped ? x+1:x; point.y=y; }
  static POINT Cursor() { return point; }
  static void mouse_event(uint flags,int x,int y,int data,IntPtr extra) { if (flags==LDOWN) Presses++; }
  static void ClearMessageError(uint value) { LastError=(int)value; }
  static class Marshal { public static int GetLastWin32Error() { return LastError; } }
  static IntPtr SendMessageTimeout(IntPtr h,uint msg,UIntPtr wp,IntPtr lp,uint flags,uint timeout,out UIntPtr result) {
    result=UIntPtr.Zero; return IntPtr.Zero;
  }
${messageMethods}
${pointerMethods}
  public static void FailedPress() {
    WithBackgroundRelease(
      delegate { SendMessageValue(new IntPtr(1), 0x201, UIntPtr.Zero, IntPtr.Zero); },
      delegate {}, delegate { Releases++; });
  }
}
`
    );
    await writeFile(join(directory, 'runtime.ps1'), PS_RUNTIME);
    const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $env:AUDIT_FIXTURE 'fixture.cs')))
function Get-SessionState($id) { return @{} }
function Assert-ExecutionAuthorization($req) {}
$script:dispatched=0
function Do-Drag($req) { $script:dispatched++;return @{ok=$true} }
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:AUDIT_FIXTURE 'runtime.ps1'),[ref]$tokens,[ref]$errors)
$node=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Handle'},$true)
. ([scriptblock]::Create($node.Extent.Text))
$req=@{action='drag';delivery='foreground';observed_input_monitor_id='original';observed_input_user_sequence=3}
$null=Handle $req
[MixInputObservation]::Snapshot.Sequence=4
$caught=@()
try { Handle $req } catch { $caught += $_.Exception.ToString() }
[MixInputObservation]::Snapshot.Sequence=3
[MixInputObservation]::Snapshot.Generation='replacement'
try { Handle $req } catch { $caught += $_.Exception.ToString() }
[MixInputObservation]::Snapshot.Generation='original'
[NativeFixture]::Clipped=$true
try { [NativeFixture]::Click(10,20) } catch { $caught += $_.Exception.ToString() }
[NativeFixture]::Clipped=$false
[NativeFixture]::Click(10,20)
try { [NativeFixture]::FailedPress() } catch { $caught += $_.Exception.ToString() }
@{dispatched=$script:dispatched;presses=[NativeFixture]::Presses;releases=[NativeFixture]::Releases;errors=$caught} | ConvertTo-Json -Compress
`;
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 15_000,
        env: { ...process.env, AUDIT_FIXTURE: directory },
      }
    );
    const result = JSON.parse(stdout.trim());
    assert.equal(result.dispatched, 1);
    assert.equal(result.presses, 1);
    assert.equal(result.releases, 1);
    assert.equal(result.errors.length, 4);
    for (const [index, pattern] of [
      /user_input_active/,
      /input_observation_unavailable/,
      /target_mismatch/,
      /background_target_hung/,
    ].entries()) {
      assert.match(result.errors[index], pattern);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
