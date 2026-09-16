import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Hit-test and post mouse messages only to this fixture's window. Never move
 * the user's cursor, activate a window, or inject global desktop input. */
export async function nativeOverlayClick(windowId: bigint, point: { x: number; y: number }): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OverlayClickFixture {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static void Click(long handle, int x, int y, uint owner) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    IntPtr root = new IntPtr(handle);
    uint pid; GetWindowThreadProcessId(root, out pid);
    if (pid != owner) throw new Exception("fixture ownership mismatch");
    Point point = new Point { X = x, Y = y };
    IntPtr target = WindowFromPoint(point);
    if (target != root && !IsChild(root, target)) throw new Exception("fixture is not the native hit target");
    if (!ScreenToClient(target, ref point)) throw new Exception("fixture coordinate conversion failed");
    IntPtr foreground = GetForegroundWindow();
    IntPtr packed = new IntPtr((point.Y << 16) | (point.X & 65535));
    if (!PostMessage(target, 0x0200, IntPtr.Zero, packed)
        || !PostMessage(target, 0x0201, new IntPtr(1), packed)
        || !PostMessage(target, 0x0202, IntPtr.Zero, packed))
      throw new Exception("fixture mouse delivery failed");
    if (GetForegroundWindow() != foreground) throw new Exception("fixture changed foreground");
  }
}
'@
[OverlayClickFixture]::Click(${windowId}, ${point.x}, ${point.y}, ${process.pid})
`;
  await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 8_000,
  });
}
