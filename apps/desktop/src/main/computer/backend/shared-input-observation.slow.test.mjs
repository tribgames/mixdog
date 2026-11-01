import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import test from 'node:test';

// Real Windows message queues and shared receipts, but no OS input hooks.
async function writeObserverFixture(directory) {
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
    // Fixture windows: the window under a point is its x coordinate, and
    // window n belongs to process n.
    [
      /\[System\.Runtime\.InteropServices\.DllImport\("user32\.dll"\)\] static extern System\.IntPtr GetForegroundWindow\(\);/,
      'static System.IntPtr GetForegroundWindow() { return new System.IntPtr(ObserverFixture.Foreground); }',
    ],
    [
      /\[System\.Runtime\.InteropServices\.DllImport\("user32\.dll"\)\] static extern System\.IntPtr WindowFromPoint\(POINT point\);/,
      'static System.IntPtr WindowFromPoint(POINT point) { return new System.IntPtr(point.x); }',
    ],
    [
      /\[System\.Runtime\.InteropServices\.DllImport\("user32\.dll"\)\] static extern System\.IntPtr GetAncestor\(System\.IntPtr window, uint flags\);/,
      'static System.IntPtr GetAncestor(System.IntPtr window, uint flags) { return ObserverFixture.Root == 0 ? window : new System.IntPtr(ObserverFixture.Root); }',
    ],
    [
      /\[System\.Runtime\.InteropServices\.DllImport\("user32\.dll"\)\] static extern uint GetWindowThreadProcessId\(System\.IntPtr window, out uint process\);/,
      'static uint GetWindowThreadProcessId(System.IntPtr window, out uint process) { process = (uint)window.ToInt64(); return 1; }',
    ],
    [
      /\[System\.Runtime\.InteropServices\.DllImport\("user32\.dll"\)\] static extern bool GetGUIThreadInfo\(uint thread, ref GUITHREADINFO info\);/,
      'static bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info) { if (ObserverFixture.CaptureUnreadable) return false; info.capture = new System.IntPtr(ObserverFixture.Capture); return true; }',
    ],
    // Drains still go through the real thread queue; the fixture sees each one posted.
    [
      /\[System\.Runtime\.InteropServices\.DllImport\("user32\.dll"\)\] static extern bool PostThreadMessage\(uint thread, uint message, System\.UIntPtr wp, System\.IntPtr lp\);/,
      'static bool PostThreadMessage(uint thread, uint message, System.UIntPtr wp, System.IntPtr lp) { return ObserverFixture.Post(thread, message, wp, lp); }',
    ],
  ]) {
    assert.match(source, declaration, 'The fixture must replace every stubbed native call before compiling');
    source = source.replace(declaration, stub);
  }
  await writeFile(
    join(directory, 'observer.cs'),
    source +
      `
public static class MixWin32 {
  public static long Tick = 1000;
  public static long InputTick() {
    // A held observer stalls inside the drain it is answering.
    if (ObserverFixture.Hold && System.Threading.Thread.CurrentThread.Name == "Mixdog input observation") ObserverFixture.Gate.Wait();
    return System.Threading.Interlocked.Read(ref Tick);
  }
}
public static class MixNativeInput {
  public static bool ObserveForeignOwnership;
  public static void RecordForeignKey(int key,bool held) {}
}
public static class ObserverFixture {
  public static volatile bool HooksFail, Held, Desktop = true;
  public static volatile int Installs;
  public static long Foreground, Root, Capture;
  public static bool CaptureUnreadable;
  public static volatile bool Hold;
  public static readonly System.Threading.SemaphoreSlim Gate = new System.Threading.SemaphoreSlim(0);
  static volatile System.Threading.SemaphoreSlim posted;
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  static extern bool PostThreadMessage(uint thread, uint message, System.UIntPtr wp, System.IntPtr lp);
  public static bool Post(uint thread, uint message, System.UIntPtr wp, System.IntPtr lp) {
    bool sent = PostThreadMessage(thread, message, wp, lp);
    var watcher = posted;
    if (watcher != null) watcher.Release();
    return sent;
  }
  // Reader A's drain stalls in the observer until A gives up. Reader B then
  // asks about another target, and A's late receipt is published while B
  // waits; B's own drain stays stalled for as long as B waits.
  public static MixInputSnapshot[] StaleReceipt(long first, long second) {
    Hold = true;
    MixInputSnapshot early = MixInputObservation.ReadFor(new System.IntPtr(first));
    posted = new System.Threading.SemaphoreSlim(0);
    MixInputSnapshot later = null;
    var reader = new System.Threading.Thread(() => { later = MixInputObservation.ReadFor(new System.IntPtr(second)); });
    reader.Start();
    posted.Wait();
    Gate.Release();
    reader.Join();
    posted = null;
    Hold = false;
    Gate.Release();
    return new MixInputSnapshot[] { early, later };
  }
  const System.Reflection.BindingFlags Hidden = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
  // Each reader draws its first request ids in a fresh AppDomain: every static
  // of the allocator restarts in the same process, as it would in a replacement
  // reader process that reuses a departed reader's PID.
  public static string[][] RequestIds(int readers, int count) {
    var setup = new System.AppDomainSetup { ApplicationBase = System.IO.Path.GetDirectoryName(typeof(ObserverFixture).Assembly.Location) };
    var drawn = new string[readers][];
    for (int i = 0; i < readers; i++) {
      var domain = System.AppDomain.CreateDomain("reader" + i, null, setup);
      try {
        domain.SetData("count", count);
        domain.DoCallBack(DrawRequests);
        drawn[i] = (string[])domain.GetData("ids");
      } finally { System.AppDomain.Unload(domain); }
    }
    return drawn;
  }
  static void DrawRequests() {
    int count = (int)System.AppDomain.CurrentDomain.GetData("count");
    var next = typeof(MixInputObservation).GetMethod("NextRequest", Hidden);
    var ids = new string[count];
    for (int i = 0; i < count; i++) ids[i] = ((long)next.Invoke(null, null)).ToString();
    System.AppDomain.CurrentDomain.SetData("ids", ids);
  }
  static void Record(bool own, uint tick) {
    typeof(MixInputObservation).GetMethod("Record", Hidden).Invoke(null, new object[] {own, tick, false, null});
  }
  public static void Foreign() { Record(false, (uint)MixWin32.InputTick()); }
  static object Struct(string name) {
    return System.Activator.CreateInstance(typeof(MixInputObservation).GetNestedType(name, System.Reflection.BindingFlags.NonPublic));
  }
  static void Set(object value, string field, object content) { value.GetType().GetField(field).SetValue(value, content); }
  // Calls the low-level hook itself with a physical (unmarked) event.
  static void Hook(string hook, int message, object value) {
    System.IntPtr data = System.Runtime.InteropServices.Marshal.AllocHGlobal(System.Runtime.InteropServices.Marshal.SizeOf(value));
    try {
      System.Runtime.InteropServices.Marshal.StructureToPtr(value, data, false);
      typeof(MixInputObservation).GetMethod(hook, Hidden).Invoke(null, new object[] {0, new System.IntPtr(message), data});
    } finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(data); }
  }
  public static void Key(long foreground) {
    Foreground = foreground;
    object key = Struct("KEY");
    Set(key, "vk", 0x41u);
    Set(key, "time", (uint)MixWin32.InputTick());
    Hook("OnKey", 0x100, key);
  }
  // A mouse message over window hit, whose top level is root (0: itself).
  public static void Mouse(int message, int hit, long root) {
    Root = root;
    object point = Struct("POINT");
    Set(point, "x", hit);
    object mouse = Struct("MOUSE");
    Set(mouse, "point", point);
    Set(mouse, "time", (uint)MixWin32.InputTick());
    Hook("OnMouse", message, mouse);
  }
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
}

const setup = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $env:OBSERVER_FIXTURE 'observer.cs')))
`;

test('one-shot senders retain the original observer across processes, through gap recovery and replacement', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-shared-observer-'));
  let child;
  let lines;
  try {
    await writeObserverFixture(directory);
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
    'foreground' { [ObserverFixture]::Foreground = [long]$argument }
    'capture' { [ObserverFixture]::Capture = [long]$argument }
    'capture-unreadable' { [ObserverFixture]::CaptureUnreadable = $argument -eq '1' }
    'key' { [ObserverFixture]::Key([long]$argument) }
    'mouse' {
      $message, $hit, $root = $argument -split ':'
      [ObserverFixture]::Mouse([int]$message, [int]$hit, [long]$root)
    }
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
      try {
        if ($argument) {
          $target, $pointer = $argument -split ':'
          [MixInputObservation]::Begin([IntPtr][long]$target, $pointer -eq '1')
        }
        else { [MixInputObservation]::Begin() }
        $extra = @{ Action = 'begun' }
      } catch { $extra = @{ Action = $_.Exception.InnerException.Message } }
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
    const probe = async (sequence = 0, tick = 1000, { target = 0, pointer = false } = {}) => {
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
  [MixInputObservation]::BeginExpected($env:ORIGINAL_OBSERVER,[long]$env:EXPECTED_SEQUENCE,[IntPtr][long]$env:PROBE_TARGET,$env:PROBE_POINTER -eq '1')
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
            PROBE_TARGET: String(target),
            PROBE_POINTER: pointer ? '1' : '0',
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

    // Input reaches an action only through its target's process, or through
    // the shared pointer while the action itself drives it. Window n belongs
    // to process n; the target is 55 and the user works in 77.
    const scoped = (sequence, target, pointer = false) => probe(sequence, 1002, { target, pointer });
    assert.equal((await send('key:77')).Sequence, 4);
    assert.equal(await scoped(3, 55), 'accepted', 'typing into another process refused the target action');
    assert.match(await scoped(3, 77), /user_input_active/, 'typing into the target process was missed');
    assert.match(await probe(3, 1002), /user_input_active/, 'an action with no known target ignored input');
    assert.equal((await send('mouse:512:77:0')).Sequence, 5);
    assert.equal(await scoped(3, 55, true), 'accepted', 'pointer input before the action drove the pointer refused it');
    await send('foreground:55');
    assert.equal((await send('mouse:522:77:0')).Sequence, 6);
    assert.match(await scoped(5, 55), /user_input_active/, 'a wheel the foreground target may receive was missed');
    await send('foreground:77');
    assert.equal((await send('mouse:513:66:55')).Sequence, 7);
    assert.match(await scoped(6, 55), /user_input_active/, 'a click into the target through a child window was missed');
    // While a foreground action drives the pointer, any pointer input stops it.
    assert.equal((await send('begin:55:1')).Action, 'begun');
    await send('key:77');
    assert.equal((await send('assert')).Action, 'continued', 'typing elsewhere stopped a pointer action');
    await send('mouse:512:77:0');
    assert.match(
      (await send('assert')).Action,
      /^user_input_active:/,
      'pointer input during a pointer action was missed'
    );
    await send('end');
    // An action that does not drive the pointer is stopped only by input into its target.
    assert.equal((await send('begin:55:0')).Action, 'begun');
    await send('mouse:512:77:0');
    assert.equal((await send('assert')).Action, 'continued', 'pointer input elsewhere stopped a keyboard action');
    await send('key:55');
    assert.match(
      (await send('assert')).Action,
      /^user_input_active:/,
      'typing into the target during the action was missed'
    );
    await send('end');
    // A target holding mouse capture receives moves and releases over other processes.
    await send('capture:55');
    for (const message of [512, 514]) {
      const delivered = await send(`mouse:${message}:77:0`);
      assert.match(
        await scoped(delivered.Sequence - 1, 55),
        /user_input_active/,
        `captured mouse ${message} was missed`
      );
    }
    await send('capture:0');
    assert.equal(
      await scoped((await send('mouse:512:77:0')).Sequence - 1, 55),
      'accepted',
      'an uncaptured move elsewhere reached the target'
    );
    // Unreadable capture: a held button reaches the foreground; with nothing readable the event reaches every target.
    await send('capture-unreadable:1');
    await send('foreground:55');
    await send('held:1');
    assert.match(
      await scoped((await send('mouse:512:77:0')).Sequence - 1, 55),
      /user_input_active/,
      'a held drag into the foreground was missed'
    );
    await send('held:0');
    await send('foreground:77');
    assert.match(
      await scoped((await send('mouse:512:77:0')).Sequence - 1, 55),
      /user_input_active/,
      'unattributable mouse input passed'
    );
    await send('capture-unreadable:0');

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

test('a timed-out read leaves no receipt that a later read of another target accepts', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-stale-receipt-'));
  try {
    await writeObserverFixture(directory);
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        setup +
          `
$null = [MixInputObservation]::Read()
# The user types into process 77 only; process 55 received nothing.
[ObserverFixture]::Key(77)
$reads = @([ObserverFixture]::StaleReceipt(55, 77)) + @([MixInputObservation]::ReadFor([IntPtr]77))
$rows = @($reads | ForEach-Object { [ordered]@{ Ready = $_.Ready; Reason = $_.Reason; Sequence = $_.Sequence; Relevant = $_.RelevantSequence } })
[Console]::WriteLine((ConvertTo-Json -InputObject $rows -Compress))
`,
      ],
      { windowsHide: true, env: { ...process.env, OBSERVER_FIXTURE: directory } }
    );
    const [timedOut, later, fresh] = JSON.parse(stdout.trim());
    assert.equal(timedOut.Ready, false, 'a read the observer never answered was not refused');
    assert.equal(timedOut.Reason, 'monitor_unresponsive');
    // The receipt answering the timed-out read of process 55 says nothing
    // reached it; taken as this read's answer, it would hide the typing into 77.
    assert.equal(later.Ready, false, `a receipt for another read answered this one: ${JSON.stringify(later)}`);
    assert.equal(later.Reason, 'monitor_unresponsive');
    assert.deepEqual(fresh, { Ready: true, Reason: '', Sequence: 1, Relevant: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a replacement reader reusing a departed reader process id never repeats its request ids', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-request-ids-'));
  try {
    await writeObserverFixture(directory);
    // A file assembly, so fresh AppDomains in the same process can load it.
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
$ErrorActionPreference='Stop'
$dll = Join-Path $env:OBSERVER_FIXTURE 'observer.dll'
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $env:OBSERVER_FIXTURE 'observer.cs'))) -OutputAssembly $dll -OutputType Library
Add-Type -Path $dll
[Console]::WriteLine((ConvertTo-Json -InputObject ([ObserverFixture]::RequestIds(2, 3)) -Compress))
`,
      ],
      { windowsHide: true, env: { ...process.env, OBSERVER_FIXTURE: directory } }
    );
    const [departed, replacement] = JSON.parse(stdout.trim()).map((ids) => ids.map(BigInt));
    const all = [...departed, ...replacement];
    assert.equal(all.length, 6);
    for (const id of all) assert.ok(id > 0n, `request id ${id} is reserved or negative`);
    assert.equal(new Set(all).size, all.length, `a request id repeated: ${departed} then ${replacement}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
