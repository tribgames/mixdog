/**
 * The PowerShell side of Computer Use: the resident host program and the
 * one-shot abort cleanup program, kept out of the TypeScript host so neither
 * half buries the other. These are program text only — every decision about
 * when to run them lives in host/powershell-host.ts.
 */

import { PS_SESSION } from './ps-session';
import { PS_OBSERVATION } from './ps-observation';
import { PS_INPUT } from './ps-input';
import { PS_RUNTIME, PS_WINDOW_CAPTURE } from './ps-runtime';
import { PS_AUTHORIZATION } from './ps-authorization';
import { PS_SEQUENCE } from './ps-sequence';
import { MIXDOG_INPUT_TRANSPORT_CSHARP } from './native-source';
import { MAX_COMPUTER_FOREGROUND_TEXT_CHARS } from '../../../../../../src/runtime/computer-bridge/limits.mjs';

export { RESPONSE_MARKER } from '../shared/common';

const ABORT_CLEANUP_ADD_TYPE = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
${MIXDOG_INPUT_TRANSPORT_CSHARP}
public static class MixdogAbortCleanup {
  const int GWL_EXSTYLE = -20;
  const int WS_EX_NOACTIVATE = 0x08000000;
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern int SetWindowLong(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] static extern uint GetWindowProcessId(IntPtr hwnd, out uint processId);
  /// Replays each exited worker's inactive-window ledger and clears
  /// WS_EX_NOACTIVATE only on roots still recorded as added whose handle,
  /// process id and class name still match. A ledger is deleted once every
  /// recorded root is cleared or no longer ours; a failed clear keeps it.
  public static void RecoverLedgers(string paths) {
    if (String.IsNullOrEmpty(paths)) return;
    var failed = new List<string>();
    foreach (string path in paths.Split('|')) {
      if (path.Length == 0 || !File.Exists(path)) continue;
      var recorded = new Dictionary<long, string[]>();
      string text;
      // A concurrent recovery of the same ledger may delete it first.
      try { text = File.ReadAllText(path, Encoding.UTF8); } catch (FileNotFoundException) { continue; }
      foreach (string line in text.Split('\\n')) {
        string[] fields = line.Split('\\t');
        long handle;
        if (fields.Length != 4 || !Int64.TryParse(fields[1], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out handle)) continue;
        if (fields[0] == "+") recorded[handle] = fields;
        else if (fields[0] == "-") recorded.Remove(handle);
      }
      bool clean = true;
      foreach (KeyValuePair<long, string[]> entry in recorded) {
        IntPtr hwnd = new IntPtr(entry.Key);
        uint processId;
        if (GetWindowProcessId(hwnd, out processId) == 0
          || processId.ToString(CultureInfo.InvariantCulture) != entry.Value[2]) continue;
        var className = new StringBuilder(256);
        GetClassName(hwnd, className, className.Capacity);
        if (className.ToString().Replace('\\t', ' ').Replace('\\r', ' ').Replace('\\n', ' ') != entry.Value[3]) continue;
        int style = GetWindowLong(hwnd, GWL_EXSTYLE);
        if ((style & WS_EX_NOACTIVATE) == 0) continue;
        SetWindowLong(hwnd, GWL_EXSTYLE, style & ~WS_EX_NOACTIVATE);
        if ((GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_NOACTIVATE) != 0) clean = false;
      }
      if (clean) File.Delete(path);
      else failed.Add(path);
    }
    if (failed.Count > 0) throw new InvalidOperationException("inactive_ledger_unrecovered");
  }
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr processId);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static IntPtr ParseWindowId(string value) {
    if (String.IsNullOrWhiteSpace(value)) return IntPtr.Zero;
    string raw = value.Trim();
    if (raw.StartsWith("hwnd:", StringComparison.OrdinalIgnoreCase)) raw = raw.Substring(5);
    if (raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) raw = raw.Substring(2);
    long parsed;
    return Int64.TryParse(raw, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out parsed)
      ? new IntPtr(parsed) : IntPtr.Zero;
  }
  static void Focus(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return;
    // Restoring a maximized window would resize it; only un-minimize.
    if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
    if (SetForegroundWindow(hwnd) && GetForegroundWindow() == hwnd) return;
    uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint currentThread = GetCurrentThreadId();
    bool attached = foregroundThread != 0 && foregroundThread != currentThread
      && AttachThreadInput(foregroundThread, currentThread, true);
    try {
      if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
      SetForegroundWindow(hwnd);
    } finally {
      if (attached) AttachThreadInput(foregroundThread, currentThread, false);
    }
  }
  public static void Run(string targetValue, string restoreValue, int cursorX, int cursorY, string ledgerPaths) {
    // Independent of restoreDesktop and of whether the target was foreground.
    Exception ledgerFailure = null;
    try { RecoverLedgers(ledgerPaths); } catch (Exception error) { ledgerFailure = error; }
    RunInput(targetValue, restoreValue, cursorX, cursorY);
    if (ledgerFailure != null) throw ledgerFailure;
  }
  static void RunInput(string targetValue, string restoreValue, int cursorX, int cursorY) {
    uint marker;
    if (!UInt32.TryParse(Environment.GetEnvironmentVariable("MIXDOG_COMPUTER_INPUT_MARKER"), out marker)
      || marker == 0 || marker > Int32.MaxValue) throw new InvalidOperationException("input_marker_unavailable");
    var extra = new IntPtr((int)marker);
    MixNativeInput.ReleaseOwned(extra);
    IntPtr target = ParseWindowId(targetValue);
    IntPtr restore = ParseWindowId(restoreValue);
    if (target != IntPtr.Zero && GetForegroundWindow() == target) {
      int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
      if (width < 2 || height < 2) throw new InvalidOperationException("display_unavailable");
      int x = (int)Math.Round((cursorX - GetSystemMetrics(76)) * 65535.0 / (width - 1));
      int y = (int)Math.Round((cursorY - GetSystemMetrics(77)) * 65535.0 / (height - 1));
      MixNativeInput.INPUT input = MixNativeInput.Mouse(0xC001, extra);
      input.U.mi.dx = x; input.U.mi.dy = y;
      MixNativeInput.Deliver(new MixNativeInput.INPUT[] { input });
      if (restore != IntPtr.Zero && restore != target) Focus(restore);
    }
  }
}
"@
`;

export const ABORT_CLEANUP_PROGRAM = `${ABORT_CLEANUP_ADD_TYPE}
[MixdogAbortCleanup]::Run(
  $env:MIXDOG_ABORT_TARGET,
  $env:MIXDOG_ABORT_RESTORE,
  [int]$env:MIXDOG_ABORT_CURSOR_X,
  [int]$env:MIXDOG_ABORT_CURSOR_Y,
  $env:MIXDOG_ABORT_LEDGERS)
`;

/** Normal worker retirement: only the inactive-window ledgers, no input sweep. */
export const INACTIVE_LEDGER_RECOVERY_PROGRAM = `${ABORT_CLEANUP_ADD_TYPE}
[MixdogAbortCleanup]::RecoverLedgers($env:MIXDOG_ABORT_LEDGERS)
`;
/**
 * The resident PowerShell program. Reads one JSON request per line from stdin,
 * writes one marker-prefixed JSON response per line to stdout. Holds a ref →
 * AutomationElement map across requests so invoke/set_value can act on the
 * element a prior snapshot labelled.
 */
export function powershellHostProgram(): string {
  return [
    PS_SESSION,
    `$script:MaximumForegroundTextCharacters = ${MAX_COMPUTER_FOREGROUND_TEXT_CHARS}`,
    PS_AUTHORIZATION,
    PS_OBSERVATION,
    PS_INPUT,
    PS_SEQUENCE,
    PS_WINDOW_CAPTURE,
    PS_RUNTIME,
  ].join('\n');
}
