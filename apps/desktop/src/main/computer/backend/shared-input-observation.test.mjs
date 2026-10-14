import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import test from 'node:test';

test('one-shot senders retain the original observer across processes, through gap recovery and replacement', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-shared-observer-'));
  let child;
  let lines;
  try {
    // Real Windows message queues and shared receipts, but no OS input hooks.
    let source = await readFile(new URL('./sources/InputObservation.cs', import.meta.url), 'utf8');
    const hookDeclaration =
      /\[System\.Runtime\.InteropServices\.DllImport\("user32\.dll", SetLastError = true\)\]\s+static extern System\.IntPtr SetWindowsHookEx\(int kind, Hook callback, System\.IntPtr module, uint thread\);/;
    const unhookDeclaration =
      /\[System\.Runtime\.InteropServices\.DllImport\("user32\.dll"\)\]\s+static extern bool UnhookWindowsHookEx\(System\.IntPtr hook\);/;
    assert.match(source, hookDeclaration, 'The fixture must replace the native hook installer before compiling');
    assert.match(source, unhookDeclaration, 'The fixture must replace native hook cleanup before compiling');
    source = source
      .replace(
        hookDeclaration,
        'static System.IntPtr SetWindowsHookEx(int kind, Hook callback, System.IntPtr module, uint thread) { ObserverFixture.Installs++; return ObserverFixture.HooksFail ? System.IntPtr.Zero : new System.IntPtr(1); }'
      )
      .replace(unhookDeclaration, 'static bool UnhookWindowsHookEx(System.IntPtr hook) { return true; }');
    // The desktop and held-key reads are fixture state too, so recovery is
    // decided only by what each step sets.
    for (const [declaration, stub] of [
      [
        /\[System\.Runtime\.InteropServices\.DllImport\("user32\.dll"\)\] static extern short GetAsyncKeyState\(int key\);/,
        'static short GetAsyncKeyState(int key) { return ObserverFixture.Held ? (short)-32768 : (short)0; }',
      ],
      [
        /\[System\.Runtime\.InteropServices\.DllImport\("user32\.dll", SetLastError = true\)\]\s+static extern System\.IntPtr OpenInputDesktop\(uint flags, bool inherit, uint access\);/,
        'static System.IntPtr OpenInputDesktop(uint flags, bool inherit, uint access) { return ObserverFixture.Desktop ? new System.IntPtr(1) : System.IntPtr.Zero; }',
      ],
      [
        /\[System\.Runtime\.InteropServices\.DllImport\("user32\.dll"\)\] static extern bool CloseDesktop\(System\.IntPtr desktop\);/,
        'static bool CloseDesktop(System.IntPtr desktop) { return true; }',
      ],
    ]) {
      assert.match(source, declaration, 'The fixture must replace desktop reads before compiling');
      source = source.replace(declaration, stub);
    }
    await writeFile(
      join(directory, 'observer.cs'),
      source +
        `
public static class MixWin32 {
  public static long Tick = 1000;
  public static long InputTick() { return System.Threading.Interlocked.Read(ref Tick); }
}
public static class MixNativeInput {
  public static bool ObserveForeignOwnership;
  public static void RecordForeignKey(int key,bool held) {}
}
public static class ObserverFixture {
  public static volatile bool HooksFail, Held, Desktop = true;
  public static volatile int Installs;
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  static extern bool PostThreadMessage(uint thread, uint message, System.UIntPtr wp, System.IntPtr lp);
  const System.Reflection.BindingFlags Hidden = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
  static void Record(bool own, uint tick) {
    typeof(MixInputObservation).GetMethod("Record", Hidden)
      .Invoke(null, new object[] {own, own ? MixInputObservation.Marker : System.IntPtr.Zero, tick});
  }
  public static void Foreign() { Record(false, (uint)MixWin32.InputTick()); }
  // Hook callbacks run on the observer thread; a posted drain puts the event there.
  public static void Own(long tick) { System.Threading.Interlocked.Exchange(ref MixWin32.Tick, tick); Record(true, (uint)tick); }
  public static void Gap(long tick) { System.Threading.Interlocked.Exchange(ref MixWin32.Tick, tick); }
  public static void Quit() {
    var run = typeof(MixInputObservation).GetField("current", Hidden).GetValue(null);
    var thread = (System.Threading.Thread)run.GetType().GetField("Thread").GetValue(run);
    PostThreadMessage((uint)typeof(MixInputObservation).GetField("threadId", Hidden).GetValue(null), 0x12, System.UIntPtr.Zero, System.IntPtr.Zero);
    if (!thread.Join(5000)) throw new System.Exception("observer thread did not exit");
  }
}
`
    );
    const setup = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $env:OBSERVER_FIXTURE 'observer.cs')))
