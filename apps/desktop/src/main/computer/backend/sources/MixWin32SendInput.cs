public partial class MixWin32
{
    // --- Keyboard: SendInput-based engine over the SendKeys grammar. ---
    // SendInput never flips NumLock/CapsLock (unlike Windows.Forms SendKeys),
    // and KEYEVENTF_UNICODE types any literal text regardless of layout.
    const uint KUP = 0x2, KUNI = 0x4, KEXT = 0x1;
    static INPUT KI(ushort vk, ushort scan, uint flags)
    {
        return MixNativeInput.Key(vk, scan, flags, MixInputObservation.Marker);
    }
    static void AddVk(List<INPUT> list, ushort vk, bool up)
    {
        uint flags = (MixNativeInput.IsExtendedKey(vk) ? KEXT : 0u) | (up ? KUP : 0u);
        list.Add(KI(vk, 0, flags));
    }
    static void AddUnicode(List<INPUT> list, char c)
    {
        list.Add(KI(0, (ushort)c, KUNI));
        list.Add(KI(0, (ushort)c, KUNI | KUP));
    }
    static void Dispatch(List<INPUT> list)
    {
        for (int off = 0; off < list.Count; off += 256)
        {
            int n = Math.Min(256, list.Count - off);
            INPUT[] arr = list.GetRange(off, n).ToArray();
            if (Array.Exists(arr, delegate (INPUT value) { return value.type != 1 || (value.U.ki.dwFlags & KUP) == 0; }))
            {
                MixInputObservation.AssertContinue();
            }
            MixNativeInput.Deliver(arr);
            NoteInjection();
            System.Threading.Thread.Sleep(3);
        }
    }
    /// One VK tap (down+up) through SendInput; used to restore lock keys.
    public static void KeyTap(ushort vk)
    {
        List<INPUT> list = new List<INPUT>();
        AddVk(list, vk, false); AddVk(list, vk, true);
        Dispatch(list);
    }
    /// Hold or release one VK; wraps modifier-held clicks (ctrl+click etc.).
    public static void KeyDown(ushort vk)
    {
        List<INPUT> list = new List<INPUT>();
        AddVk(list, vk, false);
        Dispatch(list);
    }
    public static void KeyUp(ushort vk)
    {
        List<INPUT> list = new List<INPUT>();
        AddVk(list, vk, true);
        Dispatch(list);
    }
    /// Literal text entry (no grammar): every character lands exactly as given.
    public static void SendText(string text)
    {
        foreach (char ch in (text == null ? "" : text))
        {
            if (ch == '\r') continue;
            List<INPUT> glyph = new List<INPUT>();
            if (ch == '\n')
            {
                AddVk(glyph, 0x0D, false);
                AddVk(glyph, 0x0D, true);
            }
            else
            {
                AddUnicode(glyph, ch);
            }
            Dispatch(glyph);
            // Chromium/WinUI can drop a tight Unicode batch even though SendInput
            // accepted it. Brief pacing preserves literal order across async queues.
            System.Threading.Thread.Sleep(4);
        }
    }
}
