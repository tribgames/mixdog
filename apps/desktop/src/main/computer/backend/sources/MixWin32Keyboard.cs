public partial class MixWin32
{
    [DllImport("user32.dll")] static extern bool EnableWindow(IntPtr h, bool enable);
    /// XAML/WinUI and Chromium hosts activate themselves while handling an
    /// accessibility invoke, which drags the user's screen to a window they were
    /// not looking at. A disabled top-level cannot become the foreground window,
    /// while the accessibility call still lands: it travels the accessibility
    /// channel rather than the input queue this gates. Classic Win32 windows do
    /// not self-activate, so they keep their normal enabled state.
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
    public static bool SelfActivatesOnSemanticInput(IntPtr h)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return false;
        string name = ClassNameOf(h);
        // A WinUI 3 app keeps its own top-level class (Paint's is MSPaintApp) and
        // hosts its content in this island, which raises the app on invoke.
        if (FindWindowEx(h, IntPtr.Zero, "Microsoft.UI.Content.DesktopChildSiteBridge", null) != IntPtr.Zero) return true;
        return String.Equals(name, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase)
          || String.Equals(name, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase)
          || String.Equals(name, "WinUIDesktopWin32WindowClass", StringComparison.OrdinalIgnoreCase)
          || IsChromiumClass(name);
    }
    /// Returns the enabled state the window had, so the caller restores exactly
    /// what it found instead of assuming the window started out enabled.
    public static bool SetWindowEnabled(IntPtr h, bool enabled)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return true;
        return !EnableWindow(h, enabled);
    }
    // GWL_EXSTYLE is a 32-bit value, so the plain entry points serve 32- and 64-bit processes alike.
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLongW(IntPtr h, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern int SetWindowLongW(IntPtr h, int index, int value);
    const int GWL_EXSTYLE = -20;
    const int WS_EX_NOACTIVATE = 0x08000000;
    const int InactiveSettleMs = 50;
    const int InactiveRestoreGapMs = 12;
    static readonly object inactiveSync = new object();
    // Roots whose no-activate bit this worker added, with the holds that still
    // need it. Only the last holder clears the bit, so overlapping holds on one
    // root never expose it while another still relies on it.
    static readonly Dictionary<IntPtr, int> inactiveHolders = new Dictionary<IntPtr, int>();
    // Roots under an open scope: the scope owns the settle and foreground
    // recovery, so deliveries inside it only hold.
    static readonly Dictionary<IntPtr, int> inactiveScopes = new Dictionary<IntPtr, int>();
    /// True when a hold in the current request could not make its target
    /// non-activatable (the window refused the style, e.g. it runs at higher
    /// integrity). Delivery still happens; the result must not claim the target
    /// was protected. The request loop clears it before each request and reads it after.
    public static bool ActivationUnprotected;
    public sealed class InactiveScope
    {
        internal IntPtr Root;
        internal IntPtr Held;
        internal IntPtr ForegroundBefore;
        internal MixInputSnapshot InputBefore;
        internal bool Ended;
    }
    static IntPtr InactiveRootOf(IntPtr h)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return IntPtr.Zero;
        IntPtr root = GetAncestor(h, 2);
        return root == IntPtr.Zero ? h : root;
    }
    static bool InactiveStyleSet(IntPtr root)
    {
        return (GetWindowLongW(root, GWL_EXSTYLE) & WS_EX_NOACTIVATE) != 0;
    }
    /// Background input must not raise its target over the window the user is in:
    /// once the target has come forward, sending the user's window back is a flash
    /// the user already saw. A no-activate top-level declines activation while the
    /// click, key or accessibility call still lands. Returns the root this hold
    /// counts against, or zero when there is nothing to release: the target is
    /// the foreground or already non-activatable (not needed), or the window
    /// refused the style (unavailable, reported through ActivationUnprotected).
    public static IntPtr HoldInactive(IntPtr h)
    {
        lock (inactiveSync)
        {
            IntPtr root = InactiveRootOf(h);
            if (root == IntPtr.Zero) return IntPtr.Zero;
            int holders;
            if (inactiveHolders.TryGetValue(root, out holders))
            {
                inactiveHolders[root] = holders + 1;
                return root;
            }
            if (root == GetForegroundWindow()) return IntPtr.Zero;
            int style = GetWindowLongW(root, GWL_EXSTYLE);
            if ((style & WS_EX_NOACTIVATE) != 0) return IntPtr.Zero;
            // Recorded before the write: a kill between the two leaves a harmless entry.
            // A bit that cannot be recorded is never written, since a killed worker
            // could not have it cleared; delivery goes on unprotected instead. An
            // unconfigured ledger records nothing, so it counts as a failed one.
            bool recorded = LedgerConfigured;
            if (recorded)
            {
                try { LedgerAdd(root); }
                catch { recorded = false; }
            }
            if (!recorded)
            {
                ActivationUnprotected = true;
                return IntPtr.Zero;
            }
            SetWindowLongW(root, GWL_EXSTYLE, style | WS_EX_NOACTIVATE);
            if (!InactiveStyleSet(root))
            {
                LedgerRemove(root);
                ActivationUnprotected = true;
                return IntPtr.Zero;
            }
            inactiveHolders[root] = 1;
            return root;
        }
    }
    /// Ends one hold. The last holder clears the bit and reads it back; a bit that
    /// stays set is a cleanup failure, never silently accepted. The root stays
    /// recorded (and in the ledger) so a later release can retry.
    public static void ReleaseInactive(IntPtr root)
    {
        if (root == IntPtr.Zero) return;
        lock (inactiveSync)
        {
            int holders;
            if (!inactiveHolders.TryGetValue(root, out holders)) return;
            if (holders > 1)
            {
                inactiveHolders[root] = holders - 1;
                return;
            }
            if (!IsWindow(root))
            {
                // The window is gone and its style with it.
                inactiveHolders.Remove(root);
                LedgerRemove(root);
                return;
            }
            SetWindowLongW(root, GWL_EXSTYLE, GetWindowLongW(root, GWL_EXSTYLE) & ~WS_EX_NOACTIVATE);
            if (InactiveStyleSet(root))
            {
                inactiveHolders[root] = 0;
                throw new InvalidOperationException(
                  "input_cleanup_unconfirmed: the background target could not be made activatable again");
            }
            inactiveHolders.Remove(root);
            LedgerRemove(root);
        }
    }
    /// One hold that spans several deliveries (a click and the text after it, a
    /// sequence's steps). Deliveries inside it skip their own settle; EndInactive
    /// settles and recovers the foreground once, then releases.
    public static InactiveScope BeginInactive(IntPtr top)
    {
        var scope = new InactiveScope();
        scope.Root = InactiveRootOf(top);
        scope.ForegroundBefore = GetForegroundWindow();
        scope.InputBefore = MixInputObservation.Read();
        scope.Held = HoldInactive(top);
        if (scope.Root != IntPtr.Zero)
        {
            lock (inactiveSync)
            {
                int open;
                inactiveScopes.TryGetValue(scope.Root, out open);
                inactiveScopes[scope.Root] = open + 1;
            }
        }
        return scope;
    }
    public static void EndInactive(InactiveScope scope)
    {
        if (scope == null || scope.Ended) return;
        scope.Ended = true;
        try
        {
            System.Threading.Thread.Sleep(InactiveSettleMs);
            RecoverInactiveForeground(scope.Root, scope.ForegroundBefore, scope.InputBefore);
        }
        finally
        {
            if (scope.Root != IntPtr.Zero)
            {
                lock (inactiveSync)
                {
                    int open;
                    if (inactiveScopes.TryGetValue(scope.Root, out open))
                    {
                        if (open > 1) inactiveScopes[scope.Root] = open - 1;
                        else inactiveScopes.Remove(scope.Root);
                    }
                }
            }
            ReleaseInactive(scope.Held);
        }
    }
    /// The target's own windows: its root, a window inside it, or one it owns.
    static bool IsInactiveTargetWindow(IntPtr window, IntPtr root)
    {
        if (!IsWindowHandle(window) || !IsWindowHandle(root)) return false;
        return window == root || IsWithinTopLevel(window, root) || IsOwnedBy(window, root);
    }
    /// A foreground the target took: any of its windows, or any window of its
    /// process (a popup it raised for the input).
    static bool BelongsToInactiveTarget(IntPtr window, IntPtr root)
    {
        return IsInactiveTargetWindow(window, root) || (IsWindowHandle(window) && IsWindowHandle(root) && SharesProcess(window, root));
    }
    /// Nothing to give back when the user was already in the target itself. A
    /// sibling of the same process is the user's window, so a steal from it is restored.
    internal static bool InactiveRestoreSkipped(IntPtr root, IntPtr before)
    {
        return root == IntPtr.Zero || !IsWindowHandle(before) || IsInactiveTargetWindow(before, root);
    }
    /// A target that refused the style, or raised itself anyway, gives the user
    /// their window back: at most two attempts, each only while the target still
    /// holds the foreground and no user input arrived since delivery began.
    static void RecoverInactiveForeground(IntPtr root, IntPtr before, MixInputSnapshot inputBefore)
    {
        if (InactiveRestoreSkipped(root, before)) return;
        if (inputBefore == null || !inputBefore.Ready) return;
        RunInactiveRecovery(
          delegate { return BelongsToInactiveTarget(GetForegroundWindow(), root); },
          delegate
          {
              MixInputObservation.BeginExpected(inputBefore.Generation, inputBefore.Sequence);
              try
              {
                  MixInputObservation.AssertContinue();
                  // One activation try per attempt: Focus would retry, sleep and
                  // relax the foreground lock with no input check in between.
                  TryFocusAttached(before);
              }
              finally { MixInputObservation.End(); }
          },
          delegate (int ms) { System.Threading.Thread.Sleep(ms); });
    }
    /// Returns the restore attempts made. Each attempt first re-checks that the
    /// target still holds the foreground; a restore refused for user input ends
    /// recovery without another attempt.
    internal static int RunInactiveRecovery(Func<bool> targetHoldsForeground, Action guardedRestore, Action<int> sleep)
    {
        int attempts = 0;
        for (int attempt = 0; attempt < 2; attempt++)
        {
            if (attempt > 0) sleep(InactiveRestoreGapMs);
            if (!targetHoldsForeground()) break;
            attempts++;
            try { guardedRestore(); }
            catch (Exception error)
            {
                string message = error.Message ?? "";
                // The user moved: the desktop is theirs, so nothing is restored.
                if (message.StartsWith("user_input_active") || message.StartsWith("input_observation_unavailable")) break;
                throw;
            }
        }
        return attempts;
    }
    static string WhileInactive(IntPtr top, Func<string> deliver)
    {
        IntPtr root = InactiveRootOf(top);
        bool scoped;
        lock (inactiveSync) { scoped = root != IntPtr.Zero && inactiveScopes.ContainsKey(root); }
        if (scoped)
        {
            IntPtr held = HoldInactive(top);
            try { return deliver(); }
            finally { ReleaseInactive(held); }
        }
        InactiveScope scope = BeginInactive(top);
        try { return deliver(); }
        finally { EndInactive(scope); }
    }
    public static bool SupportsBackgroundKeyboardClass(string name)
    {
        return !String.Equals(name, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase)
          && !String.Equals(name, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase)
          && !String.Equals(name, "WinUIDesktopWin32WindowClass", StringComparison.OrdinalIgnoreCase)
          && !String.Equals(name, "Microsoft.UI.Content.DesktopChildSiteBridge", StringComparison.OrdinalIgnoreCase)
          && !String.Equals(name, "Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase)
          && !(name ?? "").StartsWith("Chrome_WidgetWin_", StringComparison.OrdinalIgnoreCase);
    }
    /// A Chromium renderer rebuilds its own click count from the events its
    /// input thread accepts, so a delivered double-click message arrives as two
    /// ordinary clicks and the gesture never happens. A route that cannot land
    /// must refuse before delivery rather than report input it did not make.
    static bool IsChromiumClass(string name)
    {
        return String.Equals(name, "Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase)
          || (name ?? "").StartsWith("Chrome_WidgetWin_", StringComparison.OrdinalIgnoreCase);
    }
    public static bool SupportsBackgroundDoubleClickClass(string name)
    {
        return !IsChromiumClass(name);
    }
    /// A browser or Electron tab can echo an accessibility value write its renderer
    /// never applied, so a value read back there proves nothing about the document.
    public static bool IsWebContentHost(IntPtr window)
    {
        return IsChromiumClass(ClassNameOf(window));
    }
    public static void ValidateBackgroundInput(IntPtr top, IntPtr preferred, string action, string keys)
    {
        // Grammar validation precedes all delivery, including a sequence's first click.
        if (action == "key") ParseBackgroundKeys(keys);
        if (action != "key" && action != "type") return;
        if (!IsWindowHandle(top)) throw new InvalidOperationException("stale_target|background input window is stale");
        if (preferred != IntPtr.Zero) { KeyboardTarget(top, preferred); return; }
        if (!SupportsBackgroundKeyboardClass(ClassNameOf(top)))
        {
            throw new InvalidOperationException(
              "background_unsupported|target renderer does not accept posted keyboard input; use semantic value input or explicit foreground delivery; no input sent");
        }
    }
    static IntPtr FocusedKeyboardDescendant(IntPtr top)
    {
        var threads = new HashSet<uint>();
        threads.Add(GetWindowThreadProcessId(top, IntPtr.Zero));
        EnumChildWindows(top, delegate (IntPtr child, IntPtr state)
        {
            if (BelongsToTop(top, child)) threads.Add(GetWindowThreadProcessId(child, IntPtr.Zero));
            return true;
        }, IntPtr.Zero);
        var candidates = new List<KeyValuePair<IntPtr, int>>();
        foreach (uint thread in threads)
        {
            GUITHREADINFO info = new GUITHREADINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
            if (thread == 0 || !GetGUIThreadInfo(thread, ref info) || !BelongsToTop(top, info.hwndFocus)) continue;
            IntPtr current = info.hwndFocus;
            int depth = 0;
            while (current != top && current != IntPtr.Zero && depth < 64)
            {
                current = GetParent(current);
                depth++;
            }
            if (current == top) candidates.Add(new KeyValuePair<IntPtr, int>(info.hwndFocus, depth));
        }
        return SelectDeepestKeyboardFocus(top, candidates);
    }
    internal static IntPtr SelectDeepestKeyboardFocus(IntPtr top, IEnumerable<KeyValuePair<IntPtr, int>> candidates)
    {
        IntPtr selected = top;
        int selectedDepth = 0;
        bool ambiguous = false;
        foreach (var candidate in candidates)
        {
            if (candidate.Value < selectedDepth) continue;
            if (candidate.Value > selectedDepth)
            {
                selected = candidate.Key;
                selectedDepth = candidate.Value;
                ambiguous = false;
            }
            else if (selected != candidate.Key)
            {
                ambiguous = true;
            }
        }
        if (ambiguous) throw new InvalidOperationException(
          "background_target_ambiguous|multiple focused child windows; use an exact native ref");
        return selected;
    }
    static IntPtr KeyboardTarget(IntPtr top, IntPtr preferred)
    {
        if (!IsWindowHandle(top))
        {
            throw new InvalidOperationException("stale_target|background keyboard target is stale or invalid");
        }
        if (preferred != IntPtr.Zero)
        {
            if (!BelongsToTop(top, preferred))
            {
                throw new InvalidOperationException("target_mismatch|background keyboard ref belongs to a different window");
            }
        }
        // The addressed child owns keyboard delivery, not the outer host's toolkit.
        IntPtr focused = preferred != IntPtr.Zero ? preferred : FocusedKeyboardDescendant(top);
        if (!SupportsBackgroundKeyboardClass(ClassNameOf(focused)))
        {
            throw new InvalidOperationException("background_unsupported|focused renderer does not accept posted keyboard input; no input sent");
        }
        // An inactive Tk window keeps its focus to itself and leaves the native
        // focus empty; keys sent to its frame are discarded without an error.
        if (focused == top && ClassNameOf(top).StartsWith("Tk", StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
              "background_unsupported|this Tk window has no focused control while inactive, so background keys would be discarded; use explicit foreground delivery; no input sent");
        }
        return focused;
    }
    public static ushort NamedVirtualKey(string name)
    {
        switch (name)
        {
            case "BACKSPACE": case "BS": return 0x08;
            case "TAB": return 0x09;
            case "ENTER": case "RETURN": return 0x0D;
            case "ESC": case "ESCAPE": return 0x1B;
            case "SPACE": return 0x20;
            case "PGUP": case "PRIOR": return 0x21;
            case "PGDN": case "NEXT": return 0x22;
            case "END": return 0x23;
            case "HOME": return 0x24;
            case "LEFT": return 0x25;
            case "UP": return 0x26;
            case "RIGHT": return 0x27;
            case "DOWN": return 0x28;
            case "INSERT": case "INS": return 0x2D;
            case "DELETE": case "DEL": return 0x2E;
            case "PLUS": return 0xBB;
            case "MINUS": return 0xBD;
            // Named on their own they are ordinary keys: held, released or
            // tapped by themselves rather than decorating another key.
            case "SHIFT": return 0x10;
            case "CTRL": case "CONTROL": return 0x11;
            case "ALT": case "MENU": return 0x12;
            case "CAPSLOCK": return 0x14;
            case "NUMLOCK": return 0x90;
            case "SCROLLLOCK": return 0x91;
            case "LWIN": case "WIN": return 0x5B;
            case "APPS": return 0x5D;
            case "PRTSC": case "PRINTSCREEN": return 0x2C;
            case "PAUSE": return 0x13;
        }
        if (name.Length >= 2 && name[0] == 'F')
        {
            int number;
            if (Int32.TryParse(name.Substring(1), out number) && number >= 1 && number <= 24)
            {
                return (ushort)(0x6F + number);
            }
        }
        throw new InvalidOperationException("background_unsupported|background keyboard does not support key token {" + name + "}");
    }
    static bool IsExtendedVirtualKey(ushort vk)
    {
        return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24
          || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28
          || vk == 0x2D || vk == 0x2E;
    }
    /// The character a physical press of these keys makes: the target's own
    /// TranslateMessage derives it from a queued key, but a sent key never passes
    /// that loop, and Edit controls and terminals act on Enter, Tab, Backspace,
    /// Escape and Space only through it. Queuing the key instead would let the
    /// derived character land behind text already queued after it.
    public static char TranslatedKeyCharacter(ushort vk)
    {
        switch (vk)
        {
            case 0x08: return '\b';
            case 0x09: return '\t';
            case 0x0D: return '\r';
            case 0x1B: return (char)0x1B;
            case 0x20: return ' ';
            default: return '\0';
        }
    }
    /// Tk derives the editing action from the key itself and repeats it for the
    /// character, so it receives the key alone.
    public static bool ReceivesTranslatedCharacter(string className)
    {
        return !(className ?? "").StartsWith("Tk", StringComparison.Ordinal);
    }
    static void BackgroundVirtualKey(IntPtr target, ushort vk)
    {
        uint scan = MapVirtualKey(vk, 0);
        int state = 1 | ((int)scan << 16) | (IsExtendedVirtualKey(vk) ? 1 << 24 : 0);
        int released = state | unchecked((int)0xC0000000);
        char translated = ReceivesTranslatedCharacter(ClassNameOf(target)) ? TranslatedKeyCharacter(vk) : '\0';
        var release = BindBackgroundRelease(target, delegate
        {
            SendMessageChecked(target, WM_KEYUP, new UIntPtr(vk), new IntPtr(released));
        });
        // A keyboard delivers the press, its character, then the release.
        WithBackgroundRelease(
          delegate
          {
              SendMessageChecked(target, WM_KEYDOWN, new UIntPtr(vk), new IntPtr(state));
              if (translated != '\0') SendMessageChecked(target, WM_CHAR, new UIntPtr(translated), new IntPtr(state));
          },
          delegate { }, release);
    }
    static void BackgroundChar(IntPtr target, char value)
    {
        SendMessageChecked(target, WM_CHAR, new UIntPtr(value), new IntPtr(1));
    }
    public static string BackgroundText(IntPtr top, IntPtr preferred, string text)
    {
        return WhileInactive(top, delegate { return BackgroundTextCore(top, preferred, text); });
    }
    static string BackgroundTextCore(IntPtr top, IntPtr preferred, string text)
    {
        IntPtr target = KeyboardTarget(top, preferred);
        string value = text ?? "";
        ReportWindowInput(target, "type");
        foreach (char ch in value)
        {
            if (ch == '\n') BackgroundVirtualKey(target, 0x0D);
            else if (ch != '\r') BackgroundChar(target, ch);
        }
        return WindowId(target);
    }
    public struct BackgroundKeyStroke
    {
        public bool IsCharacter;
        public char Character;
        public ushort Key;
    }
    // Validate the entire grammar before resolving a target or sending its prefix.
    public static List<BackgroundKeyStroke> ParseBackgroundKeys(string keys)
    {
        var strokes = new List<BackgroundKeyStroke>();
        string value = keys ?? "";
        for (int index = 0; index < value.Length; index++)
        {
            char ch = value[index];
            if (ch == '\r' || ch == '\n')
            {
                if (ch == '\r' && index + 1 < value.Length && value[index + 1] == '\n') index++;
                strokes.Add(new BackgroundKeyStroke { Key = 0x0D });
                continue;
            }
            if (ch == '{')
            {
                if (index + 2 < value.Length && value.Substring(index, 3) == "{{}")
                {
                    strokes.Add(new BackgroundKeyStroke { IsCharacter = true, Character = '{' }); index += 2; continue;
                }
                if (index + 2 < value.Length && value.Substring(index, 3) == "{}}")
                {
                    strokes.Add(new BackgroundKeyStroke { IsCharacter = true, Character = '}' }); index += 2; continue;
                }
                int end = value.IndexOf('}', index + 1);
                if (end < 0)
                {
                    throw new InvalidOperationException("background_unsupported|unclosed background key token");
                }
                string token = value.Substring(index + 1, end - index - 1).Trim().ToUpperInvariant();
                int repeat = 1;
                int space = token.LastIndexOf(' ');
                if (space > 0)
                {
                    int parsed;
                    if (Int32.TryParse(token.Substring(space + 1), out parsed) && parsed >= 1 && parsed <= 100)
                    {
                        repeat = parsed;
                        token = token.Substring(0, space);
                    }
                }
                ushort vk = NamedVirtualKey(token);
                if (vk == 0x5B)
                {
                    throw new InvalidOperationException(
                      "background_unsupported|the Windows key needs the real keyboard; use explicit foreground delivery");
                }
                for (int count = 0; count < repeat; count++) strokes.Add(new BackgroundKeyStroke { Key = vk });
                index = end;
                continue;
            }
            if ("^%+~()#".IndexOf(ch) >= 0)
            {
                // A sequence that is nothing but the symbol means the character
                // itself; only a longer one can be carrying grammar.
                if (value.Length == 1)
                {
                    strokes.Add(new BackgroundKeyStroke { IsCharacter = true, Character = ch });
                    continue;
                }
                throw new InvalidOperationException(
                  "background_unsupported|background keyboard does not support SendKeys modifiers/groups; use explicit foreground delivery");
            }
            strokes.Add(new BackgroundKeyStroke { IsCharacter = true, Character = ch });
        }
        return strokes;
    }
    public static string BackgroundKeys(IntPtr top, IntPtr preferred, string keys)
    {
        return WhileInactive(top, delegate { return BackgroundKeysCore(top, preferred, keys); });
    }
    static string BackgroundKeysCore(IntPtr top, IntPtr preferred, string keys)
    {
        var strokes = ParseBackgroundKeys(keys);
        IntPtr target = KeyboardTarget(top, preferred);
        ReportWindowInput(target, "type");
        foreach (var stroke in strokes)
        {
            if (stroke.IsCharacter) BackgroundChar(target, stroke.Character);
            else BackgroundVirtualKey(target, stroke.Key);
        }
        return WindowId(target);
    }
    public static string NativeObservableState(IntPtr target, string action)
    {
        if (!IsWindowHandle(target)) return "";
        string className = ClassNameOf(target).ToUpperInvariant();
        string normalized = (action ?? "").ToLowerInvariant();
        if ((normalized == "key" || normalized == "type") && className.Contains("EDIT"))
        {
            UIntPtr rawLength = SendMessageValue(
              target, WM_GETTEXTLENGTH, UIntPtr.Zero, IntPtr.Zero);
            int length = (int)Math.Min(32768UL, rawLength.ToUInt64());
            IntPtr buffer = Marshal.AllocHGlobal((length + 1) * 2);
            try
            {
                for (int offset = 0; offset < (length + 1) * 2; offset++)
                {
                    Marshal.WriteByte(buffer, offset, 0);
                }
                SendMessageValue(target, WM_GETTEXT, new UIntPtr((uint)(length + 1)), buffer);
                return "native_text=" + (Marshal.PtrToStringUni(buffer) ?? "");
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        if ((normalized == "click" || normalized == "double_click"
            || normalized == "right_click" || normalized == "middle_click"
            || normalized == "triple_click") && className.Contains("BUTTON"))
        {
            UIntPtr check = SendMessageValue(target, BM_GETCHECK, UIntPtr.Zero, IntPtr.Zero);
            return "native_check=" + check.ToUInt64();
        }
        return "";
    }
}
