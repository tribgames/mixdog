public partial class MixWin32
{
    // Durable record of the WS_EX_NOACTIVATE bits this worker added to other
    // applications' windows, so a host can clear them if the worker is killed.
    // One tab-separated line per event: "+|-", window handle (hex), owning
    // process id, class name. The host replays the lines after the worker exits
    // and clears only roots whose handle, process id and class still match.
    [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] static extern uint LedgerGetWindowProcessId(IntPtr h, out uint processId);
    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)] static extern int LedgerGetClassName(IntPtr h, StringBuilder s, int n);

    static void LedgerAppend(char kind, IntPtr root)
    {
        string path = Environment.GetEnvironmentVariable("MIXDOG_COMPUTER_INACTIVE_LEDGER");
        if (String.IsNullOrEmpty(path)) return;
        uint processId;
        LedgerGetWindowProcessId(root, out processId);
        var className = new StringBuilder(256);
        LedgerGetClassName(root, className, className.Capacity);
        string cleanClass = className.ToString().Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
        string line = kind + "\t" + root.ToInt64().ToString("x", CultureInfo.InvariantCulture) + "\t"
          + processId.ToString(CultureInfo.InvariantCulture) + "\t" + cleanClass + "\n";
        byte[] bytes = new UTF8Encoding(false).GetBytes(line);
        using (var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite, 1, FileOptions.WriteThrough))
        {
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
    }

    // Call before setting the bit: a kill between the two leaves a harmless entry.
    public static void LedgerAdd(IntPtr root)
    {
        LedgerAppend('+', root);
    }

    // Call after clearing the bit.
    public static void LedgerRemove(IntPtr root)
    {
        LedgerAppend('-', root);
    }
}
