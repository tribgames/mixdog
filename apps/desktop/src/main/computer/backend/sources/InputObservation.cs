// Observation replies contain metadata only. Foreign-held bits remain solely
// in volatile ownership memory to protect user-held input during cleanup.
public sealed class MixInputLedger
{
    public long ForeignSequence { get; private set; }
    public uint LatestTick { get; private set; }
    public uint LastOwnTick { get; private set; }
    public bool LatestOwn { get; private set; }
    /// An unaccounted change of the system's last-input clock. It already
    /// counted once as foreign input and stays open until a confirmed quiet
    /// resync, even if a later own event happens to restore tick equality.
    public bool Gap { get; private set; }
    public const int QuietObservations = 3;
    public const long QuietMilliseconds = 300;
    int quietCount;
    uint quietTick;
    long quietStart;
    bool quietConfirmed;
    public MixInputLedger(uint initialTick) { LatestTick = initialTick; }
    public void Record(bool own, uint tick)
    {
        LatestTick = tick;
        LatestOwn = own;
        if (own) LastOwnTick = tick;
        else ForeignSequence++;
        ResetQuiet();
    }
    /// Input nobody typed (a reserved key Windows injects during activation)
    /// still moves the system's last-input clock, so the ledger keeps pace with
    /// it without counting it as someone else's input.
    public void RecordNeutral(uint tick)
    {
        LatestTick = tick;
        ResetQuiet();
    }
    /// Compares the system's last-input clock with the last accounted event.
    /// Ticks are only equal or unequal: they wrap and need not be monotonic.
    public bool Observe(uint systemTick)
    {
        if (!Gap && systemTick != LatestTick) Latch();
        return !Gap;
    }
    /// Counts an unaccounted discontinuity as foreign input, once per gap.
    public void Latch()
    {
        if (!Gap)
        {
            Gap = true;
            ForeignSequence++;
        }
        ResetQuiet();
    }
    void ResetQuiet()
    {
        quietCount = 0;
        quietConfirmed = false;
    }
    /// One recovery observation on a monotonic elapsed clock. True once the
    /// desktop was accessible, nothing was held and the clock stood still for
    /// enough observations spanning enough time.
    public bool ObserveQuiet(bool desktopReady, bool held, uint systemTick, long elapsedMs)
    {
        if (!Gap) return false;
        if (!desktopReady || held)
        {
            ResetQuiet();
            return false;
        }
        if (quietCount == 0 || systemTick != quietTick)
        {
            ResetQuiet();
            quietTick = systemTick;
            quietStart = elapsedMs;
            quietCount = 1;
            return false;
        }
        quietCount++;
        quietConfirmed = quietCount >= QuietObservations && elapsedMs - quietStart >= QuietMilliseconds;
        return quietConfirmed;
    }
    /// Closes a gap only after confirmed quiet, with the desktop, held state
    /// and clock rechecked. The sequence is never reset or lowered.
    public bool Resynchronize(bool desktopReady, bool held, uint systemTick)
    {
        if (!Gap) return true;
        if (!quietConfirmed || !desktopReady || held || systemTick != quietTick)
        {
            ResetQuiet();
            return false;
        }
        LatestTick = systemTick;
        Gap = false;
        ResetQuiet();
        return true;
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
    /// Metadata-only cause when not Ready: hooks_unavailable, input_gap or monitor_unresponsive.
    public string Reason = "";
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
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern System.UIntPtr SetTimer(System.IntPtr window, System.UIntPtr id, uint elapse, System.IntPtr callback);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool KillTimer(System.IntPtr window, System.UIntPtr id);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern System.IntPtr GetModuleHandle(string name);
    static readonly object sync = new object();
    static readonly object reads = new object();
    static string MonitorName(string id) { return @"Local\MixdogInputObservation-" + id; }
    // Receipt reason codes; only these names ever leave the observer.
    const int ReasonNone = 0, ReasonHooks = 1, ReasonGap = 2, ReasonUnresponsive = 3;
    static string ReasonName(int code)
    {
        if (code == ReasonHooks) return "hooks_unavailable";
        if (code == ReasonUnresponsive) return "monitor_unresponsive";
        return "input_gap";
    }
    const uint DrainMessage = 0x8001, TimerMessage = 0x113;
    const uint RecoveryIntervalMs = 50;
    /// One observer thread and its shared receipt. A replacement after the
    /// thread dies gets a fresh generation, so nothing authorized against the
    /// dead observer is ever accepted by its successor.
    sealed class ObserverRun
    {
        public readonly string Generation = System.Guid.NewGuid().ToString("N");
        public readonly System.Threading.ManualResetEvent Started = new System.Threading.ManualResetEvent(false);
        public readonly System.Threading.EventWaitHandle Drained;
        public System.IO.MemoryMappedFiles.MemoryMappedFile Receipt;
        public System.Threading.Thread Thread;
        public ObserverRun()
        {
            Drained = new System.Threading.EventWaitHandle(
              false, System.Threading.EventResetMode.AutoReset, MonitorName(Generation) + "-ready");
        }
    }
    static ObserverRun current;
    static readonly Hook mouseHook = OnMouse;
    static readonly Hook keyHook = OnKey;
    static uint threadId;
    static bool alive;
    static bool hooked;
    static System.IntPtr mouseHandle, keyboardHandle;
    static MixInputLedger ledger;
    [System.ThreadStatic] static long? actionSequence;
    [System.ThreadStatic] static string actionGeneration;
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
    static void RemoveHooks()
    {
        System.IntPtr mouse, keyboard;
        lock (sync)
        {
            mouse = mouseHandle;
            keyboard = keyboardHandle;
            mouseHandle = System.IntPtr.Zero;
            keyboardHandle = System.IntPtr.Zero;
            hooked = false;
        }
        if (mouse != System.IntPtr.Zero) UnhookWindowsHookEx(mouse);
        if (keyboard != System.IntPtr.Zero) UnhookWindowsHookEx(keyboard);
    }
    /// (Re)installs both low-level hooks on the observer's own thread. Input
    /// between removal and installation is unaccounted, so every reinstall
    /// opens a gap that only a confirmed quiet resync closes.
    static void InstallHooks(bool initial)
    {
        RemoveHooks();
        System.IntPtr module = GetModuleHandle(null);
        System.IntPtr mouse = SetWindowsHookEx(14, mouseHook, module, 0);
        System.IntPtr keyboard = SetWindowsHookEx(13, keyHook, module, 0);
        lock (sync)
        {
            mouseHandle = mouse;
            keyboardHandle = keyboard;
            hooked = mouse != System.IntPtr.Zero && keyboard != System.IntPtr.Zero;
            if (!initial && ledger != null) ledger.Latch();
        }
        bool installed;
        lock (sync) installed = hooked;
        if (!installed) RemoveHooks();
    }
    static void Run(object state)
    {
        var run = (ObserverRun)state;
        System.UIntPtr timer = System.UIntPtr.Zero;
        bool reinstalledForGap = false;
        try
        {
            lock (sync) threadId = GetCurrentThreadId();
            MSG initialMessage;
            PeekMessage(out initialMessage, System.IntPtr.Zero, 0, 0, 0);
            run.Receipt = System.IO.MemoryMappedFiles.MemoryMappedFile.CreateNew(MonitorName(run.Generation), 64);
            using (var view = run.Receipt.CreateViewAccessor()) view.Write(24, threadId);
            long initialTick = MixWin32.InputTick();
            lock (sync)
            {
                ledger = new MixInputLedger(unchecked((uint)initialTick));
                if (initialTick < 0) ledger.Latch();
                alive = true;
            }
            InstallHooks(true);
            var clock = System.Diagnostics.Stopwatch.StartNew();
            run.Started.Set();
            MSG message;
            while (GetMessage(out message, System.IntPtr.Zero, 0, 0) > 0)
            {
                bool timerTick = message.message == TimerMessage && message.hwnd == System.IntPtr.Zero && message.wp == timer;
                if (message.message == DrainMessage)
                {
                    PublishSnapshot(run);
                    run.Drained.Set();
                }
                bool gap, installed;
                lock (sync)
                {
                    gap = ledger.Gap;
                    installed = hooked;
                }
                if (!gap) reinstalledForGap = false;
                if (!installed || (gap && !reinstalledForGap))
                {
                    // Windows may stop calling a hook without telling its owner,
                    // so an unaccounted gap always gets fresh hooks.
                    InstallHooks(false);
                    reinstalledForGap = true;
                    lock (sync)
                    {
                        gap = ledger.Gap;
                        installed = hooked;
                    }
                }
                else if (gap && timerTick) ConfirmQuiet(clock);
                lock (sync) gap = ledger.Gap || !hooked;
                if (gap && timer == System.UIntPtr.Zero) timer = SetTimer(System.IntPtr.Zero, System.UIntPtr.Zero, RecoveryIntervalMs, System.IntPtr.Zero);
                else if (!gap && timer != System.UIntPtr.Zero)
                {
                    KillTimer(System.IntPtr.Zero, timer);
                    timer = System.UIntPtr.Zero;
                }
            }
        }
        finally
        {
            if (timer != System.UIntPtr.Zero) KillTimer(System.IntPtr.Zero, timer);
            lock (sync) alive = false;
            if (run.Receipt != null)
            {
                PublishSnapshot(run);
                run.Receipt.Dispose();
            }
            run.Drained.Set();
            run.Started.Set();
            RemoveHooks();
        }
    }
    /// One recovery observation. GetAsyncKeyState reads zero when the input
    /// desktop is inaccessible, so held state only counts on a ready desktop;
    /// both are rechecked around the resync with the clock compared inside it.
    static void ConfirmQuiet(System.Diagnostics.Stopwatch clock)
    {
        bool desktop = IdleDesktopReady();
        bool held = AnyInputHeld();
        long tick = MixWin32.InputTick();
        bool quiet;
        lock (sync) quiet = ledger.ObserveQuiet(desktop && tick >= 0, held, unchecked((uint)tick), clock.ElapsedMilliseconds);
        if (!quiet) return;
        desktop = IdleDesktopReady();
        held = AnyInputHeld();
        bool resynced;
        lock (sync)
        {
            long now = MixWin32.InputTick();
            resynced = ledger.Resynchronize(desktop && now >= 0, held, unchecked((uint)now));
        }
        if (!resynced) return;
        desktop = IdleDesktopReady();
        held = AnyInputHeld();
        lock (sync)
        {
            long now = MixWin32.InputTick();
            if (!desktop || held || now < 0 || unchecked((uint)now) != ledger.LatestTick) ledger.Latch();
        }
    }
    static void PublishSnapshot(ObserverRun run)
    {
        long tick = MixWin32.InputTick();
        bool matches;
        lock (sync) matches = ledger == null || ledger.Gap || (tick >= 0 && ledger.LatestTick == unchecked((uint)tick));
        if (!matches)
        {
            // Hook callbacks for input the clock already shows may still be
            // pending as sent messages; deliver them before judging a gap.
            MSG pending;
            PeekMessage(out pending, System.IntPtr.Zero, 0, 0, 0);
            tick = MixWin32.InputTick();
        }
        lock (sync)
        {
            if (ledger != null)
            {
                if (tick < 0) ledger.Latch();
                else ledger.Observe(unchecked((uint)tick));
            }
            int reason = ReasonNone;
            if (!alive) reason = ReasonUnresponsive;
            else if (!hooked) reason = ReasonHooks;
            else if (ledger == null || ledger.Gap) reason = ReasonGap;
            using (var view = run.Receipt.CreateViewAccessor())
            {
                view.Write(0, reason == ReasonNone);
                view.Write(4, ledger != null && ledger.LatestOwn);
                view.Write(8, ledger == null ? 0L : ledger.ForeignSequence);
                view.Write(16, unchecked((uint)tick));
                view.Write(20, ledger == null ? 0u : ledger.LastOwnTick);
                view.Write(28, reason);
            }
        }
    }
    // A one-shot elevated sender must compare against the original resident
    // observer, not reinterpret its foreign sequence as a new local baseline.
    // Drain that observer's own message queue before reading its volatile receipt.
    static MixInputSnapshot ReadMonitor(string id)
    {
        var unavailable = new MixInputSnapshot { Generation = id, Ready = false, Reason = ReasonName(ReasonUnresponsive) };
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
                    uint ownerThread = view.ReadUInt32(24);
                    for (int attempt = 1; ; attempt++)
                    {
                        completed.Reset();
                        if (!PostThreadMessage(ownerThread, DrainMessage, System.UIntPtr.Zero, System.IntPtr.Zero)
                          || !completed.WaitOne(1000)) return unavailable;
                        long tick = MixWin32.InputTick();
                        bool current = tick >= 0 && view.ReadUInt32(16) == unchecked((uint)tick);
                        // Input after the receipt is judged by the observer itself on
                        // the next drain, which latches it as a gap if its hooks missed it.
                        if (!current && attempt < 3) continue;
                        int reason = view.ReadInt32(28);
                        bool ready = view.ReadBoolean(0) && reason == ReasonNone && current;
                        int failure = current ? reason : ReasonGap;
                        return new MixInputSnapshot
                        {
                            Ready = ready,
                            Reason = ready ? "" : ReasonName(failure),
                            Generation = id,
                            Sequence = view.ReadInt64(8),
                            LastOwn = view.ReadBoolean(4),
                            Tick = view.ReadUInt32(16),
                            OwnTick = view.ReadUInt32(20)
                        };
                    }
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
            ObserverRun run;
            lock (sync)
            {
                if (current == null || !current.Thread.IsAlive)
                {
                    run = new ObserverRun();
                    run.Thread = new System.Threading.Thread(Run);
                    run.Thread.IsBackground = true;
                    run.Thread.Name = "Mixdog input observation";
                    current = run;
                    run.Thread.Start(run);
                }
                run = current;
            }
            if (!run.Started.WaitOne(1000))
            {
                return new MixInputSnapshot { Generation = run.Generation, Ready = false, Reason = ReasonName(ReasonUnresponsive) };
            }
            return ReadMonitor(run.Generation);
        }
    }
    public static void Begin()
    {
        if (actionDepth > 0) { AssertContinue(); actionDepth++; return; }
        var value = Read();
        if (!value.Ready) throw new System.Exception("input_observation_unavailable: input origin cannot be observed (" + value.Reason + ")");
        actionSequence = value.Sequence;
        actionGeneration = value.Generation;
        actionDepth = 1;
    }
    public static void BeginExpected(string expectedGeneration, long expectedSequence)
    {
        var value = Read();
        var expected = value.Generation == expectedGeneration ? value : ReadMonitor(expectedGeneration);
        if (!value.Ready || !expected.Ready)
        {
            throw new System.Exception("input_observation_unavailable: original observation is unavailable ("
              + (value.Ready ? expected.Reason : value.Reason) + ")");
        }
        if (expected.Sequence != expectedSequence) throw new System.Exception("user_input_active: observation was superseded by external input");
        actionSequence = value.Sequence;
        actionGeneration = value.Generation;
        actionDepth = 1;
        try { AssertContinue(); }
        catch { End(); throw; }
    }
    public static void AssertContinue()
    {
        if (DispatchAuthorization != null) DispatchAuthorization();
        var value = Read();
        if (!value.Ready) throw new System.Exception("input_observation_unavailable: input observation lost (" + value.Reason + ")");
        if (actionSequence.HasValue && value.Generation != actionGeneration)
        {
            throw new System.Exception("input_observation_unavailable: input observation was replaced during this action");
        }
        if (actionSequence.HasValue && value.Sequence != actionSequence.Value)
        {
            throw new System.Exception("user_input_active: external input interrupted this action");
        }
    }
    public static void End()
    {
        actionDepth = System.Math.Max(0, actionDepth - 1);
        if (actionDepth == 0)
        {
            actionSequence = null;
            actionGeneration = null;
        }
    }
}
