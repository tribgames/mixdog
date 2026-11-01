/// The system-wide foreground lock held around one background delivery. A
/// target that activates itself does so from its own process, often after the
/// accessibility call has returned (a Chromium renderer acts on it
/// asynchronously), and the no-activate style does not stop an explicit
/// SetForegroundWindow. While the lock is held every SetForegroundWindow call
/// fails, so the steal never happens and the user's keystrokes stay in their
/// window. It also refuses every other app's programmatic foreground change, so
/// it ends at a deadline counted from acquisition on a timer thread, however
/// long the delivery itself blocks. The lock belongs to the process, not the
/// thread, so the timer may release it. Windows also lifts it on the user's Alt
/// key or click.
public static class MixForegroundLock
{
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool LockSetForegroundWindow(uint code);
    const uint LSFW_LOCK = 1, LSFW_UNLOCK = 2;
    /// The native call; replaced only by tests that must not touch the real lock.
    internal static System.Func<uint, bool> Native = LockSetForegroundWindow;
    static readonly object sync = new object();
    static System.Threading.Timer deadline;
    static long generation;
    static bool held;
    /// False when this process may not change the foreground, another process
    /// holds the lock, or this one already does; the caller's watch and restore
    /// are then the only protection.
    public static bool Acquire(int holdMs)
    {
        lock (sync)
        {
            if (held || !Native(LSFW_LOCK)) return false;
            held = true;
            long acquired = ++generation;
            deadline = new System.Threading.Timer(
              delegate { Expire(acquired); }, null, System.Math.Max(0, holdMs), System.Threading.Timeout.Infinite);
            return true;
        }
    }
    public static bool Held { get { lock (sync) { return held; } } }
    /// Ends the hold once; any later call, the deadline's included, does nothing.
    public static void Release()
    {
        lock (sync) { ReleaseHeld(); }
    }
    // A deadline that fires after its own hold ended, or after a newer hold
    // began, must not end the newer one.
    static void Expire(long acquired)
    {
        lock (sync)
        {
            if (acquired == generation) ReleaseHeld();
        }
    }
    static void ReleaseHeld()
    {
        if (!held) return;
        held = false;
        if (deadline != null)
        {
            deadline.Dispose();
            deadline = null;
        }
        Native(LSFW_UNLOCK);
    }
}
