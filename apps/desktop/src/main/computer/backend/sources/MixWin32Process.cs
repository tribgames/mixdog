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
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [StructLayout(LayoutKind.Sequential)]
    struct WINTRUST_FILE_INFO
    {
        public uint cbStruct;
        [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
        public IntPtr hFile;
        public IntPtr pgKnownSubject;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct WINTRUST_DATA
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData;
        public IntPtr pSIPClientData;
        public uint dwUIChoice;
        public uint fdwRevocationChecks;
        public uint dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData;
        public IntPtr pwszURLReference;
        public uint dwProvFlags;
        public uint dwUIContext;
        public IntPtr pSignatureSettings;
    }
    [DllImport("wintrust.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = false)]
    static extern uint WinVerifyTrust(IntPtr hwnd, ref Guid actionId, IntPtr data);
    static readonly Guid WINTRUST_ACTION_GENERIC_VERIFY_V2 =
      new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
    /// The WinVerifyTrust provider flags a saved-login browser check uses: no
    /// revocation pass and no network retrieval at all (cache only), so the check
    /// never waits on the network; a chain that cannot be built offline fails.
    public const uint SavedLoginTrustFlags = 0x00000010 | 0x00001000; // WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL
    /// WinVerifyTrust over the open file's embedded Authenticode signature: the
    /// hash must match and the signer chain to a trusted root. Done in C#
    /// because the resident worker's runspace cannot load the
    /// Microsoft.PowerShell.Security module. Anything but ERROR_SUCCESS is false.
    static bool VerifyAuthenticode(string path, IntPtr file)
    {
        WINTRUST_FILE_INFO fileInfo = new WINTRUST_FILE_INFO();
        fileInfo.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO));
        fileInfo.pcwszFilePath = path;
        fileInfo.hFile = file;
        IntPtr fileInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
        IntPtr dataPtr = IntPtr.Zero;
        bool fileInfoMarshaled = false;
        bool dataMarshaled = false;
        try
        {
            Marshal.StructureToPtr(fileInfo, fileInfoPtr, false);
            fileInfoMarshaled = true;
            WINTRUST_DATA data = new WINTRUST_DATA();
            data.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA));
            data.dwUIChoice = 2;           // WTD_UI_NONE
            data.fdwRevocationChecks = 0;  // WTD_REVOKE_NONE
            data.dwUnionChoice = 1;        // WTD_CHOICE_FILE
            data.pFile = fileInfoPtr;
            data.dwStateAction = 1;        // WTD_STATEACTION_VERIFY
            data.dwProvFlags = SavedLoginTrustFlags;
            dataPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_DATA)));
            Marshal.StructureToPtr(data, dataPtr, false);
            dataMarshaled = true;
            Guid action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
            uint result = WinVerifyTrust(IntPtr.Zero, ref action, dataPtr);
            // Release the verification state whatever the outcome.
            data = (WINTRUST_DATA)Marshal.PtrToStructure(dataPtr, typeof(WINTRUST_DATA));
            data.dwStateAction = 2;        // WTD_STATEACTION_CLOSE
            Marshal.StructureToPtr(data, dataPtr, false);
            WinVerifyTrust(IntPtr.Zero, ref action, dataPtr);
            return result == 0;            // ERROR_SUCCESS: signed, hash matched, chain trusted
        }
        catch { return false; }
        finally
        {
            // Free what StructureToPtr allocated inside each block (the path
            // string) before the blocks themselves.
            if (dataMarshaled) Marshal.DestroyStructure(dataPtr, typeof(WINTRUST_DATA));
            if (dataPtr != IntPtr.Zero) Marshal.FreeHGlobal(dataPtr);
            if (fileInfoMarshaled) Marshal.DestroyStructure(fileInfoPtr, typeof(WINTRUST_FILE_INFO));
            Marshal.FreeHGlobal(fileInfoPtr);
        }
    }
    /// The result of VerifiedProcessImage: the signer subject of the live
    /// process's own image and that process's creation time; both empty/0 when
    /// anything could not be proven.
    public sealed class VerifiedImage
    {
        public string Publisher = "";
        public string Path = "";
        public long StartTime;
    }
    /// Verifies the image of the live process `pid`, bound to that process: the
    /// process handle stays open throughout (its id cannot be reused meanwhile),
    /// the path is the kernel's for that handle, the file is held open with
    /// writes denied while WinVerifyTrust checks it through that handle, and the
    /// process must still be running afterwards. Nothing is cached: every call
    /// verifies afresh. The caller binds later reads to the same process by its
    /// creation time (ProcessStartTime).
    public static VerifiedImage VerifiedProcessImage(uint pid)
    {
        VerifiedImage verified = new VerifiedImage();
        if (pid == 0) return verified;
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return verified;
        try
        {
            long created, exited, kernel, user;
            if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || created == 0) return verified;
            StringBuilder buffer = new StringBuilder(1024);
            uint size = (uint)buffer.Capacity;
            if (!QueryFullProcessImageNameW(process, 0, buffer, ref size)) return verified;
            string path = buffer.ToString();
            using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (!VerifyAuthenticode(path, file.SafeFileHandle.DangerousGetHandle())) return verified;
                string subject = System.Security.Cryptography.X509Certificates.X509Certificate.CreateFromSignedFile(path).Subject;
                uint code;
                if (String.IsNullOrEmpty(subject) || !GetExitCodeProcess(process, out code) || code != 259) return verified; // STILL_ACTIVE
                verified.Publisher = subject;
                verified.Path = path;
                verified.StartTime = created;
            }
        }
        catch { return new VerifiedImage(); }
        finally { CloseHandle(process); }
        return verified;
    }
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    /// Whether the process `pid` created at `expectedCreated` (0: whichever
    /// process has that id now) has ended, proven by the OS: 2 = ended, 1 =
    /// running, 0 = unknown (never read as ended). Ended means: no process has
    /// that id (OpenProcess fails with ERROR_INVALID_PARAMETER, measured for an
    /// exited process), the id now names a process created at another time
    /// (an id is unique among live processes), or the process object is
    /// signaled (WaitForSingleObject: a process handle signals on exit).
    /// `created` is the creation time read, or 0.
    public static int ProcessFate(uint pid, long expectedCreated, out long created)
    {
        created = 0;
        if (pid == 0) return 0;
        IntPtr process = OpenProcess(0x1000 | 0x00100000, false, pid); // QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        if (process == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? 2 : 0;
        try
        {
            long exited, kernel, user;
            if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || created == 0)
            {
                created = 0;
                return 0;
            }
            if (expectedCreated != 0 && created != expectedCreated) return 2;
            uint wait = WaitForSingleObject(process, 0);
            if (wait == 0) return 2; // WAIT_OBJECT_0
            return wait == 258 ? 1 : 0; // WAIT_TIMEOUT
        }
        finally { CloseHandle(process); }
    }
    /// The creation time of the live process `pid`, or 0: the same id with
    /// another creation time is another process.
    public static long ProcessStartTime(uint pid)
    {
        if (pid == 0) return 0;
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return 0;
        try
        {
            long created, exited, kernel, user;
            uint code;
            if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) return 0;
            return GetExitCodeProcess(process, out code) && code == 259 ? created : 0;
        }
        finally { CloseHandle(process); }
    }
}