`;
    const env = { ...process.env, OBSERVER_FIXTURE: directory };
    child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        setup +
          `
function Emit($extra) {
  $value = [MixInputObservation]::Read()
  $reply = [ordered]@{
    Ready = $value.Ready; Reason = $value.Reason; Generation = $value.Generation
    Sequence = $value.Sequence; Tick = $value.Tick; Installs = [ObserverFixture]::Installs
  }
  if ($extra) { foreach ($key in $extra.Keys) { $reply[$key] = $extra[$key] } }
  [Console]::WriteLine(($reply | ConvertTo-Json -Compress))
}
Emit
while (($line=[Console]::ReadLine()) -ne $null) {
  $command, $argument = $line -split ':', 2
  $extra = $null
  switch ($command) {
    'foreign' { [ObserverFixture]::Foreign() }
    'gap' { [ObserverFixture]::Gap([long]$argument) }
    'own' { [ObserverFixture]::Own([long]$argument) }
    'held' { [ObserverFixture]::Held = $argument -eq '1' }
    'desktop' { [ObserverFixture]::Desktop = $argument -eq '1' }
    'hooks-fail' { [ObserverFixture]::HooksFail = $argument -eq '1' }
    'settle' {
      # Long enough for several recovery observations; the outcome must not change.
      $states = for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Milliseconds 60; [MixInputObservation]::Read().Ready }
      $extra = @{ EverReady = ($states -contains $true) }
    }
    'recover' {
      $clock = [Diagnostics.Stopwatch]::StartNew()
      while (-not [MixInputObservation]::Read().Ready -and $clock.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 50 }
      $extra = @{ RecoveredMs = $clock.ElapsedMilliseconds }
    }
    'begin' {
      try { [MixInputObservation]::Begin(); $extra = @{ Action = 'begun' } } catch { $extra = @{ Action = $_.Exception.InnerException.Message } }
    }
    'assert' {
      try { [MixInputObservation]::AssertContinue(); $extra = @{ Action = 'continued' } } catch { $extra = @{ Action = $_.Exception.InnerException.Message } }
    }
    'end' { [MixInputObservation]::End() }
    'quit' { [ObserverFixture]::Quit() }
  }
  Emit $extra
}
`,
      ],
      { windowsHide: true, env }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    // Each snapshot line is the observer's reply; waiting for it (or for the
    // stream to end when the observer dies) is the synchronization. A wall-clock
    // cap here only measured PowerShell startup and Add-Type compile time.
    const nextSnapshot = async () => {
      const line = await iterator.next();
      assert.equal(line.done, false, stderr);
      return JSON.parse(line.value);
    };
    const send = async (line) => {
      child.stdin.write(`${line}\n`);
      return nextSnapshot();
    };
    const original = await nextSnapshot();
    assert.equal(original.Ready, true);
    assert.equal(original.Reason, '');
    assert.equal(original.Sequence, 0);
    // A probe process shares the fixture's system clock through FIXTURE_TICK.
    const probe = async (sequence = 0, tick = 1000) => {
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          setup +
            `
