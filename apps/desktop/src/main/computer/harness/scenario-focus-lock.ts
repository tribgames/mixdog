/**
 * The live check that background semantic input keeps the user's window in
 * front, or puts it back within a bound: a sentinel window this process owns stands in for the user's window,
 * a separate Electron app that activates itself on every semantic input is the
 * target, and a helper process samples the foreground window and the keyboard
 * focus while typing into the sentinel through the system input queue.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { sleep } from '../shared/common';
import { FOCUS_LOCK_TARGET_TITLE, focusLockTargetProgram } from './scenario-fixture-html';
import { foregroundHwnd, nativeHwnd } from './scenario-fixtures';
import { controlTookForeground, type FocusWatch, type FrontSample } from './scenario-focus-input';
import { eventually, profile, progress } from './scenario-runtime';
import type { ScenarioCommand } from './scenario-types';
import { userControlDetail } from './scenario-user-control';

export const FOCUS_LOCK_SENTINEL_TITLE = 'Mixdog Focus Lock Sentinel';
/** The character the watch types into the sentinel. */
export const FOCUS_LOCK_KEY = 'x';
/** How long the watch goes on after the reply: well past the foreground lock's
 *  longest hold, so an activation the lock let through late is still seen. */
export const FOCUS_LOCK_SETTLE_MS = 600;
/** The longest a target may hold the foreground or focus before the user's
 *  window is back. A Chromium target's UIA provider raises it during the call,
 *  which no lock refuses; live runs measured about 200 ms to the restore. */
export const FOCUS_LOCK_EXCURSION_MS = 400;
/** How long the keyboard and mouse must have been still before the sentinel
 *  takes the foreground, and how long S48 waits for that. */
export const FOCUS_LOCK_QUIET_MS = 1_000;
export const FOCUS_LOCK_QUIET_TIMEOUT_MS = 30_000;

/** The background semantic actions under test, the route each must take, and
 *  what the target shows once it took effect. */
export const FOCUS_LOCK_STEPS: ReadonlyArray<{
  action: string;
  name: string;
  path: string;
  input: Record<string, unknown>;
  applied: (state: FocusLockTargetState) => boolean;
}> = [
  { action: 'invoke', name: 'Focus Lock Invoke', path: 'uia_invoke', input: {}, applied: () => true },
  {
    action: 'set_value',
    name: 'Focus Lock Field',
    path: 'uia_value',
    input: { text: 'LOCK48' },
    applied: (state) => state.value === 'LOCK48',
  },
  {
    action: 'toggle',
    name: 'Focus Lock Toggle',
    path: 'uia_toggle',
    input: {},
    applied: (state) => state.checked,
  },
];

export interface FocusLockTargetState {
  phase?: string;
  error?: string;
  activations: Array<{ kind: string; at: number; focused: boolean }>;
  /** Self-activations asked for with no agent action running. */
  controls: Array<{ at: number; focused: boolean }>;
  focus_events: number[];
  keys: string[];
  value: string;
  checked: boolean;
}

