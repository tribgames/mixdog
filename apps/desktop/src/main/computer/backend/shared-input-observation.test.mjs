import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import test from 'node:test';

test('one-shot senders retain the original observer across processes and reject same-tick intervention', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-shared-observer-'));
  let child;
  let lines;
  try {
    // Real Windows message queues and shared receipts, but no OS input hooks.
    let source = await readFile(new URL('./sources/InputObservation.cs', import.meta.url), 'utf8');
    source = source.replace(
      '[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]\n  static extern System.IntPtr SetWindowsHookEx(int kind, Hook callback, System.IntPtr module, uint thread);',
      'static System.IntPtr SetWindowsHookEx(int kind, Hook callback, System.IntPtr module, uint thread) { return new System.IntPtr(1); }',
    ).replace(
      '[System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(System.IntPtr hook);',
      'static bool UnhookWindowsHookEx(System.IntPtr hook) { return true; }',
    );
    await writeFile(join(directory, 'observer.cs'), source + `
public static class MixWin32 { public static long InputTick() { return 1000; } }
public static class MixNativeInput {
  public static bool ObserveForeignOwnership;
  public static void RecordForeignKey(int key,bool held) {}
}
public static class ObserverFixture {
  public static void Foreign() {
    typeof(MixInputObservation).GetMethod("Record", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)
      .Invoke(null, new object[] {false, System.IntPtr.Zero, (uint)1000});
  }
}
`);
    const setup = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $env:OBSERVER_FIXTURE 'observer.cs')))
`;
    const env = { ...process.env, OBSERVER_FIXTURE: directory };
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', setup + String.raw`
[MixInputObservation]::Read() | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
while (($command=[Console]::ReadLine()) -ne $null) {
  [ObserverFixture]::Foreign()
  [MixInputObservation]::Read() | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
}
`], { windowsHide: true, env });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const nextSnapshot = async () => {
      let timer;
      try {
        const line = await Promise.race([
          iterator.next(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`observer timed out: ${stderr}`)), 5_000); }),
        ]);
        assert.equal(line.done, false, stderr);
        return JSON.parse(line.value);
      } finally { clearTimeout(timer); }
    };
    const original = await nextSnapshot();
    assert.equal(original.Ready, true);
    assert.equal(original.Sequence, 0);
    const probe = async () => {
      const { stdout } = await promisify(execFile)('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', setup + String.raw`
try {
  [MixInputObservation]::BeginExpected($env:ORIGINAL_OBSERVER,0)
  [MixInputObservation]::End()
  [Console]::WriteLine('accepted')
} catch { [Console]::WriteLine($_.Exception.ToString()) }
`], { windowsHide: true, timeout: 5_000, env: { ...env, ORIGINAL_OBSERVER: original.Generation } });
      return stdout.trim();
    };
    assert.equal(await probe(), 'accepted');
    child.stdin.write('foreign\n');
    const changed = await nextSnapshot();
    assert.equal(changed.Tick, original.Tick);
    assert.equal(changed.Sequence, 1);
    assert.match(await probe(), /user_input_active/);
    const exited = once(child, 'exit');
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert.match(await probe(), /input_observation_unavailable/);
  } finally {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
