/**
 * The PowerShell side of Computer Use: the resident host program and the
 * one-shot abort cleanup program, kept out of the TypeScript host so neither
 * half buries the other. These are program text only — every decision about
 * when to run them lives in computer-host-powershell.ts.
 */

import { PS_SESSION } from './computer-host-ps-session';
import { PS_OBSERVATION } from './computer-host-ps-observation';
import { PS_INPUT } from './computer-host-ps-input';
import { PS_RUNTIME } from './computer-host-ps-runtime';

export { RESPONSE_MARKER } from './computer-host-shared';

export const ABORT_CLEANUP_PROGRAM = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Globalization;
using System.Runtime.InteropServices;
public static class MixdogAbortCleanup {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, IntPtr extra);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
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
    ShowWindow(hwnd, 9);
    if (SetForegroundWindow(hwnd) && GetForegroundWindow() == hwnd) return;
    uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint currentThread = GetCurrentThreadId();
    bool attached = foregroundThread != 0 && foregroundThread != currentThread
      && AttachThreadInput(foregroundThread, currentThread, true);
    try {
      ShowWindow(hwnd, 9);
      SetForegroundWindow(hwnd);
    } finally {
      if (attached) AttachThreadInput(foregroundThread, currentThread, false);
    }
  }
  public static void Run(string targetValue, string restoreValue, int cursorX, int cursorY) {
    byte[] keys = new byte[] { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
    foreach (byte key in keys) keybd_event(key, 0, 0x2, UIntPtr.Zero);
    mouse_event(0x04 | 0x10 | 0x40, 0, 0, 0, IntPtr.Zero);
    IntPtr target = ParseWindowId(targetValue);
    IntPtr restore = ParseWindowId(restoreValue);
    if (target != IntPtr.Zero && GetForegroundWindow() == target) {
      SetCursorPos(cursorX, cursorY);
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
    PS_OBSERVATION,
    PS_INPUT,
    PS_RUNTIME,
  ].join('\n');
}
