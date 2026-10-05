public partial class MixWin32
{
    public static Action<int, int, bool, string> PointerProgress;
    public static int PointerEventsGenerated;
    public static int PointerEventsFailed;
    /// Background input announces its target, then waits for the presented
    /// pointer to travel there before acting; foreground input already sits
    /// under the real pointer. No wait when nobody is presenting the pointer.
    public const int PointerGlideWaitMs = 360;
    /// The presented pointer travels at a fixed speed between the point it is
    /// already showing and the new target, so a short hop arrives long before
    /// the longest possible travel. Waiting the maximum every time spends that
    /// difference on nothing; these mirror the overlay's own travel plan.
    public const int PointerGlideMinWaitMs = 140;
    public const double PointerGlideSpeedPxPerMs = 1.4;
    public const int PointerGlideSeedOffset = 140;
    static int lastPointerX = int.MinValue;
    static int lastPointerY = int.MinValue;
    /// How long the pointer presented by the last report needs to arrive. The
    /// caller that announced a target reads this instead of assuming the
    /// longest travel.
    public static int LastGlideWaitMs = PointerGlideWaitMs;
    static int GlideWaitTo(int screenX, int screenY)
    {
        double dx = PointerGlideSeedOffset;
        double dy = PointerGlideSeedOffset;
        if (lastPointerX != int.MinValue)
        {
            dx = screenX - lastPointerX;
            dy = screenY - lastPointerY;
        }
        double travel = Math.Sqrt(dx * dx + dy * dy) / PointerGlideSpeedPxPerMs;
        if (travel < PointerGlideMinWaitMs) return PointerGlideMinWaitMs;
        if (travel > PointerGlideWaitMs) return PointerGlideWaitMs;
        return (int)Math.Round(travel);
    }
    static void AnnounceBackgroundTarget(int screenX, int screenY)
    {
        if (PointerProgress == null) return;
        ReportPointer(screenX, screenY, false, "prepare");
        System.Threading.Thread.Sleep(LastGlideWaitMs);
    }
    public static void ReportPointer(int x, int y, bool held, string phase = null)
    {
        var report = PointerProgress;
        if (report != null)
        {
            PointerEventsGenerated++;
            // Measured against the point the overlay is showing now, before this
            // report moves it, because that is the travel being waited on.
            LastGlideWaitMs = GlideWaitTo(x, y);
            try { report(x, y, held, phase ?? (held ? "drag" : "move")); }
            catch { PointerEventsFailed++; }
            lastPointerX = x;
            lastPointerY = y;
        }
    }
    public static void ReportCurrentPointer(string phase)
    {
        POINT point = Cursor();
        ReportPointer(point.x, point.y, false, phase);
    }
    /// Keyboard input lands on a control, not under the pointer the user left
    /// elsewhere, so its indicator names that control's point instead.
    public static void ReportInputPoint(int screenX, int screenY, string phase)
    {
        ReportPointer(screenX, screenY, false, phase);
    }
    static void ReportWindowInput(IntPtr target, string phase)
    {
        if (PointerProgress == null) return;
        RECT bounds;
        if (!GetWindowRect(target, out bounds) || bounds.right <= bounds.left || bounds.bottom <= bounds.top)
        {
            PointerEventsFailed++;
            return;
        }
        ReportPointer(bounds.left + (bounds.right - bounds.left) / 2,
          bounds.top + (bounds.bottom - bounds.top) / 2, false, phase);
    }
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    public static int LastInjectionTick { get { return unchecked((int)MixInputObservation.Read().OwnTick); } }
    // Compatibility call sites do not invent input timestamps.
    public static void NoteInjection() { }
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    public static bool SetCursorPos(int X, int Y)
    {
        MixInputObservation.AssertContinue();
        POINT current = Cursor();
        if (current.x == X && current.y == Y) return true;
        int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        if (width < 2 || height < 2) return false;
        INPUT input = new INPUT(); input.type = 0;
        input.U.mi.dx = (int)Math.Round((X - GetSystemMetrics(76)) * 65535.0 / (width - 1));
        input.U.mi.dy = (int)Math.Round((Y - GetSystemMetrics(77)) * 65535.0 / (height - 1));
        input.U.mi.dwFlags = 0xC001;
        input.U.mi.dwExtraInfo = MixInputObservation.Marker;
        MixNativeInput.Deliver(new INPUT[] { input });
        return true;
    }
    public static void mouse_event(uint f, int dx, int dy, int d, IntPtr e)
    {
        if ((f & (0x0002 | 0x0008 | 0x0020 | 0x0800 | 0x1000)) != 0) MixInputObservation.AssertContinue();
        bool down = (f & (0x0002 | 0x0008 | 0x0020)) != 0;
        if (down && PointerProgress != null)
        {
            POINT point = Cursor();
            ReportPointer(point.x, point.y, false, "prepare");
            System.Threading.Thread.Sleep(120);
            MixInputObservation.AssertContinue();
        }
        INPUT input = MixNativeInput.Mouse(f, MixInputObservation.Marker);
        input.U.mi.dx = dx; input.U.mi.dy = dy; input.U.mi.mouseData = unchecked((uint)d);
        MixNativeInput.Deliver(new INPUT[] { input });
        if ((f & (WHEEL | HWHEEL)) != 0) ReportCurrentPointer("scroll");
        if (down || (f & (0x0004 | 0x0010 | 0x0040)) != 0)
        {
            POINT point = Cursor();
            ReportPointer(point.x, point.y, down, down ? "press" : "release");
        }
    }
    /// Milliseconds since input not tagged by this host's workers.
    /// int.MaxValue when the most recent input on record is an injection,
    /// -1 when the input origin cannot be observed.
    public static int PhysicalInputIdleMs(int knownInjectionTick, bool hasKnownInjection)
    {
        var observed = MixInputObservation.Read();
        if (!observed.Ready) return -1;
        if (observed.LastOwn) return int.MaxValue;
        int idle = unchecked(Environment.TickCount - (int)observed.Tick);
        return idle < 0 ? 0 : idle;
    }
    public static long InputTick()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        return GetLastInputInfo(ref info) ? (long)info.dwTime : -1L;
    }
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetActiveWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
