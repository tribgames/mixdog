public partial class MixWin32
{
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr h, POINT p, uint flags);
    [DllImport("user32.dll", SetLastError = true, EntryPoint = "SendMessageTimeoutW")]
    static extern IntPtr SendMessageTimeout(
      IntPtr h, uint message, UIntPtr wParam, IntPtr lParam,
      uint flags, uint timeout, out UIntPtr result);
    [DllImport("kernel32.dll", EntryPoint = "SetLastError")]
    static extern void ClearMessageError(uint error);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public uint cbSize;
        public uint flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }
    const uint SMTO_BLOCK = 0x1, SMTO_ABORTIFHUNG = 0x2;
    const uint WM_GETTEXT = 0x000D, WM_GETTEXTLENGTH = 0x000E, BM_GETCHECK = 0x00F0;
    const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102;
    const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
    const uint WM_LBUTTONDBLCLK = 0x0203, WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
    const uint WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208, WM_MOUSEWHEEL = 0x020A, WM_MOUSEHWHEEL = 0x020E;
    const uint MK_LBUTTON = 0x1, MK_RBUTTON = 0x2, MK_SHIFT = 0x4, MK_CONTROL = 0x8, MK_MBUTTON = 0x10;
    static UIntPtr SendMessageValue(IntPtr h, uint message, UIntPtr wParam, IntPtr lParam)
    {
        UIntPtr result;
        // This API can fail without setting an error. Never reuse a prior call's
        // access-denied result as proof that this message was not delivered.
        ClearMessageError(0);
        IntPtr sent = SendMessageTimeout(
          h, message, wParam, lParam, SMTO_BLOCK | SMTO_ABORTIFHUNG, 1000, out result);
        if (sent == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error == 0 || error == 1460)
            {
                throw new InvalidOperationException("background_target_hung|native window message timed out");
            }
            if (error == 5)
            {
                throw new BackgroundMessageException("background_blocked_uipi|Windows integrity isolation blocked the native message", true);
            }
            throw new InvalidOperationException(
              "background_message_rejected|native window message failed with Win32 error " + error);
        }
        return result;
    }
    static void SendMessageChecked(IntPtr h, uint message, UIntPtr wParam, IntPtr lParam)
    {
        SendMessageValue(h, message, wParam, lParam);
    }
    public sealed class BackgroundMessageException : InvalidOperationException
    {
        public readonly bool DefinitelyNotDelivered;
        public BackgroundMessageException(string message, bool definitelyNotDelivered) : base(message)
        {
            DefinitelyNotDelivered = definitelyNotDelivered;
        }
    }
    public static void WithBackgroundRelease(Action press, Action held, Action release)
    {
        bool releaseRequired = true;
        Exception operationFailure = null;
        try
        {
            try { press(); }
            catch (BackgroundMessageException error)
            {
                if (error.DefinitelyNotDelivered) releaseRequired = false;
                throw;
            }
            held();
        }
        catch (Exception error) { operationFailure = error; throw; }
        finally
        {
            if (releaseRequired)
            {
                try { release(); }
                catch (Exception error)
                {
                    throw new InvalidOperationException("input_cleanup_unconfirmed: background input release was not acknowledged",
                      operationFailure == null ? error : new AggregateException(operationFailure, error));
                }
            }
        }
    }
    static Action BindBackgroundRelease(IntPtr target, Action release)
    {
        uint originalPid;
        uint originalThread = GetWindowThreadProcessId(target, out originalPid);
        return delegate
        {
            // Destroyed windows no longer own local message state. Never redirect
            // cleanup to a new process/thread that has acquired the old handle.
            uint currentPid;
            uint currentThread = GetWindowThreadProcessId(target, out currentPid);
            if (originalPid == 0 || originalThread == 0 || !IsWindowHandle(target)
              || currentPid != originalPid || currentThread != originalThread) return;
            release();
        };
    }
    static bool BelongsToTop(IntPtr top, IntPtr candidate)
    {
        if (!IsWindowHandle(top) || !IsWindowHandle(candidate)) return false;
        if (candidate != top && GetAncestor(candidate, 2) != top) return false;
        uint topPid, candidatePid;
        GetWindowThreadProcessId(top, out topPid);
        GetWindowThreadProcessId(candidate, out candidatePid);
        return topPid != 0 && topPid == candidatePid;
    }
    static IntPtr PointParam(int x, int y)
    {
        int packed = ((y & 0xFFFF) << 16) | (x & 0xFFFF);
        return new IntPtr(packed);
    }
    static POINT ClientPoint(IntPtr target, int screenX, int screenY)
    {
        POINT p = new POINT(); p.x = screenX; p.y = screenY;
        if (!ScreenToClient(target, ref p))
        {
            throw new InvalidOperationException("background_message_rejected|could not map point into target window");
        }
        return p;
    }
    static IntPtr MessageTargetAtPoint(IntPtr top, int screenX, int screenY)
    {
        if (!IsWindowHandle(top))
        {
            throw new InvalidOperationException("stale_target|native message target is stale or invalid");
        }
        RECT bounds;
        if (!GetWindowRect(top, out bounds)
            || screenX < bounds.left || screenX >= bounds.right
            || screenY < bounds.top || screenY >= bounds.bottom)
        {
            throw new InvalidOperationException("target_mismatch|native message point is outside the exact target window");
        }
        IntPtr current = top;
        for (int depth = 0; depth < 32; depth++)
        {
            POINT p = ClientPoint(current, screenX, screenY);
            IntPtr child = ChildWindowFromPointEx(current, p, 0x1 | 0x2 | 0x4);
            if (child == IntPtr.Zero || child == current) break;
            // WinUI 3 islands and UWP content read pointers from the system input
            // stack only: Paint and Settings accepted posted clicks and a posted
            // drag without any landing, which a success reply would have hidden.
            // UWP content lives in another process than its frame, so this is
            // judged before the same-process walk would stop at the frame.
            string surface = ClassNameOf(child);
            if (String.Equals(surface, "Microsoft.UI.Content.DesktopChildSiteBridge", StringComparison.Ordinal)
              || String.Equals(surface, "Windows.UI.Core.CoreWindow", StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                  "background_unsupported|this WinUI or UWP surface ignores posted pointer messages; use a semantic ref or explicit foreground delivery; no input sent");
            }
            if (!BelongsToTop(top, child)) break;
            current = child;
        }
        return current;
    }
    static uint PointerModifiers(string modifiers)
    {
        uint flags = 0;
        if (String.IsNullOrWhiteSpace(modifiers)) return flags;
        foreach (string raw in modifiers.ToLowerInvariant().Split('+'))
        {
            string part = raw.Trim();
            if (part == "ctrl") flags |= MK_CONTROL;
            else if (part == "shift") flags |= MK_SHIFT;
            else if (part.Length != 0)
            {
                throw new InvalidOperationException(
                  "background_unsupported|background pointer messages support only ctrl/shift modifiers; use explicit foreground delivery for " + part);
            }
        }
        return flags;
    }
    static void MouseClick(IntPtr target, IntPtr point, uint modifiers, uint down, uint up, uint button)
    {
        var release = BindBackgroundRelease(target, delegate
        {
            SendMessageChecked(target, up, new UIntPtr(modifiers), point);
        });
        WithBackgroundRelease(
          delegate { SendMessageChecked(target, down, new UIntPtr(modifiers | button), point); },
          delegate { }, release);
    }
    public static string BackgroundPointer(
      IntPtr top, int screenX, int screenY, string kind, string modifiers)
    {
        return WhileInactive(top, delegate { return BackgroundPointerCore(top, screenX, screenY, kind, modifiers); });
    }
    static string BackgroundPointerCore(
      IntPtr top, int screenX, int screenY, string kind, string modifiers)
    {
        IntPtr target = MessageTargetAtPoint(top, screenX, screenY);
        POINT p = ClientPoint(target, screenX, screenY);
        IntPtr point = PointParam(p.x, p.y);
        uint flags = PointerModifiers(modifiers);
        string action = (kind ?? "").ToLowerInvariant();
        if (action != "move" && action != "right" && action != "middle"
          && action != "click" && action != "double" && action != "triple"
          && action != "press" && action != "release")
        {
            throw new InvalidOperationException("background_unsupported|unknown background pointer action: " + kind);
        }
        // The message target is often a renderer child whose own class says
        // nothing about the host, so the top-level window decides too.
        if ((action == "double" || action == "triple")
          && (!SupportsBackgroundDoubleClickClass(ClassNameOf(target))
            || !SupportsBackgroundDoubleClickClass(ClassNameOf(top))))
        {
            throw new InvalidOperationException(
              "background_unsupported|target renderer ignores a posted double-click; use explicit foreground delivery; no input sent");
        }
        SendMessageChecked(target, WM_MOUSEMOVE, new UIntPtr(flags), point);
        if (action == "move")
        {
            ReportPointer(screenX, screenY, false, "move");
            return WindowId(target);
        }
        AnnounceBackgroundTarget(screenX, screenY);
        if (action == "press" || action == "release")
        {
            // A held button outlives this command, so its paired release belongs to
            // the session's cleanup instead of the release guard used above.
            bool pressing = action == "press";
            SendMessageChecked(target, pressing ? WM_LBUTTONDOWN : WM_LBUTTONUP,
              new UIntPtr(pressing ? (flags | MK_LBUTTON) : flags), point);
            ReportPointer(screenX, screenY, false, pressing ? "prepare" : "release");
            return WindowId(target);
        }
        if (action == "right")
        {
            MouseClick(target, point, flags, WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON);
            ReportPointer(screenX, screenY, false, "release");
            return WindowId(target);
        }
        if (action == "middle")
        {
            MouseClick(target, point, flags, WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON);
            ReportPointer(screenX, screenY, false, "release");
            return WindowId(target);
        }
        MouseClick(target, point, flags, WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON);
        if (action == "double" || action == "triple")
        {
            System.Threading.Thread.Sleep(20);
            MouseClick(target, point, flags, WM_LBUTTONDBLCLK, WM_LBUTTONUP, MK_LBUTTON);
        }
        if (action == "triple")
        {
            System.Threading.Thread.Sleep(20);
            MouseClick(target, point, flags, WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON);
        }
        ReportPointer(screenX, screenY, false, "release");
        return WindowId(target);
    }
    /// A gesture that is not a straight line (a signature, a lasso, a slider that
    /// follows a curve) is one press with several waypoints, so the path is the
    /// general form and a two-point drag is its shortest case.
    public static string BackgroundDragPath(IntPtr top, int[] screenX, int[] screenY, string modifiers)
    {
        return WhileInactive(top, delegate { return BackgroundDragPathCore(top, screenX, screenY, modifiers); });
    }
    static string BackgroundDragPathCore(IntPtr top, int[] screenX, int[] screenY, string modifiers)
    {
        if (screenX == null || screenY == null || screenX.Length != screenY.Length || screenX.Length < 2)
        {
            throw new InvalidOperationException("drag path requires at least two points");
        }
        IntPtr target = MessageTargetAtPoint(top, screenX[0], screenY[0]);
        for (int index = 1; index < screenX.Length; index++) MessageTargetAtPoint(top, screenX[index], screenY[index]);
        POINT start = ClientPoint(target, screenX[0], screenY[0]);
        uint flags = PointerModifiers(modifiers);
        SendMessageChecked(target, WM_MOUSEMOVE, new UIntPtr(flags), PointParam(start.x, start.y));
        AnnounceBackgroundTarget(screenX[0], screenY[0]);
        POINT last = start;
        int lastX = screenX[0], lastY = screenY[0];
        var release = BindBackgroundRelease(target, delegate
        {
            SendMessageChecked(target, WM_LBUTTONUP, new UIntPtr(flags), PointParam(last.x, last.y));
            ReportPointer(lastX, lastY, false);
        });
        WithBackgroundRelease(
          delegate { SendMessageChecked(target, WM_LBUTTONDOWN, new UIntPtr(flags | MK_LBUTTON), PointParam(start.x, start.y)); },
          delegate
          {
              ReportPointer(screenX[0], screenY[0], true);
              for (int leg = 1; leg < screenX.Length; leg++)
              {
                  int fromX = screenX[leg - 1], fromY = screenY[leg - 1];
                  for (int step = 1; step <= 12; step++)
                  {
                      lastX = fromX + (screenX[leg] - fromX) * step / 12;
                      lastY = fromY + (screenY[leg] - fromY) * step / 12;
                      last = ClientPoint(target, lastX, lastY);
                      SendMessageChecked(target, WM_MOUSEMOVE, new UIntPtr(flags | MK_LBUTTON), PointParam(last.x, last.y));
                      ReportPointer(lastX, lastY, true);
                      System.Threading.Thread.Sleep(20);
                  }
              }
          }, release);
        return WindowId(target);
    }
    public static string BackgroundDrag(
      IntPtr top, int screenX1, int screenY1, int screenX2, int screenY2, string modifiers)
    {
        return BackgroundDragPath(top, new int[] { screenX1, screenX2 }, new int[] { screenY1, screenY2 }, modifiers);
    }
    public static string BackgroundWheel(
      IntPtr top, int screenX, int screenY, int clicks, string modifiers)
    {
        return BackgroundWheel(top, screenX, screenY, clicks, modifiers, false);
    }
    public static string BackgroundWheel(
      IntPtr top, int screenX, int screenY, int clicks, string modifiers, bool horizontal)
    {
        return WhileInactive(top, delegate { return BackgroundWheelCore(top, screenX, screenY, clicks, modifiers, horizontal); });
    }
    static string BackgroundWheelCore(
      IntPtr top, int screenX, int screenY, int clicks, string modifiers, bool horizontal)
    {
        IntPtr target = MessageTargetAtPoint(top, screenX, screenY);
        // Chromium reroutes a wheel message to whatever window is on top at its
        // point: under another process's window it drops the wheel, under
        // another window of the same browser it scrolls that window instead.
        // Either way the target never scrolls, so refuse before any message.
        if ((IsChromiumClass(ClassNameOf(target)) || IsChromiumClass(ClassNameOf(top))) &&
            WindowAtPoint(screenX, screenY) != top)
        {
            throw new InvalidOperationException(
              "background_unsupported|the scroll point is covered by another window, so a background wheel would be dropped or reach that window; no input sent");
        }
        uint flags = PointerModifiers(modifiers);
        POINT client = ClientPoint(target, screenX, screenY);
        SendMessageChecked(target, WM_MOUSEMOVE, new UIntPtr(flags), PointParam(client.x, client.y));
        AnnounceBackgroundTarget(screenX, screenY);
        int delta = Math.Max(-12000, Math.Min(12000, clicks * 120));
        uint packed = ((uint)(delta & 0xFFFF) << 16) | flags;
        SendMessageChecked(target, horizontal ? WM_MOUSEHWHEEL : WM_MOUSEWHEEL, new UIntPtr(packed), PointParam(screenX, screenY));
        ReportPointer(screenX, screenY, false, "scroll");
        return WindowId(target);
    }
}
