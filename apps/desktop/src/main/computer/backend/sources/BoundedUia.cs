/// One window's UIA root and the elements a bounded read found under it.
public sealed class MixBoundedUiaRead
{
    public System.Windows.Automation.AutomationElement Root;
    public System.Windows.Automation.AutomationElementCollection Elements;
}

/// The MSAA nodes that answered their refresh, and how many the walk found.
public sealed class MixBoundedMsaaRead
{
    public MixMsaaNode[] Nodes;
    public int Candidates;
}

public sealed class MixUiaAncestor
{
    public string RuntimeId;
    public string Role;
    public string Name;
}

/// What a structured snapshot reports about one element's place in the tree.
public sealed class MixUiaStructure
{
    public string RuntimeId;
    public string ParentRuntimeId;
    public string ClassName;
    public bool HasKeyboardFocus;
    public bool InDocument;
    public MixUiaAncestor[] Ancestors;
}

/// The one budget every provider call of a snapshot shares, counted from the
/// moment the snapshot began.
public sealed class MixUiaDeadline
{
    readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    public readonly int BudgetMs;

    public MixUiaDeadline(int budgetMs) { BudgetMs = budgetMs; }

    public int RemainingMs
    {
        get { return (int)System.Math.Max(0, BudgetMs - clock.ElapsedMilliseconds); }
    }
}

/// Runs a capture's provider calls on their own thread against the snapshot's
/// deadline, so a stalled provider costs only that read: a UIA or MSAA call
/// cannot be cancelled, and the worker that would wait it out also hosts the
/// input observer's hooks, which a worker restart drops. A null deadline runs
/// the call inline, as reads without a deadline always did.
public static class MixBoundedUia
{
    static readonly object sync = new object();
    // At most one abandoned call per worker; it ends when the provider answers.
    static System.Threading.Thread abandoned;

