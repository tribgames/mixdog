import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { MIXDOG_INPUT_TRANSPORT_CSHARP } from './native-source.ts';
import { ABORT_CLEANUP_PROGRAM } from './program.ts';

test('checked input releases only partial held input and acknowledges every cleanup failure', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const fixture = MIXDOG_INPUT_TRANSPORT_CSHARP + `
public static class TransportFixture {
  static int calls, downs, ups;
  static bool held, rejectRelease;
  static uint accepted;
  static uint Send(MixNativeInput.INPUT[] inputs) {
    calls++;
    uint count = calls == 1 ? accepted : rejectRelease ? 0u : (uint)inputs.Length;
    for (int i = 0; i < count; i++) {
      bool up = inputs[i].type == 1 ? (inputs[i].U.ki.dwFlags & 2) != 0
        : (inputs[i].U.mi.dwFlags & 4) != 0;
      if (up) { ups++; held = false; } else { downs++; held = true; }
    }
    return count;
  }
  static void Require(bool ok, string message) { if (!ok) throw new System.Exception(message); }
  public static void Run() {
    var marker = new System.IntPtr(123);
    var batches = new MixNativeInput.INPUT[][] {
      new [] { MixNativeInput.Key(13,0,0,marker), MixNativeInput.Key(13,0,2,marker) },
      new [] { MixNativeInput.Key(0,65,4,marker), MixNativeInput.Key(0,65,6,marker) },
      new [] { MixNativeInput.Mouse(2,marker), MixNativeInput.Mouse(4,marker) }
    };
    foreach (var batch in batches) {
      for (uint count = 0; count <= 2; count++) {
        calls = downs = ups = 0; held = false; accepted = count; rejectRelease = false;
        string code = "";
        try { MixNativeInput.Deliver(batch, Send); }
        catch (System.Exception error) { code = error.Message; }
        Require(!held, "partial input remained held");
        Require(downs == (count == 0 ? 0 : 1), "positive input was replayed");
        Require(calls == (count == 1 ? 2 : 1), "unexpected retry");
        Require(count == 2 ? code == "" : code.StartsWith("input_delivery_failed:"), "lost delivery outcome");
      }
    }
    calls = downs = ups = 0; accepted = 1; rejectRelease = true;
    try { MixNativeInput.Deliver(batches[0], Send); throw new System.Exception("missing cleanup failure"); }
    catch (System.Exception error) { Require(error.Message.StartsWith("input_cleanup_unconfirmed:"), error.Message); }
    Require(calls == 2 && downs == 1, "failed release retried or action replayed");
    int attempts = 0; bool enter = false, rightControlExtended = false;
    var ownedMarker = new System.IntPtr(System.Diagnostics.Process.GetCurrentProcess().Id + 1000000);
    var heldBatch = new [] { MixNativeInput.Key(13,0,0,ownedMarker),
      MixNativeInput.Key(0xA3,0,1,ownedMarker), MixNativeInput.Mouse(2,ownedMarker) };
    MixNativeInput.DeliverTracked(heldBatch, ownedMarker, delegate(MixNativeInput.INPUT[] inputs) { return (uint)inputs.Length; });
    MixNativeInput.RecordForeignKey(0x10, true);
    MixNativeInput.RecordForeignKey(0xA3, true);
    int conflictingReleases = 0;
    uint conflicting = MixNativeInput.DeliverTracked(new [] { MixNativeInput.Key(0xA3,0,3,ownedMarker) },
      ownedMarker, delegate(MixNativeInput.INPUT[] inputs) { conflictingReleases++; return 1; });
    Require(conflicting == 0 && conflictingReleases == 0, "released a key now held by the user");
    MixNativeInput.RecordForeignKey(0xA3, false);
    try {
      MixNativeInput.ReleaseOwned(ownedMarker, delegate(MixNativeInput.INPUT[] inputs) {
        attempts++;
        var input = inputs[0];
        if (input.type == 1) {
          Require((input.U.ki.dwFlags & 2) != 0, "cleanup pressed a key");
          if (input.U.ki.wVk == 13) enter = true;
          if (input.U.ki.wVk == 0xA3) rightControlExtended = (input.U.ki.dwFlags & 1) != 0;
          Require(input.U.ki.wVk != 0x10, "released user-owned Shift");
        } else Require((input.U.mi.dwFlags & ~(4u|16u|64u)) == 0, "cleanup moved or pressed pointer");
        return attempts == 1 ? 0u : 1u;
      });
      throw new System.Exception("missing emergency release failure");
    } catch (System.Exception error) { Require(error.Message.StartsWith("input_cleanup_unconfirmed:"), error.Message); }
    Require(attempts == 3 && enter && rightControlExtended, "cleanup did not release exactly the owned inputs");
    try {
      MixNativeInput.ReleaseOwned(ownedMarker, delegate(MixNativeInput.INPUT[] inputs) { attempts++; return 1; });
      throw new System.Exception("missing latched cleanup failure");
    } catch (System.Exception error) { Require(error.Message.StartsWith("input_cleanup_unconfirmed:"), error.Message); }
    Require(attempts == 3, "failed emergency release was retried");
  }
}`;
  const encoded = Buffer.from(fixture).toString('base64');
  // Compile the actual abort program in a separate type namespace without invoking it.
  const abortSource = ABORT_CLEANUP_PROGRAM.split('Add-Type @"')[1].split('"@')[0];
  const encodedAbort = Buffer.from(`namespace AbortFixture { ${abortSource} }`).toString('base64');
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))
[TransportFixture]::Run()
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedAbort}')))
[Console]::WriteLine('CHECKED_TRANSPORT_OK')`;
  const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$source=[Console]::In.ReadToEnd(); & ([scriptblock]::Create($source))'],
  { windowsHide: true, timeout: 20000 });
  const completed = new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  child.stdin.end(script);
  assert.match(await completed, /CHECKED_TRANSPORT_OK/);
});
