public partial class MixWin32
{
    // SetForegroundWindow from a background process is refused by the Windows
    // foreground lock. Verify the switch actually happened and escalate through
    // the documented workarounds; report failure honestly instead of typing
    // into whatever window the user happens to have focused.
    static bool TryFocusAttached(IntPtr h)
    {
        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
        uint targetThread = GetWindowThreadProcessId(h, IntPtr.Zero);
        uint currentThread = GetCurrentThreadId();
        bool attachedForeground = foregroundThread != 0
          && foregroundThread != currentThread
          && AttachThreadInput(currentThread, foregroundThread, true);
        bool attachedTarget = targetThread != 0
          && targetThread != currentThread
          && targetThread != foregroundThread
          && AttachThreadInput(currentThread, targetThread, true);
        try
        {
            RestoreIfMinimized(h);
            BringWindowToTop(h);
            SetForegroundWindow(h);
            SetActiveWindow(h);
            SetFocus(h);
            return GetForegroundWindow() == h;
        }
        finally
        {
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }
    }
    // SW_RESTORE un-maximizes a maximized window, so restore only what is truly
    // minimized: activation is SetForegroundWindow's job and must never resize
    // the window the user arranged.
    static void RestoreIfMinimized(IntPtr h) { if (IsIconic(h)) ShowWindow(h, 9); }
    const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
    const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
    /// The foreground lock is a timeout, not a permission, and a background
    /// process may drop it for the length of one switch. Synthetic keystrokes
    /// clear it too, but any dummy virtual key reaches OEM lock-key overlays and
    /// flashes a NumLock indicator, so move the timeout instead of the keyboard.
    static bool TryClearForegroundLockTimeout(out uint previous)
    {
        previous = 0;
        IntPtr buffer = Marshal.AllocHGlobal(4);
        try
        {
            if (!SystemParametersInfo(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, buffer, 0)) return false;
            previous = (uint)Marshal.ReadInt32(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        if (previous == 0) return false;
        return SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, 0);
    }
    static void SetForegroundLockTimeout(uint value)
    {
        SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, new IntPtr(value), 0);
    }
    public static bool Focus(IntPtr h)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return false;
        RestoreIfMinimized(h);
        SetForegroundWindow(h);
        if (GetForegroundWindow() == h) return true;
        if (TryFocusAttached(h)) return true;
        uint lockTimeout;
        bool relaxed = TryClearForegroundLockTimeout(out lockTimeout);
        try
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                if (TryFocusAttached(h)) return true;
                System.Threading.Thread.Sleep(25);
            }
        }
        finally
        {
            if (relaxed) SetForegroundLockTimeout(lockTimeout);
        }
        return false;
    }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    /// Top-level window that would receive a click at (x, y).
    public static IntPtr WindowAtPoint(int x, int y)
    {
        POINT p = new POINT(); p.x = x; p.y = y;
        IntPtr h = WindowFromPoint(p);
        return h == IntPtr.Zero ? h : GetAncestor(h, 2);
    }
    public static IntPtr Foreground() { return GetForegroundWindow(); }
    public static POINT Cursor()
    {
        POINT p;
        GetCursorPos(out p);
        return p;
    }
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    /// UIA reports physical pixels; a DPI-unaware process hit-tests and moves
    /// the cursor in virtualized coordinates, skewing every point on scaled
    /// monitors. Make this host per-monitor DPI aware so both sides agree.
    public static void MakeDpiAware()
    {
        if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
    }
    public const uint LDOWN = 0x02, LUP = 0x04, RDOWN = 0x08, RUP = 0x10, WHEEL = 0x0800, HWHEEL = 0x1000, MDOWN = 0x20, MUP = 0x40;
    public static POINT CursorMotionPoint(int x1, int y1, int x2, int y2, int step, int steps)
    {
        double t = Math.Max(0, Math.Min(1, (double)step / Math.Max(1, steps)));
        double eased = t * t * (3 - 2 * t);
        POINT p = new POINT();
        p.x = (int)Math.Round(x1 + (x2 - x1) * eased);
        p.y = (int)Math.Round(y1 + (y2 - y1) * eased);
        return p;
    }
    public static void GlideCursor(IntPtr target, int x, int y)
    {
        MixInputObservation.AssertContinue();
        POINT start = Cursor();
        double distance = Math.Sqrt(Math.Pow(x - start.x, 2) + Math.Pow(y - start.y, 2));
        int steps = Math.Max(1, (int)Math.Ceiling(Math.Min(650, Math.Max(240, distance * .25)) / 16));
        for (int step = 1; step <= steps; step++)
        {
            MixInputObservation.AssertContinue();
            AssertDragTarget(target, x, y);
            POINT point = CursorMotionPoint(start.x, start.y, x, y, step, steps);
            if (!SetCursorPos(point.x, point.y)) throw new InvalidOperationException("input_delivery_failed: pointer movement was rejected");
            POINT actual = Cursor();
            ReportPointer(actual.x, actual.y, false, "move");
            System.Threading.Thread.Sleep(16);
        }
        MixInputObservation.AssertContinue();
        AssertDragTarget(target, x, y);
        AssertCursorPosition(x, y);
    }
    public static void AssertCursorPosition(int x, int y)
    {
        MixInputObservation.AssertContinue();
        POINT actual = Cursor();
        if (actual.x != x || actual.y != y)
        {
            throw new InvalidOperationException("target_mismatch|cursor did not reach the observed point; no positive pointer input sent");
        }
    }
    public static void Click(int x, int y)
    {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(40);
        AssertCursorPosition(x, y);
        mouse_event(LDOWN, 0, 0, 0, IntPtr.Zero); mouse_event(LUP, 0, 0, 0, IntPtr.Zero);
    }
    public static void DoubleClick(int x, int y)
    {
        Click(x, y); System.Threading.Thread.Sleep(80);
        AssertCursorPosition(x, y);
        mouse_event(LDOWN, 0, 0, 0, IntPtr.Zero); mouse_event(LUP, 0, 0, 0, IntPtr.Zero);
    }
    public static void RightClick(int x, int y)
    {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(40);
        AssertCursorPosition(x, y);
        mouse_event(RDOWN, 0, 0, 0, IntPtr.Zero); mouse_event(RUP, 0, 0, 0, IntPtr.Zero);
    }
    public static void MiddleClick(int x, int y)
    {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(40);
        AssertCursorPosition(x, y);
        mouse_event(MDOWN, 0, 0, 0, IntPtr.Zero); mouse_event(MUP, 0, 0, 0, IntPtr.Zero);
    }
    public static void TripleClick(int x, int y)
    {
        Click(x, y); System.Threading.Thread.Sleep(60);
        AssertCursorPosition(x, y);
        mouse_event(LDOWN, 0, 0, 0, IntPtr.Zero); mouse_event(LUP, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        AssertCursorPosition(x, y);
        mouse_event(LDOWN, 0, 0, 0, IntPtr.Zero); mouse_event(LUP, 0, 0, 0, IntPtr.Zero);
    }
    static void AssertDragTarget(IntPtr target, int x, int y)
    {
        IntPtr hit = WindowAtPoint(x, y);
        IntPtr foreground = Foreground();
        if (!IsWindowHandle(target) || (foreground != target && !HoldsForActivation(foreground))
          || (hit != target && !IsContainedSameProcess(hit, target)))
        {
            throw new InvalidOperationException("target_mismatch|drag target changed; observe fresh state before retrying");
        }
    }
    // A pointer action may activate a target that refused focus: the press is
    // the activation, so until it lands the window that kept the foreground may
    // hold it. Only the foreground action that began the activation ends it.
    static bool pointerActivationPending;
    static IntPtr pointerActivationHolder;
    public static void BeginPointerActivation(IntPtr holder)
    {
        pointerActivationHolder = holder;
        pointerActivationPending = true;
    }
    public static void EndPointerActivation()
    {
        pointerActivationPending = false;
        pointerActivationHolder = IntPtr.Zero;
    }
    public static bool HoldsForActivation(IntPtr foreground)
    {
        return pointerActivationPending && foreground == pointerActivationHolder;
    }
    /// The foreground twin of BackgroundDragPath: one physical press that travels
    /// through every waypoint, checking the target still owns each one.
    public static void DragPath(int[] x, int[] y, IntPtr target)
    {
        if (x == null || y == null || x.Length != y.Length || x.Length < 2)
        {
            throw new InvalidOperationException("drag path requires at least two points");
        }
        for (int index = 0; index < x.Length; index++) AssertDragTarget(target, x[index], y[index]);
        GlideCursor(target, x[0], y[0]); System.Threading.Thread.Sleep(60);
        AssertDragTarget(target, x[0], y[0]);
        mouse_event(LDOWN, 0, 0, 0, IntPtr.Zero);
        try
        {
            ReportPointer(x[0], y[0], true);
            System.Threading.Thread.Sleep(150);
            for (int leg = 1; leg < x.Length; leg++)
            {
                int fromX = x[leg - 1], fromY = y[leg - 1];
                for (int step = 1; step <= 12; step++)
                {
                    int pointX = fromX + (x[leg] - fromX) * step / 12;
                    int pointY = fromY + (y[leg] - fromY) * step / 12;
                    AssertDragTarget(target, pointX, pointY);
                    SetCursorPos(pointX, pointY);
                    ReportPointer(pointX, pointY, true);
                    System.Threading.Thread.Sleep(20);
                    AssertCursorPosition(pointX, pointY);
                }
            }
            System.Threading.Thread.Sleep(80);
            AssertDragTarget(target, x[x.Length - 1], y[y.Length - 1]);
        }
        finally
        {
            mouse_event(LUP, 0, 0, 0, IntPtr.Zero);
        }
    }
    public static void Drag(int x1, int y1, int x2, int y2, IntPtr target)
    {
        AssertDragTarget(target, x1, y1);
        AssertDragTarget(target, x2, y2);
        GlideCursor(target, x1, y1); System.Threading.Thread.Sleep(60);
        AssertDragTarget(target, x1, y1);
        mouse_event(LDOWN, 0, 0, 0, IntPtr.Zero);
        try
        {
            ReportPointer(x1, y1, true);
            System.Threading.Thread.Sleep(150);
            for (int i = 1; i <= 12; i++)
            {
                int x = x1 + (x2 - x1) * i / 12, y = y1 + (y2 - y1) * i / 12;
                AssertDragTarget(target, x, y);
                SetCursorPos(x, y);
                ReportPointer(x, y, true);
                System.Threading.Thread.Sleep(20);
                AssertCursorPosition(x, y);
            }
            System.Threading.Thread.Sleep(80);
            AssertDragTarget(target, x2, y2);
        }
        finally
        {
            mouse_event(LUP, 0, 0, 0, IntPtr.Zero);
        }
    }
    // Named MouseWheel: PowerShell resolves members case-insensitively, so a
    // method called Wheel collides with the WHEEL constant above.
    public static void MouseWheel(int clicks) { mouse_event(WHEEL, 0, 0, clicks * 120, IntPtr.Zero); }
    public static void MouseHWheel(int clicks) { mouse_event(HWHEEL, 0, 0, clicks * 120, IntPtr.Zero); }

}