    public static T Run<T>(MixUiaDeadline deadline, string stage, System.Func<T> work)
    {
        if (deadline == null) return work();
        lock (sync)
        {
            if (abandoned != null && abandoned.IsAlive)
            {
                throw new System.TimeoutException(
                    "computer_command_timeout: an earlier abandoned accessibility read is still running; this read was not started and the input host kept running");
            }
            abandoned = null;
        }
        int remaining = deadline.RemainingMs;
        if (remaining <= 0) throw Exceeded(deadline, stage);
        T result = default(T);
        System.Exception failure = null;
        var thread = new System.Threading.Thread(() =>
        {
            try { result = work(); }
            catch (System.Exception e) { failure = e; }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(System.Threading.ApartmentState.MTA);
        thread.Start();
        if (!thread.Join(remaining))
        {
            lock (sync) abandoned = thread;
            throw Exceeded(deadline, stage);
        }
        if (failure != null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
        return result;
    }

    static System.TimeoutException Exceeded(MixUiaDeadline deadline, string stage)
    {
        return new System.TimeoutException(
            "computer_command_timeout: accessibility read exceeded " + deadline.BudgetMs + "ms during " + stage +
            "; the read was abandoned and the input host kept running");
    }

    public static MixBoundedUiaRead FindAll(
        MixUiaDeadline deadline,
        System.IntPtr handle,
        string windowLabel,
        System.Windows.Automation.TreeScope scope,
        System.Windows.Automation.Condition condition,
        System.Windows.Automation.CacheRequest cache)
    {
        return Run(deadline, "the element search", () =>
        {
            var read = new MixBoundedUiaRead();
            try { read.Root = System.Windows.Automation.AutomationElement.FromHandle(handle); }
            catch (System.Exception e)
            {
                throw new System.InvalidOperationException("window has no UI Automation root: " + windowLabel + " (" + e.Message + ")");
            }
            using (cache.Activate()) read.Elements = read.Root.FindAll(scope, condition);
            return read;
        });
    }

    /// Whether anything under root matches; a provider error counts as no match.
    public static bool HasFirst(
        MixUiaDeadline deadline,
        System.Windows.Automation.AutomationElement root,
        System.Windows.Automation.TreeScope scope,
        System.Windows.Automation.Condition condition)
    {
        return Run(deadline, "the native control probe", () =>
        {
            try { return root.FindFirst(scope, condition) != null; }
            catch { return false; }
        });
    }

    /// The text of each visible range, or null when the provider refuses it.
    public static string[] VisibleText(MixUiaDeadline deadline, System.Windows.Automation.AutomationElement element)
    {
        return Run(deadline, "the visible text read", () =>
        {
            try
            {
                var pattern = (System.Windows.Automation.TextPattern)element.GetCurrentPattern(System.Windows.Automation.TextPattern.Pattern);
                var texts = new System.Collections.Generic.List<string>();
                foreach (var range in pattern.GetVisibleRanges()) texts.Add(range.GetText(20000));
                return texts.ToArray();
            }
            catch { return (string[])null; }
        });
    }

    /// The snapshot's candidate ceiling, UIA and MSAA together.
    public const int CandidateLimit = 5000;

    /// `priorCandidates` are the UIA candidates already counted: an over-limit
    /// walk is refused before any node is refreshed, as the snapshot always did.
    public static MixBoundedMsaaRead MsaaSnapshot(MixUiaDeadline deadline, System.IntPtr handle, string windowId, int maximum, int priorCandidates)
    {
        return Run(deadline, "the MSAA enrichment", () =>
        {
            MixMsaaNode[] nodes;
            try { nodes = MixMsaa.Snapshot(handle, windowId, maximum); }
            catch (System.Exception e) { throw new System.InvalidOperationException("MSAA snapshot failed for " + windowId + ": " + e.Message); }
            int candidates = priorCandidates + nodes.Length;
            if (candidates > CandidateLimit)
            {
                throw new System.InvalidOperationException(
                    "accessibility candidate limit exceeded: " + candidates + " > " + CandidateLimit + "; narrow the role/query");
            }
            var live = new System.Collections.Generic.List<MixMsaaNode>();
            foreach (var node in nodes) if (node.Refresh()) live.Add(node);
            return new MixBoundedMsaaRead { Nodes = live.ToArray(), Candidates = nodes.Length };
        });
    }

    public static MixUiaStructure Structure(MixUiaDeadline deadline, System.Windows.Automation.AutomationElement element)
    {
        return Run(deadline, "the element structure read", () =>
        {
            var walker = System.Windows.Automation.TreeWalker.ControlViewWalker;
            var desktop = System.Windows.Automation.AutomationElement.RootElement;
            var structure = new MixUiaStructure { RuntimeId = RuntimeKey(element), ParentRuntimeId = "", ClassName = "" };
            var ancestors = new System.Collections.Generic.List<MixUiaAncestor>();
            var parent = walker.GetParent(element);
            for (int depth = 0; depth < 80 && parent != null; depth++)
            {
                if (System.Windows.Automation.Automation.Compare(parent, desktop)) break;
                var ancestor = new MixUiaAncestor { RuntimeId = RuntimeKey(parent), Role = "", Name = "" };
                try { ancestor.Role = parent.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch { }
                try { ancestor.Name = parent.Current.Name ?? ""; } catch { }
                if (depth == 0) structure.ParentRuntimeId = ancestor.RuntimeId;
                if (ancestor.Role == "Document") structure.InDocument = true;
                ancestors.Add(ancestor);
                parent = walker.GetParent(parent);
            }
            try { structure.ClassName = element.Current.ClassName ?? ""; } catch { }
            try { structure.HasKeyboardFocus = element.Current.HasKeyboardFocus; } catch { }
            structure.Ancestors = ancestors.ToArray();
            return structure;
        });
    }

    static string RuntimeKey(System.Windows.Automation.AutomationElement element)
    {
        try { return string.Join(",", element.GetRuntimeId()); } catch { return ""; }
    }
}
