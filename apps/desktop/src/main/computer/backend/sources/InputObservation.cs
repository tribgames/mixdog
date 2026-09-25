// Observation replies contain metadata only. Foreign-held bits remain solely
// in volatile ownership memory to protect user-held input during cleanup.
public sealed class MixInputLedger
{
    public long ForeignSequence { get; private set; }
    public uint LatestTick { get; private set; }
    public uint LastOwnTick { get; private set; }
    public bool LatestOwn { get; private set; }
    public MixInputLedger(uint initialTick) { LatestTick = initialTick; }
    public void Record(bool own, uint tick)
    {
        LatestTick = tick;
        LatestOwn = own;
        if (own) LastOwnTick = tick;
        else ForeignSequence++;
    }
    /// Input nobody typed (a reserved key Windows injects during activation)
    /// still moves the system's last-input clock, so the ledger keeps pace with
    /// it without counting it as someone else's input.
    public void RecordNeutral(uint tick)
    {
        LatestTick = tick;
    }
}

public sealed class MixInputSnapshot
{
    public bool Ready;
    public string Generation;
    public long Sequence;
    public bool LastOwn;
    public uint Tick;
    public uint OwnTick;
}

public static class MixInputObservation
{
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    static extern System.IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool CloseDesktop(System.IntPtr desktop);
    public static bool IdleDesktopReady()
    {
        System.IntPtr desktop = OpenInputDesktop(0, false, 1);
        if (desktop == System.IntPtr.Zero) return false;
        CloseDesktop(desktop);
        return true;
    }
    public static bool AnyInputHeld()
    {
        for (int key = 1; key < 256; key++)
        {
            if ((GetAsyncKeyState(key) & 0x8000) != 0) return true;
        }
        return false;
    }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct POINT { public int x; public int y; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct MOUSE { public POINT point; public uint data; public uint flags; public uint time; public System.IntPtr extra; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct KEY { public uint vk; public uint scan; public uint flags; public uint time; public System.IntPtr extra; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct MSG { public System.IntPtr hwnd; public uint message; public System.UIntPtr wp; public System.IntPtr lp; public uint time; public POINT point; public uint unused; }
    delegate System.IntPtr Hook(int code, System.IntPtr message, System.IntPtr data);
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    static extern System.IntPtr SetWindowsHookEx(int kind, Hook callback, System.IntPtr module, uint thread);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(System.IntPtr hook);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern System.IntPtr CallNextHookEx(System.IntPtr hook, int code, System.IntPtr message, System.IntPtr data);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern int GetMessage(out MSG message, System.IntPtr window, uint min, uint max);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool PeekMessage(out MSG message, System.IntPtr window, uint min, uint max, uint remove);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, System.UIntPtr wp, System.IntPtr lp);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern System.IntPtr GetModuleHandle(string name);
    static readonly object sync = new object();
    static readonly object reads = new object();
    static readonly System.Threading.ManualResetEvent started = new System.Threading.ManualResetEvent(false);
    static readonly string generation = System.Guid.NewGuid().ToString("N");
    static string MonitorName(string id) { return @"Local\MixdogInputObservation-" + id; }
    static readonly System.Threading.EventWaitHandle drained = new System.Threading.EventWaitHandle(
      false, System.Threading.EventResetMode.AutoReset, MonitorName(generation) + "-ready");
    static System.IO.MemoryMappedFiles.MemoryMappedFile receipt;
    static readonly Hook mouseHook = OnMouse;
    static readonly Hook keyHook = OnKey;
    static System.Threading.Thread thread;
    static uint threadId;
    static bool ready;
    static MixInputLedger ledger;
    [System.ThreadStatic] static long? actionSequence;
    [System.ThreadStatic] static int actionDepth;
    [System.ThreadStatic] public static System.Action DispatchAuthorization;
    public static readonly System.IntPtr Marker = CreateMarker();
    static System.IntPtr CreateMarker()
    {
        uint value;
        if (!uint.TryParse(System.Environment.GetEnvironmentVariable("MIXDOG_COMPUTER_INPUT_MARKER"), out value) || value == 0)
        {
            byte[] bytes = new byte[4];
            using (var random = System.Security.Cryptography.RandomNumberGenerator.Create()) random.GetBytes(bytes);
            value = System.BitConverter.ToUInt32(bytes, 0) & 0x7fffffff;
            if (value == 0) value = 1;
        }
        return new System.IntPtr(unchecked((int)value));
    }
    static void Record(bool injected, System.IntPtr marker, uint tick)
    {
        lock (sync) { if (ledger != null) ledger.Record(injected && marker == Marker, tick); }
    }
    static System.IntPtr OnMouse(int code, System.IntPtr message, System.IntPtr data)
    {
        if (code >= 0)
        {
            var value = (MOUSE)System.Runtime.InteropServices.Marshal.PtrToStructure(data, typeof(MOUSE));
            Record((value.flags & 1) != 0, value.extra, value.time);
            if (MixNativeInput.ObserveForeignOwnership && ((value.flags & 1) == 0 || value.extra != Marker))
            {
                long kind = message.ToInt64();
                int key = 0;
                if (kind == 0x201 || kind == 0x202) key = 1;
                else if (kind == 0x204 || kind == 0x205) key = 2;
                else if (kind == 0x207 || kind == 0x208) key = 4;
                if (key != 0) MixNativeInput.RecordForeignKey(key, kind == 0x201 || kind == 0x204 || kind == 0x207);
            }
        }
        return CallNextHookEx(System.IntPtr.Zero, code, message, data);
    }
    /// Virtual-key codes Windows reserves or leaves unassigned (winuser.h).
    public static bool IsUnassignedVirtualKey(uint vk)
    {
        return vk == 0x07 || vk == 0x0A || vk == 0x0B || vk == 0x5E
          || (vk >= 0x88 && vk <= 0x8F) || (vk >= 0x97 && vk <= 0x9F)
          || vk == 0xB8 || vk == 0xB9 || (vk >= 0xC1 && vk <= 0xDA)
          || vk == 0xE0 || vk == 0xE8 || vk == 0xFF;
    }
    static System.IntPtr OnKey(int code, System.IntPtr message, System.IntPtr data)
    {
        if (code >= 0)
        {
            var value = (KEY)System.Runtime.InteropServices.Marshal.PtrToStructure(data, typeof(KEY));
            bool injected = (value.flags & 0x10) != 0;
            // No keyboard can press a reserved or unassigned key. Windows injects
            // one (0xB9) while a packaged app takes the foreground, and counting
            // it as the user's input blocked every restore of the user's focus.
            if (injected && IsUnassignedVirtualKey(value.vk))
            {
                lock (sync) { if (ledger != null) ledger.RecordNeutral(value.time); }
                return CallNextHookEx(System.IntPtr.Zero, code, message, data);
            }
            Record(injected, value.extra, value.time);
            if (MixNativeInput.ObserveForeignOwnership && ((value.flags & 0x10) == 0 || value.extra != Marker))
            {
                MixNativeInput.RecordForeignKey((int)value.vk, (value.flags & 0x80) == 0);
            }
        }
        return CallNextHookEx(System.IntPtr.Zero, code, message, data);
    }
    static void Run()
    {
        System.IntPtr mouse = System.IntPtr.Zero, keyboard = System.IntPtr.Zero;
        try
        {
            threadId = GetCurrentThreadId();
            MSG initialMessage;
            PeekMessage(out initialMessage, System.IntPtr.Zero, 0, 0, 0);
            receipt = System.IO.MemoryMappedFiles.MemoryMappedFile.CreateNew(MonitorName(generation), 64);
            using (var view = receipt.CreateViewAccessor()) view.Write(24, threadId);
            long initialTick = MixWin32.InputTick();
            lock (sync) ledger = new MixInputLedger(unchecked((uint)initialTick));
            mouse = SetWindowsHookEx(14, mouseHook, GetModuleHandle(null), 0);
            keyboard = SetWindowsHookEx(13, keyHook, GetModuleHandle(null), 0);
            lock (sync) ready = initialTick >= 0 && mouse != System.IntPtr.Zero && keyboard != System.IntPtr.Zero;
            started.Set();
            MSG message;
            while (GetMessage(out message, System.IntPtr.Zero, 0, 0) > 0)
            {
                if (message.message == 0x8001)
                {
                    PublishSnapshot();
                    drained.Set();
                }
            }
        }
        finally
        {
            lock (sync) ready = false;
            if (receipt != null)
            {
                PublishSnapshot();
                receipt.Dispose();
            }
            drained.Set();
            started.Set();
            if (mouse != System.IntPtr.Zero) UnhookWindowsHookEx(mouse);
            if (keyboard != System.IntPtr.Zero) UnhookWindowsHookEx(keyboard);
        }
    }
    static void PublishSnapshot()
    {
        lock (sync)
        {
            long tick = MixWin32.InputTick();
            using (var view = receipt.CreateViewAccessor())
            {
                view.Write(0, ready && tick >= 0 && ledger != null && ledger.LatestTick == unchecked((uint)tick));
                view.Write(4, ledger != null && ledger.LatestOwn);
                view.Write(8, ledger == null ? 0L : ledger.ForeignSequence);
                view.Write(16, unchecked((uint)tick));
                view.Write(20, ledger == null ? 0u : ledger.LastOwnTick);
            }
        }
    }
    // A one-shot elevated sender must compare against the original resident
    // observer, not reinterpret its foreign sequence as a new local baseline.
    // Drain that observer's own message queue before reading its volatile receipt.
    static MixInputSnapshot ReadMonitor(string id)
    {
        var unavailable = new MixInputSnapshot { Generation = id, Ready = false };
        System.Guid parsed;
        if (!System.Guid.TryParseExact(id, "N", out parsed)) return unavailable;
        try
        {
            using (var mutex = new System.Threading.Mutex(false, MonitorName(id) + "-read"))
            using (var memory = System.IO.MemoryMappedFiles.MemoryMappedFile.OpenExisting(
              MonitorName(id), System.IO.MemoryMappedFiles.MemoryMappedFileRights.Read))
            using (var completed = System.Threading.EventWaitHandle.OpenExisting(MonitorName(id) + "-ready"))
            using (var view = memory.CreateViewAccessor(0, 64, System.IO.MemoryMappedFiles.MemoryMappedFileAccess.Read))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(1000); }
                catch (System.Threading.AbandonedMutexException) { acquired = true; }
                if (!acquired) return unavailable;
                try
                {
                    completed.Reset();
                    uint ownerThread = view.ReadUInt32(24);
                    if (!PostThreadMessage(ownerThread, 0x8001, System.UIntPtr.Zero, System.IntPtr.Zero)
                      || !completed.WaitOne(1000)) return unavailable;
                    long tick = MixWin32.InputTick();
                    return new MixInputSnapshot
                    {
                        Ready = view.ReadBoolean(0) && tick >= 0 && view.ReadUInt32(16) == unchecked((uint)tick),
                        Generation = id,
                        Sequence = view.ReadInt64(8),
                        LastOwn = view.ReadBoolean(4),
                        Tick = view.ReadUInt32(16),
                        OwnTick = view.ReadUInt32(20)
                    };
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch
        {
            // A missing, inaccessible or dead monitor is not permission to rebase.
            return unavailable;
        }
    }
    public static MixInputSnapshot Read()
    {
        lock (reads)
        {
            lock (sync)
            {
                if (thread == null)
                {
                    thread = new System.Threading.Thread(Run);
                    thread.IsBackground = true;
                    thread.Name = "Mixdog input observation";
                    thread.Start();
                }
            }
            if (!started.WaitOne(1000)) return new MixInputSnapshot { Generation = generation, Ready = false };
            return ReadMonitor(generation);
        }
    }
    public static void Begin()
    {
        if (actionDepth > 0) { AssertContinue(); actionDepth++; return; }
        var value = Read();
        if (!value.Ready) throw new System.Exception("input_observation_unavailable: input origin cannot be observed");
        actionSequence = value.Sequence;
        actionDepth = 1;
    }
    public static void BeginExpected(string expectedGeneration, long expectedSequence)
    {
        var value = Read();
        var expected = value.Generation == expectedGeneration ? value : ReadMonitor(expectedGeneration);
        if (!value.Ready || !expected.Ready)
        {
            throw new System.Exception("input_observation_unavailable: original observation is unavailable");
        }
        if (expected.Sequence != expectedSequence) throw new System.Exception("user_input_active: observation was superseded by external input");
        actionSequence = value.Sequence;
        actionDepth = 1;
        try { AssertContinue(); }
        catch { End(); throw; }
    }
    public static bool CanContinue()
    {
        var value = Read();
        return value.Ready && (!actionSequence.HasValue || value.Sequence == actionSequence.Value);
    }
    public static void AssertContinue()
    {
        if (DispatchAuthorization != null) DispatchAuthorization();
        var value = Read();
        if (!value.Ready) throw new System.Exception("input_observation_unavailable: input observation lost");
        if (actionSequence.HasValue && value.Sequence != actionSequence.Value)
        {
            throw new System.Exception("user_input_active: external input interrupted this action");
        }
    }
    public static void End()
    {
        actionDepth = System.Math.Max(0, actionDepth - 1);
        if (actionDepth == 0) actionSequence = null;
    }
}
