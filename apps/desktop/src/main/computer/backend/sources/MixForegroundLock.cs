/// Milliseconds on QueryPerformanceCounter, the clock the bridge host's lease
/// thread reads too (foreground-lease-thread.cjs), so a lease deadline and the
/// timestamps of both sides compare across the two processes.
public static class MixLeaseClock
{
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern bool QueryPerformanceCounter(out long count);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern bool QueryPerformanceFrequency(out long frequency);
    static readonly double ticksPerMs = Frequency() / 1000.0;
    static long Frequency()
    {
        long frequency;
        QueryPerformanceFrequency(out frequency);
        return frequency;
    }
    public static double Now()
    {
        long count;
        QueryPerformanceCounter(out count);
        return count / ticksPerMs;
    }
    public static double Round(double value) { return System.Math.Round(value, 1); }
}

/// The system-wide foreground lock held around one background delivery, a
/// best-effort guard. A target that activates itself does so from its own
/// process, often after the accessibility call has returned (a Chromium
/// renderer acts on it asynchronously), and the no-activate style does not
/// stop an explicit SetForegroundWindow. While the lock is held those calls
/// fail, so the steal does not happen and the user's keystrokes stay in their
/// window. It also refuses every other app's programmatic foreground change, so
/// every hold ends at a deadline counted from acquisition, whatever the
/// delivery does. Windows lifts it early on the user's Alt key or click.
///
/// Windows lets only a process that may set the foreground take the lock, and
/// a pooled worker usually may not: a right it inherited or was granted ends
/// with the next input that is not its own. When this worker is refused, it
/// asks the bridge host for a lease (foreground-lock-host.ts): the host's lease
/// thread takes the lock, which the foreground process may, and ends it at the
/// lease's deadline.
public static class MixForegroundLock
{
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    static extern bool LockSetForegroundWindow(uint code);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern System.IntPtr GetForegroundWindow();
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(System.IntPtr window, out uint process);
    const uint LSFW_LOCK = 1, LSFW_UNLOCK = 2;
    /// Unlock attempts of one release of this worker's own lock, 10 ms apart.
    const int UnlockAttempts = 3;
    /// The native call; replaced only by tests that must not touch the real lock.
    internal static System.Func<uint, bool> Native = LockSetForegroundWindow;
    /// The bridge host's lease channel; null when the host offers none.
    /// Replaced by tests.
    internal static IMixLeaseChannel Host = MixForegroundLockHost.FromEnvironment();
    /// What the last Acquire found and how its hold went: who held the lock,
    /// why the others did not, and the timestamps of each step.
    public static System.Collections.Hashtable LastFacts;
    static readonly object sync = new object();
    static System.Threading.Timer deadline;
    static long generation, asks;
    // worker: this process's own lock; host: a lease the host granted, or may
    // have granted after this worker stopped waiting. Open until released.
    static string holder = "none";
    static bool open;
    static long action, seq, lease;
    static double deadlineAt;
    static string outcome = "none";
    static uint ForegroundPid()
    {
        uint process;
        GetWindowThreadProcessId(GetForegroundWindow(), out process);
        return process;
    }
    static double Stamp(string name)
    {
        double now = MixLeaseClock.Now();
        if (LastFacts != null) LastFacts[name] = MixLeaseClock.Round(now);
        return now;
    }
    /// True while this delivery holds the lock: this worker's own, or the
    /// host's lease, which is accepted only when its answer names this
    /// request and arrives before the lease's deadline. False when neither may
    /// change the foreground, another process holds it, or the host did not
    /// answer in time; the caller's watch and restore are then the only
    /// protection. `requestAction` is the request being served, which the host
    /// checks against the worker's in-flight requests.
    public static bool Acquire(int holdMs, long requestAction)
    {
        lock (sync)
        {
            // This worker's own lock whose unlock call threw is retried first,
            // its account going to the request that held it.
            bool stale = open && holder == "worker";
            if (stale)
            {
                EndOwn("retry");
                stale = open;
            }
            string staleOutcome = outcome;
            var facts = new System.Collections.Hashtable();
            LastFacts = facts;
            facts["worker_pid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
            facts["foreground_pid"] = ForegroundPid();
            facts["hold_ms"] = holdMs;
            Stamp("requested_at");
            // Lines these timestamps up with wall-clock evidence, such as the
            // live harness's foreground samples and typed keys.
            facts["requested_epoch_ms"] = System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            facts["holder"] = "none";
            if (open && !stale)
            {
                facts["worker_error"] = "already_held";
                return false;
            }
            bool own = Native(LSFW_LOCK);
            if (stale)
            {
                facts["stale_release"] = staleOutcome;
                // The unlock call threw again, so this worker may still hold its
                // own lock, which would refuse a host lease too: nothing new
                // starts. A lock granted now proves the old one gone, since
                // Windows grants none while one is held.
                if (!own)
                {
                    facts["worker_error"] = "already_held";
                    return false;
                }
                facts["stale_resolved"] = "own_lock";
                deadline.Dispose();
                deadline = null;
                open = false;
            }
            holder = "none";
            outcome = "none";
            action = requestAction;
            seq = 0;
            lease = 0;
            if (own)
            {
                double at = Stamp("acquired_at");
                holder = "worker";
                open = true;
                deadlineAt = at + holdMs;
                facts["holder"] = "worker";
                facts["deadline_at"] = MixLeaseClock.Round(deadlineAt);
                long acquired = ++generation;
                deadline = new System.Threading.Timer(
                  delegate { Expire(acquired); }, null, System.Math.Max(0, holdMs), System.Threading.Timeout.Infinite);
                return true;
            }
            facts["worker_error"] = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
            if (Host == null)
            {
                facts["host_answer"] = "not_offered";
                return false;
            }
            if (requestAction <= 0)
            {
                facts["host_answer"] = "no_request";
                return false;
            }
            seq = ++asks;
            double answerBy = MixLeaseClock.Now() + MixForegroundLockHost.AnswerTimeoutMs;
            facts["seq"] = seq;
            facts["answer_by"] = MixLeaseClock.Round(answerBy);
            MixLeaseAnswer answer = Host.Acquire(action, seq, holdMs, answerBy);
            Stamp("answered_at");
            if (answer == null)
            {
                // The host may take the lock after this wait; its deadline ends
                // it, and Release asks the host to end it sooner.
                facts["host_answer"] = "no_answer";
                holder = "host";
                open = true;
                return false;
            }
            facts["host_answer"] = answer.Answer;
            facts["lease"] = answer.Lease;
            if (answer.Answer != "locked" || answer.Lease <= 0) return false;
            holder = "host";
            open = true;
            lease = answer.Lease;
            deadlineAt = answer.DeadlineAt;
            facts["deadline_at"] = MixLeaseClock.Round(deadlineAt);
            if (MixLeaseClock.Now() >= deadlineAt)
            {
                facts["host_answer"] = "expired_on_arrival";
                return false;
            }
            facts["holder"] = "host";
            return true;
        }
    }
    public static bool Held
    {
        get
        {
            lock (sync)
            {
                if (!open) return false;
                // Protection lasts to the deadline; an own lock still open after
                // it is only an unlock left to retry.
                return (holder == "worker" || lease > 0) && MixLeaseClock.Now() < deadlineAt;
            }
        }
    }
    /// Records when the delivery itself started or returned, for the facts.
    public static void Mark(string name)
    {
        lock (sync) { Stamp(name); }
    }
    public static void Note(string name, object value)
    {
        lock (sync) { if (LastFacts != null) LastFacts[name] = value; }
    }
    /// Ends the hold once and says how it ended: released; failed, when the
    /// unlock call itself failed; unknown, when the unlock answered false, so
    /// no lock is held any more (Windows lifted it already); no_ack, when the
    /// host did not answer in time and may still hold its lease; none, when
    /// nothing was held. This worker's own lock stays open
    /// only after an unlock call that threw, and each later call retries it;
    /// otherwise a later call returns the same.
    public static string Release()
    {
        lock (sync)
        {
            if (!open) return outcome;
            if (holder == "worker")
            {
                EndOwn("worker");
                return outcome;
            }
            open = false;
            Stamp("release_requested_at");
            string answered = Host.Release(action, seq, lease);
            outcome = answered == null ? "no_ack" : answered;
            Stamp("released_at");
            LastFacts["release"] = outcome;
            if (answered == null) LastFacts["release_answer"] = "no_answer";
            return outcome;
        }
    }
    // A deadline that fires after its own hold ended, or after a newer hold
    // began, must not end the newer one.
    static void Expire(long acquired)
    {
        lock (sync)
        {
            if (acquired == generation && open && holder == "worker") EndOwn("deadline");
        }
    }
    // A false unlock says this process no longer holds the lock, which may be
    // Windows having lifted it on the user's Alt key or click: the hold is
    // over, though no proof it ended here, so it is reported unknown. Only an
    // unlock call that throws leaves the hold open; Release, the deadline and
    // the next Acquire retry it. Nothing retries once the worker exits: the
    // lock belonged to its process, and the user's Alt key or click lifts
    // anything left.
    static void EndOwn(string by)
    {
        Stamp("unlock_requested_at");
        outcome = "unknown";
        bool threw = false;
        int attempts = 0;
        // GetLastError of each attempt: 0 for the one that unlocked, "threw"
        // for a call that failed outright.
        var errors = new System.Collections.ArrayList();
        while (attempts < UnlockAttempts)
        {
            if (attempts++ > 0) System.Threading.Thread.Sleep(10);
            try
            {
                threw = false;
                if (Native(LSFW_UNLOCK))
                {
                    outcome = "released";
                    errors.Add(0);
                    break;
                }
                errors.Add(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            }
            catch
            {
                threw = true;
                errors.Add("threw");
            }
        }
        if (outcome != "released" && threw) outcome = "failed";
        if (outcome != "failed")
        {
            open = false;
            deadline.Dispose();
            deadline = null;
        }
        double ended = Stamp("ended_at");
        if (LastFacts != null)
        {
            LastFacts["release"] = outcome;
            LastFacts["released_by"] = by;
            LastFacts["unlock_attempts"] = attempts;
            LastFacts["unlock_errors"] = errors.ToArray();
            LastFacts["late_ms"] = MixLeaseClock.Round(ended - deadlineAt);
        }
    }
}

public sealed class MixLeaseAnswer
{
    public string Answer;
    public long Lease;
    public double DeadlineAt;
}

/// The bridge host's lease, as the worker asks for it.
public interface IMixLeaseChannel
{
    /// The host's answer to this request, or null when no answer naming it
    /// arrived before `answerBy`.
    MixLeaseAnswer Acquire(long action, long seq, int holdMs, double answerBy);
    /// How the host ended the lease (released, failed, unknown or none), or
    /// null when no answer naming it arrived in time.
    string Release(long action, long seq, long lease);
}

/// The worker's side of the bridge host's lease: a request line on stdout,
/// which the host reads like pointer progress, answered on this worker's stdin
/// (MixWorkerInput). Only the process that started the worker holds the write
/// end of that pipe, so no other process can answer, and an answer counts
/// only when it names the request waiting (its action and sequence, and for a
/// release the lease). Anything else is dropped.
public sealed class MixForegroundLockHost : IMixLeaseChannel
{
    public const string LinePrefix = "@@MIXDOG_FGLOCK@@";
    public const string ReplyPrefix = "@@MIXDOG_FGLOCK_REPLY@@";
    public const int AnswerTimeoutMs = 250;
    sealed class Waiter
    {
        public string Kind;
        public long Action, Seq, Lease;
        public string[] Reply;
        public readonly System.Threading.ManualResetEvent Done = new System.Threading.ManualResetEvent(false);
    }
    static readonly object sync = new object();
    static Waiter waiting;
    static bool inputEnded;
    public static IMixLeaseChannel FromEnvironment()
    {
        if (System.Environment.GetEnvironmentVariable("MIXDOG_COMPUTER_HOST_FOREGROUND_LOCK") != "1") return null;
        return new MixForegroundLockHost();
    }
    static bool TryId(string text, out long value)
    {
        return long.TryParse(text, System.Globalization.NumberStyles.None,
          System.Globalization.CultureInfo.InvariantCulture, out value);
    }
    /// One answer line from the input reader, without its prefix: "ack action
    /// seq lease answer deadline" or "released action seq lease outcome".
    /// Never throws.
    public static void Receive(string body)
    {
        try
        {
            string[] parts = body.Split(' ');
            long answeredAction, answeredSeq, answeredLease;
            if (parts.Length < 5 || !TryId(parts[1], out answeredAction) || !TryId(parts[2], out answeredSeq) ||
              !TryId(parts[3], out answeredLease)) return;
            lock (sync)
            {
                Waiter waiter = waiting;
                if (waiter == null || waiter.Reply != null || waiter.Kind != parts[0] ||
                  waiter.Action != answeredAction || waiter.Seq != answeredSeq) return;
                if (waiter.Kind == "released" && waiter.Lease != 0 && waiter.Lease != answeredLease) return;
                waiter.Reply = parts;
                waiter.Done.Set();
            }
        }
        catch { }
    }
    /// Stdin closed: nothing can answer any more.
    public static void InputEnded()
    {
        lock (sync)
        {
            inputEnded = true;
            if (waiting != null) waiting.Done.Set();
        }
    }
    public MixLeaseAnswer Acquire(long action, long seq, int holdMs, double answerBy)
    {
        string[] reply = Ask("ack", action, seq, 0,
          "{\"op\":\"acquire\",\"action\":" + action + ",\"seq\":" + seq + ",\"hold_ms\":" + holdMs +
          ",\"answer_by\":" + answerBy.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + "}",
          answerBy);
        long answeredLease;
        double answeredDeadline;
        if (reply == null || reply.Length < 6 || !TryId(reply[3], out answeredLease) ||
          !double.TryParse(reply[5], System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out answeredDeadline)) return null;
        var answer = new MixLeaseAnswer();
        answer.Answer = reply[4];
        answer.Lease = answeredLease;
        answer.DeadlineAt = answeredDeadline;
        return answer;
    }
    public string Release(long action, long seq, long lease)
    {
        string[] reply = Ask("released", action, seq, lease,
          "{\"op\":\"release\",\"action\":" + action + ",\"seq\":" + seq + ",\"lease\":" + lease + "}",
          MixLeaseClock.Now() + AnswerTimeoutMs);
        if (reply == null) return null;
        string ended = reply[4];
        return ended == "released" || ended == "failed" || ended == "unknown" || ended == "none" ? ended : null;
    }
    static string[] Ask(string kind, long action, long seq, long lease, string request, double until)
    {
        var waiter = new Waiter();
        waiter.Kind = kind;
        waiter.Action = action;
        waiter.Seq = seq;
        waiter.Lease = lease;
        lock (sync)
        {
            if (inputEnded) return null;
            waiting = waiter;
        }
        try
        {
            System.Console.Out.WriteLine(LinePrefix + request);
            System.Console.Out.Flush();
            double left = until - MixLeaseClock.Now();
            if (left > 0) waiter.Done.WaitOne((int)System.Math.Ceiling(left));
            lock (sync) { return waiter.Reply; }
        }
        finally
        {
            lock (sync) { if (waiting == waiter) waiting = null; }
            waiter.Done.Close();
        }
    }
}

/// The worker's stdin, read on its own thread: lease answers reach the wait
/// they answer while a command is still running, and command lines queue for
/// the request loop, which reads them in order.
public sealed class MixWorkerInput : System.IO.TextReader
{
    readonly System.Collections.Generic.Queue<string> commands = new System.Collections.Generic.Queue<string>();
    bool ended;
    public MixWorkerInput(System.IO.Stream stream)
    {
        var reader = new System.IO.StreamReader(stream, System.Text.Encoding.UTF8);
        var thread = new System.Threading.Thread(delegate () { Pump(reader); });
        thread.IsBackground = true;
        thread.Name = "Mixdog worker input";
        thread.Start();
    }
    void Pump(System.IO.StreamReader reader)
    {
        try
        {
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.StartsWith(MixForegroundLockHost.ReplyPrefix, System.StringComparison.Ordinal))
                {
                    MixForegroundLockHost.Receive(line.Substring(MixForegroundLockHost.ReplyPrefix.Length));
                    continue;
                }
                lock (commands)
                {
                    commands.Enqueue(line);
                    System.Threading.Monitor.PulseAll(commands);
                }
            }
        }
        catch { }
        finally
        {
            // A broken pipe ends the commands as its end does.
            lock (commands)
            {
                ended = true;
                System.Threading.Monitor.PulseAll(commands);
            }
            MixForegroundLockHost.InputEnded();
        }
    }
    public override string ReadLine()
    {
        lock (commands)
        {
            while (commands.Count == 0 && !ended) System.Threading.Monitor.Wait(commands);
            return commands.Count > 0 ? commands.Dequeue() : null;
        }
    }
}
