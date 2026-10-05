public partial class MixWin32
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHELLEXECUTEINFO
    {
        public int cbSize;
        public uint fMask;
        public IntPtr hwnd;
        public string lpVerb;
        public string lpFile;
        public string lpParameters;
        public string lpDirectory;
        public int nShow;
        public IntPtr hInstApp;
        public IntPtr lpIDList;
        public string lpClass;
        public IntPtr hkeyClass;
        public uint dwHotKey;
        public IntPtr hIcon;
        public IntPtr hProcess;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ShellExecuteExW(ref SHELLEXECUTEINFO info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetProcessId(IntPtr process);
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),
      InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ApplicationActivation
    {
        [PreserveSig]
        int ActivateApplication(
          [MarshalAs(UnmanagedType.LPWStr)] string appId,
          [MarshalAs(UnmanagedType.LPWStr)] string arguments,
          int options,
          out uint processId);
    }
    /// A packaged app cannot be started from its executable path: Windows keeps a
    /// stub there and hands the real work to the activation broker, so a shell
    /// launch reports a process that owns no window. Activating the app id returns
    /// the process that actually hosts it.
    public static int ActivateAppId(string appId)
    {
        const int ACTIVATE_NO_ERROR_UI = 0x2;
        var manager = (ApplicationActivation)Activator.CreateInstance(
          Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
        uint launched;
        int code = manager.ActivateApplication(appId, null, ACTIVATE_NO_ERROR_UI, out launched);
        if (code < 0) Marshal.ThrowExceptionForHR(code);
        return (int)launched;
    }
    /// A launch keeps the user's foreground window: the app is shown without being
    /// activated, the same promise every background input path makes. Returns the
    /// launched process id, or 0 when the shell reports no process.
    public static int LaunchWithoutActivation(string target)
    {
        const uint SEE_MASK_NOCLOSEPROCESS = 0x00000040;
        const uint SEE_MASK_FLAG_NO_UI = 0x00000400;
        const int SW_SHOWNOACTIVATE = 4;
        var request = new SHELLEXECUTEINFO();
        request.cbSize = Marshal.SizeOf(typeof(SHELLEXECUTEINFO));
        request.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI;
        request.lpFile = target;
        request.nShow = SW_SHOWNOACTIVATE;
        if (!ShellExecuteExW(ref request))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        if (request.hProcess == IntPtr.Zero) return 0;
        try { return (int)GetProcessId(request.hProcess); }
        finally { CloseHandle(request.hProcess); }
    }
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int height, bool repaint);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint winIni);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern bool GetProcessTimes(
      IntPtr process, out long created, out long exited, out long kernel, out long user);
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr Reserved1, PebBaseAddress, Reserved2a, Reserved2b, UniqueProcessId, ParentProcessId;
    }
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(
      IntPtr process, int informationClass, out PROCESS_BASIC_INFORMATION information, int length, out int returned);
    static uint ParentProcessId(IntPtr process)
    {
        PROCESS_BASIC_INFORMATION information;
        int returned;
        return process != IntPtr.Zero &&
          NtQueryInformationProcess(process, 0, out information, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned) == 0
          ? unchecked((uint)information.ParentProcessId.ToInt64()) : 0;
    }
    static uint ParentProcessId(uint pid)
    {
        IntPtr process = OpenProcess(0x1000, false, pid);
        try { return ParentProcessId(process); }
        finally { if (process != IntPtr.Zero) CloseHandle(process); }
    }
    public static bool IsChildProcessWindow(IntPtr window, IntPtr parent)
    {
        if (!IsWindowHandle(window) || !IsWindowHandle(parent)) return false;
        uint pid, parentPid;
        GetWindowThreadProcessId(window, out pid);
        GetWindowThreadProcessId(parent, out parentPid);
        if (pid == 0 || parentPid == 0 || pid == parentPid) return false;
        IntPtr childProcess = OpenProcess(0x1000, false, pid);
        IntPtr parentProcess = OpenProcess(0x1000, false, parentPid);
        try
        {
            long childCreated, parentCreated, exited, kernel, user;
            // A PID alone may have been reused. The live parent must predate
            // the child and the kernel must name it as the direct parent.
            return childProcess != IntPtr.Zero && parentProcess != IntPtr.Zero &&
              ParentProcessId(childProcess) == parentPid &&
              GetProcessTimes(childProcess, out childCreated, out exited, out kernel, out user) &&
              GetProcessTimes(parentProcess, out parentCreated, out exited, out kernel, out user) &&
              childCreated >= parentCreated;
        }
        finally
        {
            if (childProcess != IntPtr.Zero) CloseHandle(childProcess);
            if (parentProcess != IntPtr.Zero) CloseHandle(parentProcess);
        }
    }
}
