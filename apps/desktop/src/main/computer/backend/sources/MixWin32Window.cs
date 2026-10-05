public partial class MixWin32
{
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(
      IntPtr token, int informationClass, IntPtr information, int informationLength, out int returnLength);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    public delegate bool EnumWindowProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumWindowProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", SetLastError = true)] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out RECT value, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out int value, int size);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct TOKEN_MANDATORY_LABEL
    {
        public SID_AND_ATTRIBUTES Label;
    }
    public sealed class WindowInfo
    {
        public IntPtr Handle;
        public string Id = "";
        public string Title = "";
        public string ClassName = "";
        public string App = "";
        public uint Pid;
        public uint ParentPid;
        public uint ContentPid;
        public string OwnerId = "";
        public bool Visible;
        public bool Cloaked;
        public bool Focused;
        public bool Minimized;
        public bool Maximized;
        public int X, Y, Width, Height;
        public int ClientX, ClientY, ClientWidth, ClientHeight;
    }
    public sealed class WindowCaptureInfo
    {
        public string PngBase64 = "";
        public int X, Y, Width, Height;
    }
    public sealed class WindowIntegrityInfo
    {
        public bool Known, Higher;
        public int OwnRid, TargetRid;
        public string OwnName = "";
        public string TargetName = "";
    }
    static int ProcessIntegrityRid(IntPtr process)
    {
        const uint TOKEN_QUERY = 0x0008;
        const int TokenIntegrityLevel = 25;
        IntPtr token;
        if (process == IntPtr.Zero || !OpenProcessToken(process, TOKEN_QUERY, out token)) return 0;
        try
        {
            int required = 0;
            GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out required);
            if (required <= 0) return 0;
            IntPtr buffer = Marshal.AllocHGlobal(required);
            try
            {
                if (!GetTokenInformation(token, TokenIntegrityLevel, buffer, required, out required)) return 0;
                TOKEN_MANDATORY_LABEL label =
                  (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(buffer, typeof(TOKEN_MANDATORY_LABEL));
                IntPtr countPointer = GetSidSubAuthorityCount(label.Label.Sid);
                if (countPointer == IntPtr.Zero) return 0;
                byte count = Marshal.ReadByte(countPointer);
                if (count == 0) return 0;
                IntPtr ridPointer = GetSidSubAuthority(label.Label.Sid, (uint)(count - 1));
                return ridPointer == IntPtr.Zero ? 0 : Marshal.ReadInt32(ridPointer);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            CloseHandle(token);
        }
    }
    static string IntegrityName(int rid)
    {
        if (rid >= 0x4000) return "System";
        if (rid >= 0x3000) return "High";
        if (rid >= 0x2100) return "Medium+";
        if (rid >= 0x2000) return "Medium";
        if (rid >= 0x1000) return "Low";
        return rid > 0 ? "Untrusted" : "Unknown";
    }
    public static WindowIntegrityInfo WindowIntegrity(IntPtr h)
    {
        int ownRid = ProcessIntegrityRid(GetCurrentProcess());
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        IntPtr targetProcess = pid == 0 ? IntPtr.Zero : OpenProcess(0x1000, false, pid);
        int targetRid = 0;
        if (targetProcess != IntPtr.Zero)
        {
            try { targetRid = ProcessIntegrityRid(targetProcess); }
            finally { CloseHandle(targetProcess); }
        }
        return new WindowIntegrityInfo
        {
            Known = ownRid > 0 && targetRid > 0,
            Higher = ownRid > 0 && targetRid > ownRid,
            OwnRid = ownRid,
            TargetRid = targetRid,
            OwnName = IntegrityName(ownRid),
            TargetName = IntegrityName(targetRid)
        };
    }
    // A window rect includes the invisible resize border, so a screen-region grab
    // taken from it reads pixels belonging to whatever sits behind the window.
    // DWM reports the window's visible rectangle, which is what a capture means.
    static bool TryVisibleWindowBounds(IntPtr h, out RECT bounds)
    {
        RECT extended;
        if (DwmGetWindowAttribute(h, 9, out extended, Marshal.SizeOf(typeof(RECT))) == 0
          && extended.right > extended.left
          && extended.bottom > extended.top)
        {
            bounds = extended;
            return true;
        }
        return GetWindowRect(h, out bounds);
    }
    public static WindowCaptureInfo CaptureWindowSurface(IntPtr h)
    {
        WindowCaptureTarget target = BeginWindowCapture(h, false);
        using (Bitmap bitmap = new Bitmap(target.Width, target.Height, PixelFormat.Format32bppRgb))
        using (Graphics graphics = Graphics.FromImage(bitmap))
        using (MemoryStream stream = new MemoryStream())
        {
            // Ask the exact window to render into our bitmap. Never read a desktop DC.
            IntPtr dc = graphics.GetHdc();
            bool rendered;
            try { rendered = PrintWindow(h, dc, 0); }
            finally { graphics.ReleaseHdc(dc); }
            if (!rendered) throw new InvalidOperationException("capture_source_unavailable|window-owned rendering is unavailable");
            AssertWindowCaptureStable(target);
            bitmap.Save(stream, ImageFormat.Png);
            return target.Result(Convert.ToBase64String(stream.ToArray()));
        }
    }
    public sealed class WindowCaptureTarget
    {
        internal IntPtr Handle;
        internal uint Pid, Thread;
        internal bool Composited;
        public int X, Y, Width, Height;
        public WindowCaptureInfo Result(string png)
        {
            return new WindowCaptureInfo { PngBase64 = png, X = X, Y = Y, Width = Width, Height = Height };
        }
    }
    public static WindowCaptureTarget BeginWindowCapture(IntPtr h, bool composited)
    {
        if (!IsWindowHandle(h))
        {
            throw new InvalidOperationException("capture_source_unavailable|exact native window is stale or invalid");
        }
        if (IsIconic(h))
        {
            throw new InvalidOperationException("capture_minimized|minimized native window has no rendered surface");
        }
        if (IsCloaked(h))
        {
            throw new InvalidOperationException(
              "capture_cloaked|native window is cloaked and has no available surface");
        }
        RECT bounds;
        if (!(composited ? TryVisibleWindowBounds(h, out bounds) : GetWindowRect(h, out bounds)))
        {
            throw new InvalidOperationException("capture_source_unavailable|could not read exact native window bounds");
        }
        int width = bounds.right - bounds.left;
        int height = bounds.bottom - bounds.top;
        if (width <= 0 || height <= 0 || (long)width * height > 16777216L)
        {
            throw new InvalidOperationException("capture_source_unavailable|exact native window bounds exceed the capture budget");
        }
        uint pid;
        uint thread = GetWindowThreadProcessId(h, out pid);
        if (thread == 0 || pid == 0) throw new InvalidOperationException("capture_source_unavailable|native window identity is unavailable");
        return new WindowCaptureTarget
        {
            Handle = h,
            Pid = pid,
            Thread = thread,
            Composited = composited,
            X = bounds.left,
            Y = bounds.top,
            Width = width,
            Height = height
        };
    }
    public static void AssertWindowCaptureStable(WindowCaptureTarget before)
    {
        WindowCaptureTarget after = BeginWindowCapture(before.Handle, before.Composited);
        if (before.Pid != after.Pid || before.Thread != after.Thread
          || before.X != after.X || before.Y != after.Y
          || before.Width != after.Width || before.Height != after.Height)
        {
            throw new InvalidOperationException("capture_geometry_changed|native window changed during capture");
        }
    }
    static string Text(IntPtr h)
    {
        StringBuilder s = new StringBuilder(1024);
        GetWindowText(h, s, s.Capacity);
        return s.ToString();
    }
    static string ClassNameOf(IntPtr h)
    {
        StringBuilder s = new StringBuilder(256);
        GetClassName(h, s, s.Capacity);
        return s.ToString();
    }
    public static string WindowId(IntPtr h) { return "hwnd:0x" + h.ToInt64().ToString("X"); }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MENUITEMINFO
    {
        public uint cbSize, fMask, fType, fState, wID;
        public IntPtr hSubMenu, hbmpChecked, hbmpUnchecked, dwItemData;
        public IntPtr dwTypeData;
        public uint cch;
        public IntPtr hbmpItem;
    }
    [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool GetMenuItemInfo(IntPtr menu, uint item, bool byPosition, ref MENUITEMINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetMenuString(IntPtr menu, uint item, StringBuilder text, int maximum, uint flags);
    public sealed class MenuEntry
    {
        public string Label;
        public IntPtr SubMenu;
        public uint Id;
        public bool Enabled;
    }
    /// The classic menu bar a window owns, or zero when it has none (ribbons,
    /// XAML and web content draw their own menus).
    public static IntPtr WindowMenu(IntPtr hwnd) { return IsWindowHandle(hwnd) ? GetMenu(hwnd) : IntPtr.Zero; }
    /// One level of a classic menu. A submenu is first announced the way an
    /// opening menu is, so the app refreshes the enabled state and dynamic items
    /// it would show a person.
    public static MenuEntry[] MenuEntries(IntPtr hwnd, IntPtr menu, int position, bool announce)
    {
        const uint WM_INITMENUPOPUP = 0x0117, MIIM_STATE = 0x1, MIIM_ID = 0x2, MIIM_SUBMENU = 0x4, MIIM_FTYPE = 0x100;
        const uint MFT_SEPARATOR = 0x800, MFS_DISABLED = 0x3, MF_BYPOSITION = 0x400;
        if (announce)
        {
            SendMessageValue(hwnd, WM_INITMENUPOPUP, new UIntPtr((ulong)menu.ToInt64()), new IntPtr(position & 0xFFFF));
        }
        var entries = new List<MenuEntry>();
        int count = GetMenuItemCount(menu);
        for (int index = 0; index < count; index++)
        {
            var info = new MENUITEMINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(MENUITEMINFO));
            info.fMask = MIIM_STATE | MIIM_ID | MIIM_SUBMENU | MIIM_FTYPE;
            if (!GetMenuItemInfo(menu, (uint)index, true, ref info) || (info.fType & MFT_SEPARATOR) != 0) continue;
            var label = new StringBuilder(512);
            GetMenuString(menu, (uint)index, label, label.Capacity, MF_BYPOSITION);
            entries.Add(new MenuEntry
            {
                Label = label.ToString(),
                SubMenu = info.hSubMenu,
                Id = info.wID,
                Enabled = (info.fState & MFS_DISABLED) == 0,
            });
        }
        return entries.ToArray();
    }
    /// The notification a person choosing the item produces, without opening
    /// any menu on screen.
    [DllImport("user32.dll", EntryPoint = "PostMessageW", SetLastError = true)]
    static extern bool PostMessageWithError(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    public static void PostMenuCommand(IntPtr hwnd, uint id)
    {
        const uint WM_COMMAND = 0x0111;
        ClearMessageError(0);
        if (!PostMessageWithError(hwnd, WM_COMMAND, new IntPtr(id & 0xFFFF), IntPtr.Zero))
        {
            int error = Marshal.GetLastWin32Error();
            if (error == 5)
            {
                throw new InvalidOperationException("background_blocked_uipi|Windows integrity isolation blocked the menu command");
            }
            throw new InvalidOperationException("background_message_rejected|menu command failed with Win32 error " + error);
        }
    }
    public static IntPtr ParseWindowId(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return IntPtr.Zero;
        string raw = value.Trim();
        if (raw.StartsWith("hwnd:", StringComparison.OrdinalIgnoreCase)) raw = raw.Substring(5);
        if (raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) raw = raw.Substring(2);
        long parsed;
        return Int64.TryParse(raw, System.Globalization.NumberStyles.HexNumber, null, out parsed)
          ? new IntPtr(parsed) : IntPtr.Zero;
    }
    public static bool IsWindowHandle(IntPtr h) { return h != IntPtr.Zero && IsWindow(h); }
    // DWM cloaks windows that live on another virtual desktop or belong to a
    // suspended UWP app. They still pass IsWindowVisible, yet the user cannot see
    // them and a screen grab of their rect reads whatever sits behind them.
    public static bool IsCloaked(IntPtr h)
    {
        int cloaked;
        return DwmGetWindowAttribute(h, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0;
    }
    static bool IsShown(WindowInfo info)
    {
        return info != null && info.Visible && !info.Cloaked && info.Width > 0 && info.Height > 0;
    }
    public static bool IsOwnedBy(IntPtr candidate, IntPtr expectedOwner)
    {
        if (!IsWindowHandle(candidate) || !IsWindowHandle(expectedOwner) || candidate == expectedOwner) return false;
        HashSet<IntPtr> visited = new HashSet<IntPtr>();
        IntPtr current = candidate;
        while (current != IntPtr.Zero && visited.Add(current))
        {
            current = GetWindow(current, 4);
            if (current == expectedOwner) return true;
        }
        return false;
    }
    public static bool SharesProcess(IntPtr first, IntPtr second)
    {
        if (!IsWindowHandle(first) || !IsWindowHandle(second)) return false;
        uint firstPid, secondPid;
        GetWindowThreadProcessId(first, out firstPid);
        GetWindowThreadProcessId(second, out secondPid);
        return firstPid != 0 && firstPid == secondPid;
    }
    /// Whether the window is the given top-level window or lives inside it. A
    /// packaged app's content window belongs to another process than the frame
    /// that hosts it, so only the window tree ties the two together.
    public static bool IsWithinTopLevel(IntPtr candidate, IntPtr topLevel)
    {
        if (!IsWindowHandle(candidate) || !IsWindowHandle(topLevel)) return false;
        return candidate == topLevel || GetAncestor(candidate, 2) == topLevel;
    }
    // GA_ROOT follows the parent chain, not the owner chain. An owned modal
    // window is a distinct input surface even when UIA nests it under its owner.
    public static IntPtr TopLevelWindow(IntPtr handle) { return GetAncestor(handle, 2); }
    public static bool IsContainedSameProcess(IntPtr candidate, IntPtr expectedSurface)
    {
        if (!SharesProcess(candidate, expectedSurface)) return false;
        RECT candidateBounds, surfaceBounds;
        if (!GetWindowRect(candidate, out candidateBounds)
            || !GetWindowRect(expectedSurface, out surfaceBounds)) return false;
        return candidateBounds.right > candidateBounds.left
          && candidateBounds.bottom > candidateBounds.top
          && candidateBounds.left >= surfaceBounds.left
          && candidateBounds.top >= surfaceBounds.top
          && candidateBounds.right <= surfaceBounds.right
          && candidateBounds.bottom <= surfaceBounds.bottom;
    }
    public static WindowInfo Info(IntPtr h)
    {
        return Info(h, true);
    }
    static WindowInfo Info(IntPtr h, bool includeApp)
    {
        if (!IsWindowHandle(h)) return null;
        uint pid;
        uint threadId = GetWindowThreadProcessId(h, out pid);
        RECT r;
        GetWindowRect(h, out r);
        RECT client;
        POINT clientOrigin = new POINT();
        bool hasClient = GetClientRect(h, out client) && ClientToScreen(h, ref clientOrigin);
        IntPtr owner = GetWindow(h, 4);
        string className = ClassNameOf(h);
        // Native popup menus can have no GW_OWNER. The owning GUI thread
        // still identifies the window whose menu loop is active.
        if (owner == IntPtr.Zero && className == "#32768")
        {
            GUITHREADINFO gui = new GUITHREADINFO();
            gui.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
            if (GetGUIThreadInfo(threadId, ref gui) && gui.hwndMenuOwner != h && IsWindowHandle(gui.hwndMenuOwner))
            {
                uint ownerPid;
                GetWindowThreadProcessId(gui.hwndMenuOwner, out ownerPid);
                if (ownerPid == pid) owner = gui.hwndMenuOwner;
            }
        }
        string app = "";
        if (includeApp)
        {
            try { app = Process.GetProcessById((int)pid).ProcessName; } catch { }
        }
        return new WindowInfo
        {
            Handle = h,
            Id = WindowId(h),
            Title = Text(h),
            ClassName = className,
            App = app,
            Pid = pid,
            ParentPid = ParentProcessId(pid),
            ContentPid = ContentProcessId(h, pid, className),
            OwnerId = owner == IntPtr.Zero ? "" : WindowId(owner),
            Visible = IsWindowVisible(h),
            Cloaked = IsCloaked(h),
            Focused = GetForegroundWindow() == h,
            Minimized = IsIconic(h),
            Maximized = IsZoomed(h),
            X = r.left,
            Y = r.top,
            Width = Math.Max(0, r.right - r.left),
            Height = Math.Max(0, r.bottom - r.top),
            ClientX = hasClient ? clientOrigin.x : r.left,
            ClientY = hasClient ? clientOrigin.y : r.top,
            ClientWidth = hasClient ? Math.Max(0, client.right - client.left) : Math.Max(0, r.right - r.left),
            ClientHeight = hasClient ? Math.Max(0, client.bottom - client.top) : Math.Max(0, r.bottom - r.top)
        };
    }
    /// The shown windows with their process names, looked up once per process.
    public static WindowInfo[] Windows()
    {
        WindowInfo[] result = WindowSnapshot();
        Dictionary<uint, string> apps = new Dictionary<uint, string>();
        foreach (WindowInfo info in result)
        {
            string app;
            if (!apps.TryGetValue(info.Pid, out app))
            {
                app = "";
                try { app = Process.GetProcessById((int)info.Pid).ProcessName; } catch { }
                apps[info.Pid] = app;
            }
            info.App = app;
        }
        return result;
    }
    public static WindowInfo[] WindowSnapshot()
    {
        List<WindowInfo> result = new List<WindowInfo>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            WindowInfo info = Info(h, false);
            if (IsShown(info)) result.Add(info);
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    public static string[] RelatedWindowIds(IntPtr target)
    {
        if (!IsWindowHandle(target)) return new string[0];
        List<string> result = new List<string>();
        result.Add(WindowId(target));
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (h != target && IsWindowVisible(h) && !IsCloaked(h) && IsOwnedBy(h, target))
            {
                result.Add(WindowId(h));
            }
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    public static bool IsMinimized(IntPtr h) { return IsWindowHandle(h) && IsIconic(h); }
    public static bool IsMaximized(IntPtr h) { return IsWindowHandle(h) && IsZoomed(h); }
    public static bool CloseWindow(IntPtr h)
    {
        if (!IsWindowHandle(h)) return false;
        // Closing can run save dialogs and lengthy shutdown work. Queue the
        // request; the caller observes closure separately instead of treating
        // a slow WM_CLOSE handler as failed input.
        ClearMessageError(0);
        if (!PostMessageWithError(h, 0x0010, IntPtr.Zero, IntPtr.Zero))
        {
            int error = Marshal.GetLastWin32Error();
            if (error == 5)
            {
                throw new BackgroundMessageException("background_blocked_uipi|Windows integrity isolation blocked the close request", true);
            }
            throw new InvalidOperationException("background_message_rejected|close request failed with Win32 error " + error);
        }
        return true;
    }
    [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr hwnd);
    /// A window that still answers messages can be asked to close and save; only a
    /// window that stopped answering has nothing left to ask.
    public static bool IsWindowResponding(IntPtr h)
    {
        return IsWindowHandle(h) && !IsHungAppWindow(h);
    }
    /// A packaged app runs in its own process while the system hosts its frame,
    /// so the frame window's pid identifies the host, never the app that was
    /// launched. The hosted content window carries the process that owns it.
    static uint ContentProcessId(IntPtr h, uint hostPid, string className)
    {
        if (className != "ApplicationFrameWindow") return 0;
        uint contentPid = 0;
        EnumChildWindows(h, delegate (IntPtr child, IntPtr state)
        {
            if (ClassNameOf(child) != "Windows.UI.Core.CoreWindow") return true;
            uint childPid;
            GetWindowThreadProcessId(child, out childPid);
            if (childPid == 0 || childPid == hostPid) return true;
            contentPid = childPid;
            return false;
        }, IntPtr.Zero);
        return contentPid;
    }
}