export function spawnFocusLockTarget(): { child: ChildProcess; statePath: string } {
  const statePath = join(profile, 'focus-lock-target-state.json');
  const programPath = join(profile, 'focus-lock-target.mjs');
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.control`, { force: true });
  writeFileSync(programPath, focusLockTargetProgram(statePath, join(profile, 'focus-lock-target-user-data')), 'utf8');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [programPath], { env, stdio: 'ignore', windowsHide: false });
  return { child, statePath };
}

export function readFocusLockTarget(statePath: string): FocusLockTargetState {
  return JSON.parse(readFileSync(statePath, 'utf8')) as FocusLockTargetState;
}

export async function waitForFocusLockTarget(statePath: string): Promise<void> {
  const phase = await eventually(
    async () => {
      try {
        return readFocusLockTarget(statePath).phase || '';
      } catch {
        return '';
      }
    },
    (value) => value === 'window' || value === 'error',
    30_000
  );
  if (phase === 'error') throw new Error(`focus lock target failed: ${readFocusLockTarget(statePath).error}`);
}

/** Has the target activate itself once with no agent action running, and
 *  returns whether the OS watch saw it take the foreground, with what it saw.
 *  Nothing brings the sentinel back meanwhile, so a target that got the
 *  foreground still holds it while this waits. */
export async function targetControlActivation(
  statePath: string,
  watch: { fronts: () => readonly FrontSample[]; front: () => { foreground: number; focus: number } },
  target: number
): Promise<{ took: boolean; detail: string }> {
  const before = readFocusLockTarget(statePath).controls.length;
  const from = watch.fronts().length;
  writeFileSync(`${statePath}.control`, String(Date.now()));
  const controls = await eventually(
    async () => readFocusLockTarget(statePath).controls,
    (entries) => entries.length > before,
    5_000
  );
  const samples = await eventually(
    async () => watch.fronts().slice(from),
    (seen) => controlTookForeground(seen, target),
    2_000
  ).catch(() => watch.fronts().slice(from));
  const took = controlTookForeground(samples, target);
  return {
    took,
    detail:
      `the fixture reported focused ${String(controls.at(-1)?.focused)}; OS samples since the request ` +
      `${JSON.stringify(samples)}; last sample ${JSON.stringify(watch.front())}`,
  };
}

export function focusLockTargetLine(listing: string): string {
  return listing.split(/\r?\n/).find((line) => line.includes(`"${FOCUS_LOCK_TARGET_TITLE}"`)) || '';
}

/** The window standing in for the user's, shown without taking the
 *  foreground: the scenario takes it later through `focus_window`, for as
 *  short a time as it can. */
export async function openFocusLockSentinel(windows: BrowserWindow[]): Promise<BrowserWindow> {
  const sentinel = new BrowserWindow({ width: 520, height: 240, show: false, title: FOCUS_LOCK_SENTINEL_TITLE });
  windows.push(sentinel);
  const html = `<!doctype html><meta charset="utf-8"><title>${FOCUS_LOCK_SENTINEL_TITLE}</title><input id="sink" style="width:90%;font:20px Arial">`;
  await sentinel.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  sentinel.showInactive();
  await focusSentinelField(sentinel);
  return sentinel;
}

/** Moves the page's focus to the text field; it never activates the window. */
export async function focusSentinelField(sentinel: BrowserWindow): Promise<void> {
  await sentinel.webContents.executeJavaScript(`document.querySelector('#sink').focus()`);
}

export function sentinelWindowId(sentinel: BrowserWindow): string {
  return `hwnd:0x${nativeHwnd(sentinel).toString(16)}`;
}

/** Gives the foreground back to the window that had it before the sentinel
 *  took it, through the same `focus_window`. A user who already moved on is
 *  left where they are. */
export async function handBackForeground(
  command: ScenarioCommand,
  session: string,
  previous: bigint,
  sentinelHwnd: number
): Promise<void> {
  try {
    if (Number(await foregroundHwnd()) !== sentinelHwnd) {
      progress('S48 released the foreground; the sentinel was not in front');
      return;
    }
    if (previous === 0n || Number(previous) === sentinelHwnd) {
      progress('S48 released the foreground; no earlier window to hand it back to');
      return;
    }
    // It puts back what S48 itself took, so it goes out even after user input.
    const reply = JSON.parse(
      (
        await command({ action: 'focus_window', window_id: `hwnd:0x${previous.toString(16)}` }, session, {
          restoresUserDesktop: true,
        })
      ).text
    ) as Record<string, unknown>;
    progress(
      reply.verified === true
        ? 'S48 released the foreground and handed it back to the window that had it'
        : `S48 released the foreground but could not hand it back: ${reply.code ? userControlDetail(reply) : String(reply.message)}`
    );
  } catch (error) {
    progress(`S48 released the foreground but could not hand it back: ${(error as Error).message || String(error)}`);
  }
}

/** Brings the sentinel forward through `focus_window`, as the reliability
 *  harness holds the foreground for its user window; it fails the scenario
 *  rather than measuring a desktop where the sentinel is not in front. */
export async function bringSentinelForward(
  command: ScenarioCommand,
  session: string,
  sentinel: BrowserWindow
): Promise<void> {
  const reply = JSON.parse(
    (await command({ action: 'focus_window', window_id: sentinelWindowId(sentinel) }, session)).text
  ) as Record<string, unknown>;
  if (reply.verified !== true) {
    throw new Error(
      `the sentinel could not take the foreground through focus_window, so nothing here can show the target taking it: ${JSON.stringify(reply)}`
    );
  }
}

export async function sentinelText(sentinel: BrowserWindow): Promise<string> {
  return String(await sentinel.webContents.executeJavaScript(`document.querySelector('#sink').value`));
}

// Sampling in a loop of its own, at about a millisecond, so a steal that a
// restore undoes again is still seen. Keys go in only while the sentinel holds
// both the foreground and the focus, so a failure never types into a window
// this run does not own.
const FOCUS_WATCH_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class MixdogFocusWatch {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo {
    public int Size; public int Flags; public IntPtr Active; public IntPtr Focus; public IntPtr Capture;
    public IntPtr MenuOwner; public IntPtr MoveSize; public IntPtr Caret; public Rect CaretRect;
  }
  [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public ushort Vk; public ushort Scan; public uint Flags; public uint Time; public IntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X; public int Y; public uint Data; public uint Flags; public uint Time; public IntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] struct InputData { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputData Data; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
  [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);

  // The recorder: low-level hooks on a thread of their own, so the evidence of
  // what reached the desktop does not depend on Mixdog's own observer.
  delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] struct HookPoint { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MouseHook { public HookPoint Point; public uint Data; public uint Flags; public uint Time; public IntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct KeyHook { public uint Vk; public uint Scan; public uint Flags; public uint Time; public IntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr Hwnd; public uint Message; public UIntPtr WParam; public IntPtr LParam; public uint Time; public HookPoint Point; public uint Private; }
  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size; public uint Time; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int kind, HookProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] static extern int GetMessage(out Msg message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PeekMessage(out Msg message, IntPtr window, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, UIntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  static readonly HookProc keyProc = OnKey;
  static readonly HookProc mouseProc = OnMouse;
  static readonly object gate = new object();
  static readonly List<string> inputs = new List<string>();
  static readonly List<long> clockMoves = new List<long>();
  static readonly HashSet<uint> foregroundPids = new HashSet<uint>();
  static int physicalKeys, physicalPointer, injectedInputs, selfTyped;
  static long lastHookAt, lastReportedAt, lastPointerLoggedAt;
  static ushort ownKey;
  static uint recorderThread;
  static string hookError;

  static uint ForegroundPid() {
    uint process;
    GetWindowThreadProcessId(GetForegroundWindow(), out process);
    return process;
  }
  // Each input moves the quiet clock the scenario waits on; reported at most
  // every 100 ms so a moving mouse does not flood the pipe.
  static void Seen(long at, string entry) { Seen(at, entry, true); }
  static void Seen(long at, string entry, bool hooked) {
    lock (gate) {
      if (hooked) {
        lastHookAt = at;
        // A clock move this event lands just after is explained by it.
        clockMoves.RemoveAll(move => move <= at && at - move <= 100);
      }
      if (entry != null && inputs.Count < 600) inputs.Add(entry);
      if (at - lastReportedAt < 100) return;
      lastReportedAt = at;
    }
    Console.Out.WriteLine("input " + at);
    Console.Out.Flush();
  }
  static IntPtr OnKey(int code, IntPtr message, IntPtr data) {
    if (code >= 0) {
      KeyHook value = (KeyHook)Marshal.PtrToStructure(data, typeof(KeyHook));
      long at = Now();
      bool injected = (value.Flags & 0x10) != 0;
      if (!injected) {
        lock (gate) physicalKeys++;
        Seen(at, "{\"at\":" + at + ",\"kind\":\"key\",\"injected\":false}");
      } else if (value.Vk == 0xE7 && value.Scan == ownKey && value.Extra == IntPtr.Zero) {
        // The watch's own typing (VK_PACKET of its key) is the test, not
        // evidence: it explains its clock move without counting as input.
        lock (gate) {
          selfTyped++;
          lastHookAt = at;
          clockMoves.RemoveAll(move => move <= at && at - move <= 100);
        }
      } else {
        uint pid = ForegroundPid();
        lock (gate) { injectedInputs++; foregroundPids.Add(pid); }
        Seen(at, "{\"at\":" + at + ",\"kind\":\"key\",\"injected\":true,\"vk\":" + value.Vk + ",\"flags\":" + value.Flags +
          ",\"extra\":" + value.Extra.ToInt64() + ",\"foreground\":\"pid:" + pid + "\"}");
      }
    }
    return CallNextHookEx(IntPtr.Zero, code, message, data);
  }
  static IntPtr OnMouse(int code, IntPtr message, IntPtr data) {
    if (code >= 0) {
      MouseHook value = (MouseHook)Marshal.PtrToStructure(data, typeof(MouseHook));
      long at = Now();
      if ((value.Flags & 1) == 0) {
        bool log;
        lock (gate) {
          physicalPointer++;
          log = message.ToInt64() != 0x200 || at - lastPointerLoggedAt >= 100;
          if (log) lastPointerLoggedAt = at;
        }
        Seen(at, log ? "{\"at\":" + at + ",\"kind\":\"pointer\",\"injected\":false}" : null);
      } else {
        uint pid = ForegroundPid();
        lock (gate) { injectedInputs++; foregroundPids.Add(pid); }
        Seen(at, "{\"at\":" + at + ",\"kind\":\"pointer\",\"injected\":true,\"message\":" + message.ToInt64() + ",\"flags\":" + value.Flags +
          ",\"extra\":" + value.Extra.ToInt64() + ",\"foreground\":\"pid:" + pid + "\"}");
      }
    }
    return CallNextHookEx(IntPtr.Zero, code, message, data);
  }
  static void Record(object ready) {
    recorderThread = GetCurrentThreadId();
    Msg message;
    PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
    IntPtr module = GetModuleHandle(null);
    IntPtr keyboard = SetWindowsHookEx(13, keyProc, module, 0);
    IntPtr mouse = SetWindowsHookEx(14, mouseProc, module, 0);
    if (keyboard == IntPtr.Zero || mouse == IntPtr.Zero) hookError = "input hooks unavailable: " + Marshal.GetLastWin32Error();
    ((ManualResetEvent)ready).Set();
    try {
      if (hookError == null) while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
    } finally {
      if (keyboard != IntPtr.Zero) UnhookWindowsHookEx(keyboard);
      if (mouse != IntPtr.Zero) UnhookWindowsHookEx(mouse);
    }
  }
  static uint InputTick() {
    LastInput info = new LastInput();
    info.Size = (uint)Marshal.SizeOf(typeof(LastInput));
    GetLastInputInfo(ref info);
    return info.Time;
  }
  static string ProcessName(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName + "/" + pid; } catch { return "pid:" + pid; }
  }

  // The top-level window that holds the keyboard focus of the foreground thread.
  static IntPtr FocusRoot(IntPtr foreground) {
    if (foreground == IntPtr.Zero) return IntPtr.Zero;
    uint process;
    uint thread = GetWindowThreadProcessId(foreground, out process);
    GuiThreadInfo info = new GuiThreadInfo();
    info.Size = Marshal.SizeOf(typeof(GuiThreadInfo));
    if (!GetGUIThreadInfo(thread, ref info) || info.Focus == IntPtr.Zero) return IntPtr.Zero;
    return GetAncestor(info.Focus, 2);
  }

  static void Type(char value) {
    Input[] inputs = new Input[2];
    inputs[0].Type = 1; inputs[0].Data.Keyboard.Scan = value; inputs[0].Data.Keyboard.Flags = 4;
    inputs[1].Type = 1; inputs[1].Data.Keyboard.Scan = value; inputs[1].Data.Keyboard.Flags = 6;
    SendInput(2, inputs, Marshal.SizeOf(typeof(Input)));
  }

  static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }

  public static string Run(long sentinel, string startPath, string stopPath, int keyIntervalMs, int timeoutMs, string key) {
    IntPtr own = new IntPtr(sentinel);
    Stopwatch clock = Stopwatch.StartNew();
    List<string> changes = new List<string>();
    List<long> typed = new List<long>();
    long samples = 0, away = 0, armedAt = 0;
    int withheld = 0;
    IntPtr lastForeground = new IntPtr(-1), lastFocus = new IntPtr(-1);
    long nextKey = 0;
    bool started = false;
    ownKey = key[0];
    ManualResetEvent recorderReady = new ManualResetEvent(false);
    Thread recorder = new Thread(Record);
    recorder.IsBackground = true;
    recorder.Start(recorderReady);
    recorderReady.WaitOne();
    if (hookError != null) throw new InvalidOperationException(hookError);
    // Input from before the hooks existed counts too: the quiet clock starts
    // at the system's last input.
    uint tick = InputTick();
    long lastInputAt = Now() - (long)unchecked((uint)Environment.TickCount - tick);
    lock (gate) lastHookAt = lastInputAt;
    Console.Out.WriteLine("ready");
    Console.Out.WriteLine("input " + lastInputAt);
    Console.Out.Flush();
    timeBeginPeriod(1);
    try {
      while (!File.Exists(stopPath) && clock.ElapsedMilliseconds < timeoutMs) {
        uint nowTick = InputTick();
        if (nowTick != tick) {
          tick = nowTick;
          long at = Now();
          bool hooked;
          lock (gate) hooked = at - lastHookAt <= 100;
          if (!hooked) {
            lock (gate) if (clockMoves.Count < 200) clockMoves.Add(at);
            Seen(at, null, false);
          }
        }
        IntPtr foreground = GetForegroundWindow();
        IntPtr focus = FocusRoot(foreground);
        samples++;
        bool onSentinel = foreground == own && focus == own;
        // The watch is compiled and running before the sentinel is brought
        // forward. It counts, and types, only once told to start, and from the
        // moment the sentinel then holds both: a key typed while focus_window
        // settles would count as the user's input against it.
        if (!started && File.Exists(startPath)) {
          started = true;
          nextKey = clock.ElapsedMilliseconds;
        }
        if (started && armedAt == 0 && onSentinel) armedAt = Now();
        if (armedAt != 0 && !onSentinel) away++;
        if (foreground != lastForeground || focus != lastFocus) {
          if (changes.Count < 200) {
            changes.Add("{\"at\":" + Now() + ",\"foreground\":" + foreground.ToInt64() + ",\"focus\":" + focus.ToInt64() + "}");
          }
          lastForeground = foreground;
          lastFocus = focus;
          Console.Out.WriteLine("front " + foreground.ToInt64() + " " + focus.ToInt64());
          Console.Out.Flush();
        }
        if (started && keyIntervalMs > 0 && clock.ElapsedMilliseconds >= nextKey) {
          nextKey = clock.ElapsedMilliseconds + keyIntervalMs;
          if (onSentinel && GetForegroundWindow() == own) { Type(key[0]); typed.Add(Now()); }
          else if (armedAt != 0) withheld++;
        }
        Thread.Sleep(1);
      }
    }
    finally {
      timeEndPeriod(1);
      PostThreadMessage(recorderThread, 0x12, UIntPtr.Zero, IntPtr.Zero);
      recorder.Join(2000);
    }
    string recorded;
    lock (gate) {
      recorded = string.Join(",", inputs);
      foreach (uint pid in foregroundPids) recorded = recorded.Replace("\"pid:" + pid + "\"", "\"" + ProcessName(pid) + "\"");
    }
    return "{\"samples\":" + samples + ",\"armed_at\":" + armedAt + ",\"away\":" + away + ",\"withheld\":" + withheld +
      ",\"timed_out\":" + (clock.ElapsedMilliseconds >= timeoutMs ? "true" : "false") +
      ",\"typed\":[" + string.Join(",", typed) + "],\"changes\":[" + string.Join(",", changes) + "]" +
      ",\"inputs\":[" + recorded + "],\"clock\":[" + string.Join(",", clockMoves) + "]" +
      ",\"counts\":{\"physical_keys\":" + physicalKeys + ",\"physical_pointer\":" + physicalPointer +
      ",\"injected\":" + injectedInputs + ",\"self_typed\":" + selfTyped + "}}";
  }
}
`;

const FOCUS_WATCH_SCRIPT = `param([long]$Sentinel, [string]$StartPath, [string]$StopPath, [int]$KeyIntervalMs, [int]$TimeoutMs, [string]$Key)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${FOCUS_WATCH_SOURCE}
'@
[Console]::Out.WriteLine([MixdogFocusWatch]::Run($Sentinel, $StartPath, $StopPath, $KeyIntervalMs, $TimeoutMs, $Key))
`;

let watchCount = 0;

/** Starts the helper; resolves once it is sampling and its input hooks are in.
 *  `front` is the foreground window and focus root it sampled last, `fronts`
 *  every change of them it sampled, `quiet`
 *  waits until no keyboard or mouse input arrived for `quietMs`, `start`
 *  begins counting and typing, `stop` ends it and returns what it saw (safe to
 *  call twice). */
export async function watchSentinel(
  sentinel: BrowserWindow,
  keyIntervalMs = 20
): Promise<{
  front: () => { foreground: number; focus: number };
  fronts: () => readonly FrontSample[];
  quiet: (quietMs: number, timeoutMs: number) => Promise<void>;
  start: () => number;
  stop: () => Promise<FocusWatch>;
}> {
  watchCount += 1;
  const scriptPath = join(profile, 'focus-watch.ps1');
  const startPath = join(profile, `focus-watch-${watchCount}.start`);
  const stopPath = join(profile, `focus-watch-${watchCount}.stop`);
  writeFileSync(scriptPath, FOCUS_WATCH_SCRIPT, 'utf8');
  rmSync(startPath, { force: true });
  rmSync(stopPath, { force: true });
  const child = spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Sentinel',
      String(nativeHwnd(sentinel)),
      '-StartPath',
      startPath,
      '-StopPath',
      stopPath,
      '-KeyIntervalMs',
      String(keyIntervalMs),
      '-TimeoutMs',
      '60000',
      '-Key',
      FOCUS_LOCK_KEY,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  // The last keyboard or mouse input the helper saw, epoch ms, and the
  // foreground window and focus root it sampled last.
  let lastInputAt = Number.POSITIVE_INFINITY;
  let front = { foreground: 0, focus: 0 };
  // Every sampled change, with when this process read it.
  const fronts: FrontSample[] = [];
  let parsed = 0;
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const complete = stdout.lastIndexOf('\n') + 1;
      for (const line of stdout.slice(parsed, complete).split(/\r?\n/)) {
        const input = /^input (\d+)$/.exec(line);
        if (input)
          lastInputAt = Number.isFinite(lastInputAt) ? Math.max(lastInputAt, Number(input[1])) : Number(input[1]);
        const sampled = /^front (-?\d+) (-?\d+)$/.exec(line);
        if (sampled) {
          front = { foreground: Number(sampled[1]), focus: Number(sampled[2]) };
          fronts.push({ at: Date.now(), ...front });
        }
      }
      parsed = Math.max(parsed, complete);
      if (stdout.includes('ready')) resolve();
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    void exited.then((code) => reject(new Error(`focus watch exited before sampling (${code}): ${stderr.trim()}`)));
  });
  let result: Promise<FocusWatch> | null = null;
  return {
    front: () => front,
    fronts: () => fronts,
    quiet: async (quietMs: number, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idle = Date.now() - lastInputAt;
        if (idle >= quietMs) return;
        if (Date.now() >= deadline) return Promise.reject(new Error(`input was ${Math.max(0, idle)} ms ago`));
        await sleep(Math.min(100, Math.max(10, quietMs - Math.max(0, idle))));
      }
    },
    start: () => {
      writeFileSync(startPath, '');
      return Date.now();
    },
    stop: () => {
      result ||= (async () => {
        writeFileSync(stopPath, '');
        const code = await Promise.race([exited, sleep(10_000).then(() => 'timeout' as const)]);
        if (code === 'timeout') {
          child.kill();
          throw new Error('focus watch did not stop');
        }
        rmSync(startPath, { force: true });
        rmSync(stopPath, { force: true });
        const line = stdout.trim().split(/\r?\n/).at(-1) || '';
        if (code !== 0 || !line.startsWith('{')) throw new Error(`focus watch failed (${code}): ${stderr.trim()}`);
        return JSON.parse(line) as FocusWatch;
      })();
      return result;
    },
  };
}
