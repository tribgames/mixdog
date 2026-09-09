import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { loadComputerSource } from './native-assets.ts';

test('watchdog protocol preserves late restoration evidence without concurrent reads or input replay', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-cursor-protocol-'));
  try {
    await writeFile(join(directory, 'protocol.cs'), loadComputerSource('CursorTheme.cs') + String.raw`
public class FakeSnapshot { public bool Ready = true; public long Sequence; }
public static class MixInputObservation {
  public static System.IntPtr Marker = new System.IntPtr(1);
  public static string Scenario;
  public static int Checks;
  public static void AssertContinue() {
    Checks++;
    if(Scenario == "user" && Checks >= 2) throw new System.Exception("user_input_active: fixture");
  }
  public static FakeSnapshot Read() { return new FakeSnapshot(); }
  public static bool IdleDesktopReady() { return true; }
}
public static class CursorProtocolFixture {
  public static string Run(string scenario) {
    string name = "mixdog-protocol-" + System.Guid.NewGuid().ToString("N");
    using(var server = new System.IO.Pipes.NamedPipeServerStream(name, System.IO.Pipes.PipeDirection.InOut, 1,
      System.IO.Pipes.PipeTransmissionMode.Byte, System.IO.Pipes.PipeOptions.Asynchronous))
    using(var ready = new System.Threading.ManualResetEvent(false)) {
      System.Exception peerError = null;
      int activations = 0;
      var peer = new System.Threading.Thread(() => {
        try {
          using(var pipe = new System.IO.Pipes.NamedPipeClientStream(".", name, System.IO.Pipes.PipeDirection.InOut))
          {
            pipe.Connect(1000);
            using(var input = new System.IO.StreamReader(pipe))
            using(var output = new System.IO.StreamWriter(pipe) { AutoFlush = true }) {
              ready.Set(); output.WriteLine("READY");
              if(input.ReadLine() != "ACTIVATE") throw new System.Exception("missing activation");
              activations++;
              if(scenario == "lost") return;
              if(scenario == "early") { output.WriteLine("RESTORED"); return; }
              if(scenario == "late") System.Threading.Thread.Sleep(350);
              output.WriteLine("ACTIVE");
              if(input.ReadLine() != "END") throw new System.Exception("missing end");
              output.WriteLine("RESTORED");
            }
          }
        } catch(System.Exception error) { peerError = error; ready.Set(); }
      });
      peer.IsBackground = true; peer.Start();
      server.WaitForConnection();
      if(!ready.WaitOne(1000)) throw new System.Exception(scenario + ": peer not ready");
      var guard = new MixCursorTheme(server);
      MixInputObservation.Scenario = scenario; MixInputObservation.Checks = 0;
      bool activated = false, restored = false;
      string activationError = "";
      try { guard.Activate(scenario == "late" ? 100 : 1000); activated = true; }
      catch(System.Exception error) { activationError = error.Message; }
      try { guard.Dispose(); restored = true; }
      catch(System.Exception error) {
        if(!error.Message.StartsWith("input_cleanup_unconfirmed:")) throw;
      }
      if(!peer.Join(1000)) throw new System.Exception("peer did not exit");
      if(peerError != null) throw peerError;
      if(activations != 1) throw new System.Exception("activation replayed");
      if(scenario == "user" && !activationError.StartsWith("user_input_active:")) throw new System.Exception("lost user interruption");
      return scenario + ":" + activated + ":" + restored;
    }
  }
}
`);
    await writeFile(join(directory, 'test.ps1'), String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll') -TypeDefinition (
  [IO.File]::ReadAllText((Join-Path $env:FIXTURE_DIRECTORY 'protocol.cs')))
foreach($scenario in @('normal','late','early','lost','user')) {
  [Console]::WriteLine([CursorProtocolFixture]::Run($scenario))
}
`);
    const { stdout } = await promisify(execFile)('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      { timeout: 20000, windowsHide: true, env: { ...process.env, FIXTURE_DIRECTORY: directory } });
    assert.deepEqual(stdout.trim().split(/\r?\n/), [
      'normal:True:True', 'late:False:True', 'early:False:True', 'lost:False:False', 'user:False:True',
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
