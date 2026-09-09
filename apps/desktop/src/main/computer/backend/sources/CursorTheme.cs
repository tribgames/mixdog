// The watchdog owns the backup handles and survives termination of the input worker.
public interface MixCursorThemeApi {
  System.IntPtr Save(uint role);
  void Apply(uint role);
  bool Restore(uint role, System.IntPtr backup);
  bool ResetConfiguredScheme();
  void Free(System.IntPtr backup);
}

public sealed class MixCursorThemeLease : System.IDisposable {
  readonly MixCursorThemeApi api;
  readonly System.Collections.Generic.Dictionary<uint, System.IntPtr> backups =
    new System.Collections.Generic.Dictionary<uint, System.IntPtr>();
  readonly System.Collections.Generic.List<uint> changed = new System.Collections.Generic.List<uint>();
  public MixCursorThemeLease(MixCursorThemeApi implementation, uint[] roles) {
    api = implementation;
    try {
      foreach (uint role in roles) {
        System.IntPtr backup = api.Save(role);
        if (backup == System.IntPtr.Zero) throw new System.Exception("cursor backup unavailable");
        backups.Add(role, backup);
      }
    } catch { Dispose(); throw; }
  }
  public void Activate() {
    foreach (uint role in backups.Keys) {
      // The lease remains owned by the watchdog even if this call fails.
      changed.Add(role);
      api.Apply(role);
    }
  }
  public void Dispose() {
    bool restored = true;
    for (int i = changed.Count - 1; i >= 0; i--) {
      uint role = changed[i];
      bool ok = false;
      try { ok = api.Restore(role, backups[role]); } catch { }
      if (ok) changed.RemoveAt(i); else restored = false;
    }
    if (!restored) {
      // Last resort: reload the user's configured scheme, never a hard-coded
      // default. This does not write registry settings.
      if (!api.ResetConfiguredScheme()) throw new System.Exception("input_cleanup_unconfirmed: system cursor restoration failed");
      changed.Clear();
    }
    foreach (System.IntPtr backup in backups.Values) api.Free(backup);
    backups.Clear();
  }
}

public sealed class MixWindowsCursorThemeApi : MixCursorThemeApi {
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  struct ICONINFO {
    [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] public bool icon;
    public uint x; public uint y; public System.IntPtr mask; public System.IntPtr color;
  }
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern System.IntPtr LoadCursor(System.IntPtr instance, System.IntPtr name);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern System.IntPtr CopyImage(System.IntPtr handle, uint type, int width, int height, uint flags);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool SetSystemCursor(System.IntPtr cursor, uint role);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool DestroyCursor(System.IntPtr cursor);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool DestroyIcon(System.IntPtr icon);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool GetIconInfo(System.IntPtr icon, out ICONINFO info);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern System.IntPtr CreateIconIndirect(ref ICONINFO info);
  [System.Runtime.InteropServices.DllImport("gdi32.dll")] static extern bool DeleteObject(System.IntPtr handle);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint parameter, System.IntPtr value, uint flags);
  public System.IntPtr Save(uint role) {
    return CopyImage(LoadCursor(System.IntPtr.Zero, new System.IntPtr((int)role)), 2, 0, 0, 0);
  }
  static System.IntPtr Artwork() {
    int size = System.Math.Min(96, System.Math.Max(40, GetSystemMetrics(13)));
    using (var bitmap = new System.Drawing.Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
    using (var graphics = System.Drawing.Graphics.FromImage(bitmap))
    using (var outline = new System.Drawing.Pen(System.Drawing.Color.White, 1.8f))
    using (var fill = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(255, 0, 155, 235))) {
      graphics.Clear(System.Drawing.Color.Transparent);
      graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
      graphics.ScaleTransform(size / 40f, size / 40f);
      var points = new System.Drawing.PointF[] {
        new System.Drawing.PointF(2,2), new System.Drawing.PointF(28,22),
        new System.Drawing.PointF(16,23), new System.Drawing.PointF(22,35),
        new System.Drawing.PointF(16,38), new System.Drawing.PointF(10,26),
        new System.Drawing.PointF(3,34)
      };
      outline.LineJoin = System.Drawing.Drawing2D.LineJoin.Round;
      graphics.FillPolygon(fill, points); graphics.DrawPolygon(outline, points);
      System.IntPtr icon = bitmap.GetHicon();
      ICONINFO info;
      try {
        if (!GetIconInfo(icon, out info)) throw new System.Exception("cursor artwork unavailable");
        try {
          info.icon = false; info.x = (uint)System.Math.Round(2 * size / 40.0); info.y = info.x;
          return CreateIconIndirect(ref info);
        } finally { DeleteObject(info.mask); DeleteObject(info.color); }
      } finally { DestroyIcon(icon); }
    }
  }
  public void Apply(uint role) {
    System.IntPtr cursor = Artwork();
    if (cursor == System.IntPtr.Zero) throw new System.Exception("cursor artwork unavailable");
    // SetSystemCursor consumes the supplied non-shared cursor handle.
    if (!SetSystemCursor(cursor, role)) throw new System.Exception("cursor replacement unavailable");
  }
  public bool Restore(uint role, System.IntPtr backup) {
    System.IntPtr copy = CopyImage(backup, 2, 0, 0, 0);
    return copy != System.IntPtr.Zero && SetSystemCursor(copy, role);
  }
  public void Free(System.IntPtr backup) { DestroyCursor(backup); }
  public bool ResetConfiguredScheme() { return SystemParametersInfo(0x0057, 0, System.IntPtr.Zero, 0); }
}

