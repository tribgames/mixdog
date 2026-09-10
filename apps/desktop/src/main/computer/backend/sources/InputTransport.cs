// One checked native transport for normal input and emergency release.
public static class MixNativeInput {
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public System.IntPtr dwExtraInfo; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public System.IntPtr dwExtraInfo; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit)]
  public struct INPUTUNION {
    [System.Runtime.InteropServices.FieldOffset(0)] public MOUSEINPUT mi;
    [System.Runtime.InteropServices.FieldOffset(0)] public KEYBDINPUT ki;
  }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION U; }
  [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  static System.IO.MemoryMappedFiles.MemoryMappedFile ownership;
  static System.IntPtr ownershipMarker;
  public static bool ObserveForeignOwnership;
  static readonly object ownershipSync = new object();
  static string OwnershipName(System.IntPtr marker) {
    if (marker.ToInt64() <= 0 || marker.ToInt64() > int.MaxValue)
      throw new System.Exception("input_cleanup_unconfirmed: input ownership marker is invalid");
    return @"Local\MixdogInputOwnership-" + marker.ToInt64();
  }
  // Volatile shared memory only. A resident worker and the existing cursor
  // watchdog retain the receipt across input-worker termination; no key data
  // is written to disk, diagnostics, or the model response.
  public static void InitializeOwnership(System.IntPtr marker) {
    lock (ownershipSync) {
      if (ownership != null) {
        if (ownershipMarker != marker) throw new System.Exception("input_cleanup_unconfirmed: input ownership changed");
        return;
      }
      ownership = System.IO.MemoryMappedFiles.MemoryMappedFile.CreateOrOpen(OwnershipName(marker), 8192);
      ownershipMarker = marker;
    }
  }
  static System.Threading.Mutex OwnershipLock(System.IntPtr marker) {
    var mutex = new System.Threading.Mutex(false, OwnershipName(marker) + "-lock");
    try {
      bool acquired;
      try { acquired = mutex.WaitOne(1000); } catch (System.Threading.AbandonedMutexException) { acquired = true; }
      if (!acquired) throw new System.Exception("input_cleanup_unconfirmed: input ownership is busy");
      return mutex;
    } catch { mutex.Dispose(); throw; }
  }
  static System.Collections.Generic.List<INPUT> ReadOwned(
    System.IO.MemoryMappedFiles.MemoryMappedViewAccessor view, System.IntPtr marker) {
    if (view.ReadInt32(0) != 0) throw new System.Exception("input_cleanup_unconfirmed: native delivery receipt is uncertain");
    int count = view.ReadInt32(4);
    if (count < 0 || count > 256) throw new System.Exception("input_cleanup_unconfirmed: invalid input ownership receipt");
    var result = new System.Collections.Generic.List<INPUT>();
    for (int i = 0; i < count; i++) {
      long at = 8 + i * 16;
      uint type = view.ReadUInt32(at), flags = view.ReadUInt32(at + 8);
      INPUT input = type == 1
        ? Key(view.ReadUInt16(at + 4), view.ReadUInt16(at + 6), flags, marker) : Mouse(flags, marker);
      if (type > 1 || !IsRelease(input)) throw new System.Exception("input_cleanup_unconfirmed: invalid owned release");
      result.Add(input);
    }
    return result;
  }
  static void WriteOwned(System.IO.MemoryMappedFiles.MemoryMappedViewAccessor view,
    System.Collections.Generic.List<INPUT> releases) {
    if (releases.Count > 256) throw new System.Exception("input_cleanup_unconfirmed: input ownership capacity exceeded");
    int slots = System.Math.Max(view.ReadInt32(4), releases.Count);
    for (int i = 0; i < slots; i++) {
      long at = 8 + i * 16;
      INPUT input = i < releases.Count ? releases[i] : new INPUT();
      view.Write(at, input.type);
      view.Write(at + 4, input.type == 1 ? input.U.ki.wVk : (ushort)0);
      view.Write(at + 6, input.type == 1 ? input.U.ki.wScan : (ushort)0);
      view.Write(at + 8, input.type == 1 ? input.U.ki.dwFlags : input.U.mi.dwFlags);
    }
    view.Write(4, releases.Count);
    view.Write(0, 0);
  }
  public static void RecordForeignKey(int key, bool held) {
    if (ownership == null || key < 1 || key > 255) return;
    using (var view = ownership.CreateViewAccessor()) {
      view.Write(5000 + key, held);
      int generic = key == 0xA0 || key == 0xA1 ? 0x10 : key == 0xA2 || key == 0xA3 ? 0x11
        : key == 0xA4 || key == 0xA5 ? 0x12 : 0;
      if (generic != 0) {
        int left = generic == 0x10 ? 0xA0 : generic == 0x11 ? 0xA2 : 0xA4;
        view.Write(5000 + generic, view.ReadBoolean(5000 + left) || view.ReadBoolean(5000 + left + 1));
      }
    }
  }
  public static void BeginOwnershipObservation() {
    if (ownership == null) throw new System.Exception("input_cleanup_unconfirmed: ownership observation was not initialized");
    using (var view = ownership.CreateViewAccessor()) {
      for (int key = 1; key < 256; key++) view.Write(5000 + key, (GetAsyncKeyState(key) & 0x8000) != 0);
    }
    ObserveForeignOwnership = true;
  }
  static bool ForeignHeld(System.IO.MemoryMappedFiles.MemoryMappedViewAccessor view, INPUT input) {
    if (!IsRelease(input)) return false;
    int key = input.type == 1 ? input.U.ki.wVk
      : input.U.mi.dwFlags == 4 ? 1 : input.U.mi.dwFlags == 16 ? 2 : input.U.mi.dwFlags == 64 ? 4 : 0;
    return key > 0 && view.ReadBoolean(5000 + key);
  }
  public static uint DeliverTracked(INPUT[] inputs, System.IntPtr marker, System.Func<INPUT[], uint> transmit) {
    InitializeOwnership(marker);
    using (var mutex = OwnershipLock(marker))
    try {
      using (var view = ownership.CreateViewAccessor()) {
        var previous = ReadOwned(view, marker);
        foreach (INPUT input in inputs) if (ForeignHeld(view, input)) return 0;
        // Keep an in-flight marker before calling the OS. If the process dies
        // inside SendInput, cleanup must not invent an acknowledged prefix.
        view.Write(0, 1);
        uint sent = transmit(inputs);
        if (sent > inputs.Length) throw new System.Exception("input_cleanup_unconfirmed: invalid native delivery receipt");
        var history = new System.Collections.Generic.List<INPUT>();
        foreach (INPUT release in previous) {
          INPUT down = release;
          if (down.type == 1) down.U.ki.dwFlags &= ~2u;
          else down.U.mi.dwFlags >>= 1;
          history.Add(down);
        }
        for (int i = 0; i < sent; i++) history.Add(inputs[i]);
        WriteOwned(view, Outstanding(history.ToArray(), history.Count));
        return sent;
      }
    } finally { mutex.ReleaseMutex(); }
  }
  static uint Transmit(INPUT[] inputs) {
    if (inputs.Length == 0) return 0;
    System.IntPtr marker = inputs[0].type == 1 ? inputs[0].U.ki.dwExtraInfo : inputs[0].U.mi.dwExtraInfo;
    return DeliverTracked(inputs, marker, Send);
  }
  static uint Send(INPUT[] inputs) {
    return SendInput((uint)inputs.Length, inputs, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
  }
  public static bool IsExtendedKey(ushort key) {
    return key == 0x21 || key == 0x22 || key == 0x23 || key == 0x24 || key == 0x25
      || key == 0x26 || key == 0x27 || key == 0x28 || key == 0x2C || key == 0x2D
      || key == 0x2E || key == 0x5B || key == 0x5C || key == 0x5D || key == 0x6F
      || key == 0x90 || key == 0xA3 || key == 0xA5;
  }
  public static INPUT Key(ushort key, ushort scan, uint flags, System.IntPtr marker) {
    INPUT input = new INPUT(); input.type = 1;
    input.U.ki.wVk = key; input.U.ki.wScan = scan;
    input.U.ki.dwFlags = flags; input.U.ki.dwExtraInfo = marker;
    return input;
  }
  public static INPUT Mouse(uint flags, System.IntPtr marker) {
    INPUT input = new INPUT();
    input.U.mi.dwFlags = flags; input.U.mi.dwExtraInfo = marker;
    return input;
  }
  // The acknowledged prefix owns these downs. Never replay any positive input.
  static System.Collections.Generic.List<INPUT> Outstanding(INPUT[] inputs, int count) {
    var held = new System.Collections.Generic.Dictionary<string, INPUT>();
    for (int i = 0; i < count; i++) {
      INPUT input = inputs[i];
      if (input.type == 1) {
        string key = input.U.ki.wVk + ":" + input.U.ki.wScan + ":" + (input.U.ki.dwFlags & ~2u);
        if ((input.U.ki.dwFlags & 2) != 0) held.Remove(key);
        else { input.U.ki.dwFlags |= 2; held[key] = input; }
      } else {
        uint[] downs = { 2, 8, 32 };
        foreach (uint down in downs) {
          string key = "mouse:" + down;
          if ((input.U.mi.dwFlags & (down << 1)) != 0) held.Remove(key);
          else if ((input.U.mi.dwFlags & down) != 0) held[key] = Mouse(down << 1, input.U.mi.dwExtraInfo);
        }
      }
    }
    return new System.Collections.Generic.List<INPUT>(held.Values);
  }
  static void Release(System.Collections.Generic.IEnumerable<INPUT> inputs, System.Func<INPUT[], uint> transmit) {
    System.Exception failure = null;
    foreach (INPUT input in inputs) {
      try {
        if (transmit(new INPUT[] { input }) != 1) throw new System.Exception("release rejected");
      } catch (System.Exception error) { if (failure == null) failure = error; }
    }
    if (failure != null) throw new System.Exception("input_cleanup_unconfirmed: native input release was not accepted", failure);
  }
  public static void Deliver(INPUT[] inputs) { Deliver(inputs, Transmit); }
  static bool IsRelease(INPUT input) {
    return input.type == 1 ? (input.U.ki.dwFlags & 2) != 0
      : input.type == 0 && input.U.mi.dwFlags != 0 && (input.U.mi.dwFlags & ~(4u | 16u | 64u)) == 0;
  }
  public static void Deliver(INPUT[] inputs, System.Func<INPUT[], uint> transmit) {
    uint sent = transmit(inputs);
    if (sent == inputs.Length) return;
    if (sent > inputs.Length) throw new System.Exception("input_cleanup_unconfirmed: invalid native delivery receipt");
    // A failed release is a cleanup failure, not a refused positive action.
    if (System.Array.TrueForAll(inputs, IsRelease)) {
      throw new System.Exception("input_cleanup_unconfirmed: native input release was not accepted");
    }
    Release(Outstanding(inputs, (int)sent), transmit);
    throw new System.Exception("input_delivery_failed: native input was not fully delivered; completed input was not replayed");
  }
  public static void ReleaseOwned(System.IntPtr marker) {
    try {
      using (var existing = System.IO.MemoryMappedFiles.MemoryMappedFile.OpenExisting(OwnershipName(marker))) {
        ReleaseOwned(marker, Send);
      }
    } catch (System.IO.FileNotFoundException) {
      for (int key = 1; key < 256; key++) {
        if ((GetAsyncKeyState(key) & 0x8000) != 0)
          throw new System.Exception("input_cleanup_unconfirmed: ownership receipt is unavailable while input is held");
      }
    }
  }
  public static void ReleaseOwned(System.IntPtr marker, System.Func<INPUT[], uint> transmit) {
    InitializeOwnership(marker);
    using (var mutex = OwnershipLock(marker))
    try {
      using (var view = ownership.CreateViewAccessor()) {
        var releases = ReadOwned(view, marker);
        // Each release updates the shared receipt, including on partial failure.
        try {
          Release(releases, delegate(INPUT[] batch) { return DeliverTracked(batch, marker, transmit); });
        } catch {
          // Another cleanup caller must not retry an uncertain/failed release.
          view.Write(0, 2);
          throw;
        }
      }
    } finally { mutex.ReleaseMutex(); }
  }
}