[MixWin32]::Tick = [long]$env:FIXTURE_TICK
try {
  [MixInputObservation]::BeginExpected($env:ORIGINAL_OBSERVER,[long]$env:EXPECTED_SEQUENCE)
  [MixInputObservation]::End()
  [Console]::WriteLine('accepted')
} catch { [Console]::WriteLine($_.Exception.ToString()) }
`,
        ],
        {
          windowsHide: true,
          env: {
            ...env,
            ORIGINAL_OBSERVER: original.Generation,
            EXPECTED_SEQUENCE: String(sequence),
            FIXTURE_TICK: String(tick),
          },
        }
      );
      return stdout.trim();
    };
    assert.equal(await probe(), 'accepted');
    const changed = await send('foreign');
    assert.equal(changed.Tick, original.Tick);
    assert.equal(changed.Sequence, 1);
    assert.match(await probe(), /user_input_active/);

    // An in-flight action, then input the hooks never saw.
    assert.equal((await send('begin')).Action, 'begun');
    // Held input keeps the gap open while it is inspected; recovery is otherwise automatic.
    await send('held:1');
    const gap = await send('gap:1001');
    assert.equal(gap.Ready, false);
    assert.equal(gap.Reason, 'input_gap');
    assert.equal(gap.Sequence, 2, 'the missed input counts as foreign input');
    const reinstalled = await send('own:1001');
    assert.equal(reinstalled.Installs, original.Installs + 2, 'both hooks are reinstalled on a gap');
    assert.equal(reinstalled.Ready, false, 'an own event restoring tick equality does not close the gap');
    assert.equal(reinstalled.Sequence, 2);
    assert.match((await send('assert')).Action, /^input_observation_unavailable:.*input_gap/);
    assert.match(await probe(1, 1001), /input_observation_unavailable:.*input_gap/);
    // Recovery waits for an accessible desktop with nothing held.
    assert.equal((await send('settle')).EverReady, false, 'held input was treated as quiet');
    await send('held:0');
    await send('desktop:0');
    assert.equal((await send('settle')).EverReady, false, 'an inaccessible desktop was treated as quiet');
    await send('desktop:1');
    const recovered = await send('recover');
    assert.equal(recovered.Ready, true, `observer did not recover within ${recovered.RecoveredMs}ms`);
    assert.equal(recovered.Generation, original.Generation);
    assert.equal(recovered.Sequence, 2, 'recovery neither resets nor rebases the sequence');
    assert.equal(recovered.Tick, 1001);
    assert.match((await send('assert')).Action, /^user_input_active:/);
    await send('end');
    assert.match(await probe(1, 1001), /user_input_active/, 'a stale expected sequence passed after recovery');
    assert.equal(await probe(2, 1001), 'accepted', 'a fresh action cannot start after recovery');

    // A failed reinstall keeps the observer unavailable until hooks return.
    await send('hooks-fail:1');
    const failing = await send('gap:1002');
    assert.equal(failing.Ready, false);
    assert.equal(failing.Sequence, 3);
    const unhooked = await send('settle');
    assert.equal(unhooked.EverReady, false);
    assert.equal(unhooked.Reason, 'hooks_unavailable');
    await send('hooks-fail:0');
    const rehooked = await send('recover');
    assert.equal(rehooked.Ready, true, `observer did not recover within ${rehooked.RecoveredMs}ms`);
    assert.equal(rehooked.Sequence, 3);

    // A dead observer thread is replaced under a fresh generation; nothing
    // authorized against the original carries over.
    assert.equal((await send('begin')).Action, 'begun');
    const replaced = await send('quit');
    assert.equal(replaced.Ready, true);
    assert.notEqual(replaced.Generation, original.Generation);
    assert.match((await send('assert')).Action, /^input_observation_unavailable:.*replaced/);
    await send('end');
    assert.match(await probe(3, 1002), /input_observation_unavailable/, 'the dead original monitor answered');
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