public sealed class MixCursorTheme : System.IDisposable {
  readonly System.IO.Pipes.NamedPipeServerStream pipe;
  readonly System.IO.StreamReader reader;
  readonly System.IO.StreamWriter writer;
  bool disposed;
  bool activationRequested;
  bool restorationConfirmed;
  System.Threading.Tasks.Task<string> pendingRead;
  public MixCursorTheme(System.IO.Pipes.NamedPipeServerStream connection) {
    pipe = connection;
    reader = new System.IO.StreamReader(pipe);
    writer = new System.IO.StreamWriter(pipe) { AutoFlush = true };
  }
  static string Quote(string text) { return "'" + text.Replace("'", "''") + "'"; }
  static string Encode(string text) { return System.Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(text)); }
  static string ReadWithin(System.IO.StreamReader input, int milliseconds) {
    var read = input.ReadLineAsync();
    if (!read.Wait(milliseconds)) throw new System.Exception("cursor watchdog response timeout");
    return read.Result;
  }
  string ReadNextWithin(int milliseconds) {
    if (pendingRead == null) pendingRead = reader.ReadLineAsync();
    // A timeout does not start a second concurrent read or discard a late ACK.
    if (!pendingRead.Wait(milliseconds)) throw new System.TimeoutException("cursor watchdog response timeout");
    string result = pendingRead.Result;
    pendingRead = null;
    if (result == "RESTORED") restorationConfirmed = true;
    return result;
  }
  public void Activate(int milliseconds = 5000) {
    if (milliseconds < 1 || milliseconds > 5000) throw new System.ArgumentOutOfRangeException("milliseconds");
    if (disposed || activationRequested) throw new System.InvalidOperationException("cursor activation cannot be replayed");
    if (ReadNextWithin(milliseconds) != "READY") throw new System.Exception("cursor watchdog not ready");
    MixInputObservation.AssertContinue();
    activationRequested = true;
    writer.WriteLine("ACTIVATE");
    if (ReadNextWithin(milliseconds) != "ACTIVE") {
      MixInputObservation.AssertContinue();
      throw new System.Exception("cursor theme could not activate");
    }
    MixInputObservation.AssertContinue();
  }
  public static void LaunchDetachedWatchdog(string program) {
    string powershell = System.IO.Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.System),
      @"WindowsPowerShell\v1.0\powershell.exe");
    string helperCommand = "\"" + powershell + "\" -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + Encode(program);
    // WMI gives the watchdog an independent process tree but cannot accept
    // CREATE_NO_WINDOW. A hidden console supplies the handles PowerShell needs
    // without ever showing or activating its window.
    string launcher = "$s=([wmiclass]'Win32_ProcessStartup').CreateInstance();"
      + "$s.ShowWindow=0; $s.CreateFlags=16;"
      + "$r=([wmiclass]'Win32_Process').Create(" + Quote(helperCommand)
      + ",$null,$s); if($r.ReturnValue -ne 0){exit ([int]$r.ReturnValue)}";
    var info = new System.Diagnostics.ProcessStartInfo(powershell, "-NoProfile -NonInteractive -EncodedCommand " + Encode(launcher));
    info.UseShellExecute = false; info.CreateNoWindow = true;
    using (var launch = System.Diagnostics.Process.Start(info)) {
      if (!launch.WaitForExit(5000)) {
        try { launch.Kill(); launch.WaitForExit(1000); } catch { }
        throw new System.Exception("cursor watchdog launcher timeout");
      }
      if (launch.ExitCode != 0) throw new System.Exception("cursor watchdog launch failed (" + launch.ExitCode + ")");
    }
  }
  public static MixCursorTheme Begin() {
    string assembly = typeof(MixCursorTheme).Assembly.Location;
    if (System.String.IsNullOrEmpty(assembly)) throw new System.Exception("computer_cursor_unavailable: cached native assembly required");
    string name = "mixdog-cursor-" + System.Guid.NewGuid().ToString("N");
    var pipe = new System.IO.Pipes.NamedPipeServerStream(name, System.IO.Pipes.PipeDirection.InOut, 1,
      System.IO.Pipes.PipeTransmissionMode.Byte, System.IO.Pipes.PipeOptions.Asynchronous);
    MixCursorTheme guard = null;
    try {
      int parent = System.Diagnostics.Process.GetCurrentProcess().Id;
      string marker = unchecked((uint)MixInputObservation.Marker.ToInt64()).ToString(System.Globalization.CultureInfo.InvariantCulture);
      string helper = "$ErrorActionPreference='Stop'; $env:MIXDOG_COMPUTER_INPUT_MARKER=" + Quote(marker)
        + "; Add-Type -AssemblyName System.Drawing; [void][Reflection.Assembly]::LoadFrom(" + Quote(assembly)
        + "); [MixCursorTheme]::Watch(" + parent + "," + Quote(name) + ")";
      LaunchDetachedWatchdog(helper);
      var connected = pipe.BeginWaitForConnection(null, null);
      try {
        if (!connected.AsyncWaitHandle.WaitOne(5000)) throw new System.Exception("cursor watchdog connection timeout");
        pipe.EndWaitForConnection(connected);
      } finally { connected.AsyncWaitHandle.Close(); }
      guard = new MixCursorTheme(pipe);
      guard.Activate();
      return guard;
    } catch (System.Exception error) {
      // Closing the pipe makes the independent helper restore, even if the
      // activation acknowledgement was lost.
      if (guard != null && guard.activationRequested) guard.Dispose();
      else pipe.Dispose();
      if (guard != null && guard.activationRequested) MixInputObservation.AssertContinue();
      if (error.Message.StartsWith("user_input_active:") || error.Message.StartsWith("input_observation_unavailable:")) throw;
      throw new System.Exception("computer_cursor_unavailable: theme activation was not confirmed; no input sent");
    }
  }
  public void Dispose() {
    if (disposed) return;
    disposed = true;
    try {
      if (restorationConfirmed) return;
      try { writer.WriteLine("END"); } catch (System.IO.IOException) { /* The helper may already have restored after user input. */ }
      var clock = System.Diagnostics.Stopwatch.StartNew();
      string result = ReadNextWithin(5000);
      if (result == "ACTIVE") result = ReadNextWithin((int)System.Math.Max(1, 5000 - clock.ElapsedMilliseconds));
      if (result != "RESTORED") throw new System.Exception("cursor restoration not confirmed");
    } catch {
      throw new System.Exception("input_cleanup_unconfirmed: cursor watchdog did not confirm restoration");
    } finally { pipe.Dispose(); }
  }
  public static void Watch(int parentPid, string pipeName) {
    using (var mutex = new System.Threading.Mutex(false, @"Local\MixdogCursorTheme"))
    using (var parent = System.Diagnostics.Process.GetProcessById(parentPid))
    using (var pipe = new System.IO.Pipes.NamedPipeClientStream(".", pipeName, System.IO.Pipes.PipeDirection.InOut,
      System.IO.Pipes.PipeOptions.Asynchronous)) {
      bool owns = false;
      try {
        try { owns = mutex.WaitOne(0); } catch (System.Threading.AbandonedMutexException) { owns = true; }
        if (!owns) return;
        pipe.Connect(5000);
        using (var reader = new System.IO.StreamReader(pipe))
        using (var writer = new System.IO.StreamWriter(pipe) { AutoFlush = true }) {
          var baseline = MixInputObservation.Read();
          if (!baseline.Ready || !MixInputObservation.IdleDesktopReady()) return;
          writer.WriteLine("READY");
          if (ReadWithin(reader, 5000) != "ACTIVATE" || parent.HasExited) return;
          MixCursorThemeLease lease = null;
          bool restored = false;
          try {
            lease = new MixCursorThemeLease(new MixWindowsCursorThemeApi(), new uint[] { 32512, 32513, 32515, 32649 });
            lease.Activate();
            writer.WriteLine("ACTIVE");
            var command = reader.ReadLineAsync();
            var clock = System.Diagnostics.Stopwatch.StartNew();
            while (!command.IsCompleted && !parent.HasExited && clock.ElapsedMilliseconds < 60000) {
              var current = MixInputObservation.Read();
              if (!current.Ready || current.Sequence != baseline.Sequence || !MixInputObservation.IdleDesktopReady()) break;
              System.Threading.Thread.Sleep(25);
            }
          } finally {
            if (lease != null) {
              for (int attempt = 0; attempt < 3 && !restored; attempt++) {
                try { lease.Dispose(); restored = true; } catch { System.Threading.Thread.Sleep(50); }
              }
            } else restored = true;
            try { writer.WriteLine(restored ? "RESTORED" : "RESTORE_FAILED"); } catch { }
          }
        }
      } finally { if (owns) mutex.ReleaseMutex(); }
    }
  }
}
