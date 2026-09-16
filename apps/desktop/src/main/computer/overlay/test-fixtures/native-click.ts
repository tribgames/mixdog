import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** `desktop-hit-test`: the fixture window owned the desktop hit test at the click point.
 * `locked-session`: the Windows lock screen owned it, so only message delivery was exercised. */
export type NativeOverlayClickMode = 'desktop-hit-test' | 'locked-session';

/** Hit-test and post mouse messages only to this fixture's window. Never move
 * the user's cursor, activate a window, or inject global desktop input. */
export async function nativeOverlayClick(
  windowId: bigint,
  point: { x: number; y: number }
): Promise<NativeOverlayClickMode> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class OverlayClickFixture {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  /** Raise only this fixture's own window, never activating it or touching another process. */
  static void KeepOnTop(IntPtr window) { SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x13); }
  static string Describe(IntPtr window) {
    if (window == IntPtr.Zero) return "hwnd=0";
    StringBuilder className = new StringBuilder(160); GetClassName(window, className, className.Capacity);
    StringBuilder title = new StringBuilder(160); GetWindowText(window, title, title.Capacity);
    uint pid; GetWindowThreadProcessId(window, out pid);
    Rect rect; GetWindowRect(window, out rect);
    return String.Format("hwnd=0x{0:X} pid={1} class='{2}' title='{3}' rect={4},{5},{6},{7}",
      window.ToInt64(), pid, className, title, rect.Left, rect.Top, rect.Right, rect.Bottom);
  }
  static string ClassOf(IntPtr window) {
    StringBuilder className = new StringBuilder(160); GetClassName(window, className, className.Capacity);
    return className.ToString();
  }
  public static string Click(long handle, int x, int y, uint owner, int waitMs) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    IntPtr root = new IntPtr(handle);
    uint pid; GetWindowThreadProcessId(root, out pid);
    if (pid != owner) throw new Exception("fixture ownership mismatch");
    Point point = new Point { X = x, Y = y };
    string mode = "desktop-hit-test";
    // A transparent window owns the hit test only once its frame is composited, and another
    // topmost window can sit above it. Re-raise this fixture's own window (never activating it)
    // and wait for the hit test to name it instead of clicking into whatever is underneath.
    IntPtr target = IntPtr.Zero;
    for (int waited = 0; ; waited += 50) {
      KeepOnTop(root);
      target = WindowFromPoint(point);
      if (target == root || IsChild(root, target)) break;
      if (waited >= waitMs) {
        // A locked session puts the lock screen backstop above every application window, in a
        // z-order band no application can enter, so no desktop hit test can name this fixture.
        // Keep delivering real mouse messages to the fixture window and report the weaker mode.
        if (ClassOf(target) != "LockScreenBackstopFrame")
          throw new Exception("fixture is not the native hit target: point " + x + "," + y
            + " hit [" + Describe(target) + "], fixture [" + Describe(root) + "]");
        Rect bounds; GetWindowRect(root, out bounds);
        if (x < bounds.Left || x >= bounds.Right || y < bounds.Top || y >= bounds.Bottom)
          throw new Exception("fixture click point is outside the fixture window: point " + x + "," + y
            + ", fixture [" + Describe(root) + "]");
        mode = "locked-session";
        target = root;
        break;
      }
      Thread.Sleep(50);
    }
    if (!ScreenToClient(target, ref point)) throw new Exception("fixture coordinate conversion failed");
    IntPtr foreground = GetForegroundWindow();
    IntPtr packed = new IntPtr((point.Y << 16) | (point.X & 65535));
    if (!PostMessage(target, 0x0200, IntPtr.Zero, packed)
        || !PostMessage(target, 0x0201, new IntPtr(1), packed)
        || !PostMessage(target, 0x0202, IntPtr.Zero, packed))
      throw new Exception("fixture mouse delivery failed");
    if (GetForegroundWindow() != foreground) throw new Exception("fixture changed foreground");
    return mode;
  }
}
'@
Write-Output ('OVERLAY_CLICK_MODE ' + [OverlayClickFixture]::Click(${windowId}, ${point.x}, ${point.y}, ${process.pid}, 3000))
`;
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20_000 }
  );
  return stdout.includes('OVERLAY_CLICK_MODE locked-session') ? 'locked-session' : 'desktop-hit-test';
}
