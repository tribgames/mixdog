/**
 * The PowerShell side of Computer Use: the resident host program and the
 * one-shot abort cleanup program, kept out of the TypeScript host so neither
 * half buries the other. These are program text only — every decision about
 * when to run them lives in computer-host-powershell.ts.
 */

import { PS_SESSION } from './ps-session';
import { PS_OBSERVATION } from './ps-observation';
import { PS_INPUT } from './ps-input';
import { PS_RUNTIME } from './ps-runtime';
import { PS_AUTHORIZATION } from './ps-authorization';
import { PS_SEQUENCE } from './ps-sequence';

export { RESPONSE_MARKER } from '../shared/common';

export const ABORT_CLEANUP_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Globalization;
using System.Runtime.InteropServices;
public static class MixdogAbortCleanup {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, IntPtr extra);
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
  public static void Run(string targetValue, string restoreValue, int cursorX, int cursorY) {
    uint marker;
    if (!UInt32.TryParse(Environment.GetEnvironmentVariable("MIXDOG_COMPUTER_INPUT_MARKER"), out marker)
      || marker == 0 || marker > Int32.MaxValue) throw new InvalidOperationException("input_marker_unavailable");
    var extra = new IntPtr((int)marker);
    byte[] keys = new byte[] { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
    foreach (byte key in keys) keybd_event(key, 0, 0x2, new UIntPtr(marker));
    mouse_event(0x04 | 0x10 | 0x40, 0, 0, 0, extra);
    IntPtr target = ParseWindowId(targetValue);
    IntPtr restore = ParseWindowId(restoreValue);
    if (target != IntPtr.Zero && GetForegroundWindow() == target) {
      int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
      if (width < 2 || height < 2) throw new InvalidOperationException("display_unavailable");
      int x = (int)Math.Round((cursorX - GetSystemMetrics(76)) * 65535.0 / (width - 1));
      int y = (int)Math.Round((cursorY - GetSystemMetrics(77)) * 65535.0 / (height - 1));
      mouse_event(0xC001, x, y, 0, extra);
      if (restore != IntPtr.Zero && restore != target) Focus(restore);
    }
  }
}
"@
[MixdogAbortCleanup]::Run(
  $env:MIXDOG_ABORT_TARGET,
  $env:MIXDOG_ABORT_RESTORE,
  [int]$env:MIXDOG_ABORT_CURSOR_X,
  [int]$env:MIXDOG_ABORT_CURSOR_Y)
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
    PS_AUTHORIZATION,
    PS_OBSERVATION,
    PS_INPUT,
    PS_SEQUENCE,
    PS_RUNTIME,
  ].join('\n');
}
