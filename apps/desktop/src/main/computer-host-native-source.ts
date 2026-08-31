/**
 * The C# the resident PowerShell host compiles once per build: Win32 input and
 * window interop, the MSAA node wrapper, and the screen-region capture. Kept
 * apart from the PowerShell that loads it so each file reads as one language.
 */
export const MIXDOG_HOST_CSHARP = String.raw`using System;
using Accessibility;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public sealed class MixMsaaNode {
  internal readonly IAccessible Accessible;
  internal readonly object ChildId;
  public string Key { get; private set; }
  public string WindowId { get; private set; }
  public string Name { get; private set; }
  public string Value { get; private set; }
  public string Description { get; private set; }
  public string Role { get; private set; }
  public string State { get; private set; }
  public string DefaultAction { get; private set; }
  public string ControlType { get; private set; }
  public int X { get; private set; }
  public int Y { get; private set; }
  public int Width { get; private set; }
  public int Height { get; private set; }
  public bool Enabled { get; private set; }
  public bool Offscreen { get; private set; }

  internal MixMsaaNode(IAccessible accessible, object childId, string key, string windowId) {
    Accessible = accessible;
    ChildId = childId;
    Key = key;
    WindowId = windowId;
    Name = Value = Description = Role = State = DefaultAction = "";
    ControlType = "Custom";
  }

  static string Read(Func<string> getter) {
    try { return getter() ?? ""; } catch { return ""; }
  }

  static uint ReadUInt(Func<object> getter) {
    try {
      object value = getter();
      return value == null ? 0u : Convert.ToUInt32(value, CultureInfo.InvariantCulture);
    } catch {
      return 0u;
    }
  }

  public bool Refresh() {
    try {
      int x = 0, y = 0, width = 0, height = 0;
      Accessible.accLocation(out x, out y, out width, out height, ChildId);
      X = x; Y = y; Width = Math.Max(0, width); Height = Math.Max(0, height);
      Name = Read(() => Accessible.get_accName(ChildId));
      Value = Read(() => Accessible.get_accValue(ChildId));
      Description = Read(() => Accessible.get_accDescription(ChildId));
      uint role = ReadUInt(() => Accessible.get_accRole(ChildId));
      uint state = ReadUInt(() => Accessible.get_accState(ChildId));
      Role = MixMsaa.RoleText(role);
      State = MixMsaa.StateText(state);
      DefaultAction = Read(() => Accessible.get_accDefaultAction(ChildId));
      ControlType = MixMsaa.ControlTypeForRole(role);
      Enabled = (state & 0x1u) == 0;
      Offscreen = (state & (0x8000u | 0x10000u)) != 0;
      return Width > 0 && Height > 0;
    } catch {
      return false;
    }
  }

  public string ObservableState() {
    if (!Refresh()) return "";
    return "value=" + Value + "|state=" + State;
  }

  public void DoDefaultAction() {
    if (!Refresh()) throw new InvalidOperationException("MSAA element is stale");
    if (String.IsNullOrWhiteSpace(DefaultAction)) {
      throw new InvalidOperationException("MSAA element exposes no default action");
    }
    Accessible.accDoDefaultAction(ChildId);
    Refresh();
  }

  public string SetValue(string value) {
    if (!Refresh()) throw new InvalidOperationException("MSAA element is stale");
    Accessible.set_accValue(ChildId, value ?? "");
    Refresh();
    return Value;
  }
}

public static class MixMsaa {
  const uint OBJID_CLIENT = unchecked((uint)-4);
  static readonly Guid IID_IAccessible = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
  [DllImport("oleacc.dll")]
  static extern int AccessibleObjectFromWindow(
    IntPtr hwnd,
    uint objectId,
    ref Guid interfaceId,
    [MarshalAs(UnmanagedType.Interface)] out object accessible);
  [DllImport("oleacc.dll")]
  static extern int AccessibleChildren(
    [MarshalAs(UnmanagedType.Interface)] IAccessible container,
    int childStart,
    int childCount,
    [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] object[] children,
    out int obtained);
  [DllImport("oleacc.dll", CharSet = CharSet.Unicode)]
  static extern uint GetRoleTextW(uint role, StringBuilder text, uint maximum);
  [DllImport("oleacc.dll", CharSet = CharSet.Unicode)]
  static extern uint GetStateTextW(uint state, StringBuilder text, uint maximum);

  static long Identity(object value) {
    IntPtr unknown = Marshal.GetIUnknownForObject(value);
    try { return unknown.ToInt64(); } finally { Marshal.Release(unknown); }
  }

  static void Traverse(
    IAccessible accessible,
    string path,
    string windowId,
    List<MixMsaaNode> result,
    HashSet<long> visited,
    int maximum,
    int depth,
    bool includeSelf) {
    if (depth > 64) throw new InvalidOperationException("MSAA tree depth exceeds 64");
    long identity = Identity(accessible);
    if (!visited.Add(identity)) return;
    if (includeSelf) {
      if (result.Count >= maximum) return;
      MixMsaaNode node = new MixMsaaNode(accessible, 0, path, windowId);
      if (node.Refresh()) result.Add(node);
    }
    int count;
    try { count = Math.Max(0, accessible.accChildCount); } catch { return; }
    if (count == 0) return;
    int childStart = 0;
    while (childStart < count && result.Count < maximum) {
      int requested = Math.Min(256, count - childStart);
      object[] children = new object[requested];
      int obtained;
      int hr = AccessibleChildren(accessible, childStart, requested, children, out obtained);
      if (hr < 0) Marshal.ThrowExceptionForHR(hr);
      int returned = Math.Min(Math.Max(0, obtained), children.Length);
      if (returned == 0) break;
      for (int index = 0; index < returned; index++) {
        if (result.Count >= maximum) break;
        object child = children[index];
        IAccessible nested = child as IAccessible;
        int childIndex = childStart + index;
        string childPath = path + "/" + childIndex.ToString(CultureInfo.InvariantCulture);
        if (nested != null) {
          Traverse(nested, childPath, windowId, result, visited, maximum, depth + 1, true);
          continue;
        }
        int childId;
        try { childId = Convert.ToInt32(child, CultureInfo.InvariantCulture); } catch { continue; }
        MixMsaaNode simple = new MixMsaaNode(accessible, childId, childPath, windowId);
        if (simple.Refresh()) result.Add(simple);
      }
      childStart += returned;
    }
  }

  public static MixMsaaNode[] Snapshot(IntPtr hwnd, string windowId, int maximum) {
    if (hwnd == IntPtr.Zero) throw new ArgumentException("MSAA window handle is required");
    if (maximum < 1 || maximum > 5000) throw new ArgumentOutOfRangeException("maximum");
    object raw;
    Guid iid = IID_IAccessible;
    int hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, ref iid, out raw);
    if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    IAccessible root = raw as IAccessible;
    if (root == null) return new MixMsaaNode[0];
    List<MixMsaaNode> result = new List<MixMsaaNode>();
    Traverse(root, "0", windowId ?? "", result, new HashSet<long>(), maximum, 0, false);
    return result.ToArray();
  }

  public static string RoleText(uint role) {
    StringBuilder text = new StringBuilder(128);
    return GetRoleTextW(role, text, (uint)text.Capacity) > 0
      ? text.ToString()
      : role.ToString(CultureInfo.InvariantCulture);
  }

  public static string StateText(uint state) {
    if (state == 0) return "normal";
    List<string> parts = new List<string>();
    for (int bit = 0; bit < 32; bit++) {
      uint flag = 1u << bit;
      if ((state & flag) == 0) continue;
      StringBuilder text = new StringBuilder(128);
      if (GetStateTextW(flag, text, (uint)text.Capacity) > 0) parts.Add(text.ToString());
      else parts.Add("0x" + flag.ToString("X", CultureInfo.InvariantCulture));
    }
    return String.Join(",", parts.ToArray());
  }

  public static string ControlTypeForRole(uint role) {
    switch (role) {
      case 0x09: return "Window";
      case 0x0A: return "Client";
      case 0x0B: return "Menu";
      case 0x0C: return "MenuItem";
      case 0x0F: return "Document";
      case 0x10: return "Pane";
      case 0x21: return "List";
      case 0x22: return "ListItem";
      case 0x23: return "Tree";
      case 0x24: return "TreeItem";
      case 0x25: return "Tab";
      case 0x26: return "TabItem";
      case 0x27: return "Group";
      case 0x29: return "Text";
      case 0x2A: return "Edit";
      case 0x2B: return "Button";
      case 0x2C: return "CheckBox";
      case 0x2D: return "RadioButton";
      case 0x2E: return "ComboBox";
      case 0x30: return "ProgressBar";
      case 0x33: return "Slider";
      case 0x34: return "Spinner";
      case 0x3E: return "SplitButton";
      default: return "Custom";
    }
  }
}

public class MixWin32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int height, bool repaint);
  [DllImport("user32.dll")] static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(
    IntPtr token, int informationClass, IntPtr information, int informationLength, out int returnLength);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  public delegate bool EnumWindowProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumWindowProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint command);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out RECT value, int size);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES {
    public IntPtr Sid;
    public uint Attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL {
    public SID_AND_ATTRIBUTES Label;
  }
  public sealed class WindowInfo {
    public IntPtr Handle;
    public string Id = "";
    public string Title = "";
    public string ClassName = "";
    public string App = "";
    public uint Pid;
    public string OwnerId = "";
    public bool Visible;
    public bool Focused;
    public bool Minimized;
    public bool Maximized;
    public int X, Y, Width, Height;
    public int ClientX, ClientY, ClientWidth, ClientHeight;
  }
  public sealed class WindowCaptureInfo {
    public string PngBase64 = "";
    public int X, Y, Width, Height, VisibleSamples;
  }
  public sealed class WindowIntegrityInfo {
    public bool Known, Higher;
    public int OwnRid, TargetRid;
    public string OwnName = "";
    public string TargetName = "";
  }
  static int ProcessIntegrityRid(IntPtr process) {
    const uint TOKEN_QUERY = 0x0008;
    const int TokenIntegrityLevel = 25;
    IntPtr token;
    if (process == IntPtr.Zero || !OpenProcessToken(process, TOKEN_QUERY, out token)) return 0;
    try {
      int required = 0;
      GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out required);
      if (required <= 0) return 0;
      IntPtr buffer = Marshal.AllocHGlobal(required);
      try {
        if (!GetTokenInformation(token, TokenIntegrityLevel, buffer, required, out required)) return 0;
        TOKEN_MANDATORY_LABEL label =
          (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(buffer, typeof(TOKEN_MANDATORY_LABEL));
        IntPtr countPointer = GetSidSubAuthorityCount(label.Label.Sid);
        if (countPointer == IntPtr.Zero) return 0;
        byte count = Marshal.ReadByte(countPointer);
        if (count == 0) return 0;
        IntPtr ridPointer = GetSidSubAuthority(label.Label.Sid, (uint)(count - 1));
        return ridPointer == IntPtr.Zero ? 0 : Marshal.ReadInt32(ridPointer);
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    } finally {
      CloseHandle(token);
    }
  }
  static string IntegrityName(int rid) {
    if (rid >= 0x4000) return "System";
    if (rid >= 0x3000) return "High";
    if (rid >= 0x2100) return "Medium+";
    if (rid >= 0x2000) return "Medium";
    if (rid >= 0x1000) return "Low";
    return rid > 0 ? "Untrusted" : "Unknown";
  }
  public static WindowIntegrityInfo WindowIntegrity(IntPtr h) {
    int ownRid = ProcessIntegrityRid(GetCurrentProcess());
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    IntPtr targetProcess = pid == 0 ? IntPtr.Zero : OpenProcess(0x1000, false, pid);
    int targetRid = 0;
    if (targetProcess != IntPtr.Zero) {
      try { targetRid = ProcessIntegrityRid(targetProcess); }
      finally { CloseHandle(targetProcess); }
    }
    return new WindowIntegrityInfo {
      Known = ownRid > 0 && targetRid > 0,
      Higher = ownRid > 0 && targetRid > ownRid,
      OwnRid = ownRid,
      TargetRid = targetRid,
      OwnName = IntegrityName(ownRid),
      TargetName = IntegrityName(targetRid)
    };
  }
  // A window rect includes the invisible resize border, so a screen-region grab
  // taken from it reads pixels belonging to whatever sits behind the window.
  // DWM reports the window's visible rectangle, which is what a capture means.
  static bool TryVisibleWindowBounds(IntPtr h, out RECT bounds) {
    RECT extended;
    if (DwmGetWindowAttribute(h, 9, out extended, Marshal.SizeOf(typeof(RECT))) == 0
      && extended.right > extended.left
      && extended.bottom > extended.top) {
      bounds = extended;
      return true;
    }
    return GetWindowRect(h, out bounds);
  }
  public static WindowCaptureInfo CaptureVisibleWindow(IntPtr h) {
    if (!IsWindowHandle(h)) {
      throw new InvalidOperationException("capture_source_unavailable|exact native window is stale or invalid");
    }
    if (IsIconic(h)) {
      throw new InvalidOperationException("capture_source_unavailable|minimized native window has no visible pixels");
    }
    RECT bounds;
    if (!TryVisibleWindowBounds(h, out bounds)) {
      throw new InvalidOperationException("capture_source_unavailable|could not read exact native window bounds");
    }
    int width = bounds.right - bounds.left;
    int height = bounds.bottom - bounds.top;
    if (width <= 0 || height <= 0) {
      throw new InvalidOperationException("capture_source_unavailable|exact native window has empty bounds");
    }
    int insetX = Math.Max(4, width / 6);
    int insetY = Math.Max(4, height / 6);
    POINT[] samples = new POINT[] {
      new POINT { x = bounds.left + width / 2, y = bounds.top + height / 2 },
      new POINT { x = bounds.left + insetX, y = bounds.top + height / 2 },
      new POINT { x = bounds.right - insetX, y = bounds.top + height / 2 },
      new POINT { x = bounds.left + width / 2, y = bounds.top + insetY },
      new POINT { x = bounds.left + width / 2, y = bounds.bottom - insetY }
    };
    int visibleSamples = 0;
    foreach (POINT sample in samples) {
      if (WindowAtPoint(sample.x, sample.y) == h) visibleSamples++;
    }
    if (visibleSamples < 3) {
      throw new InvalidOperationException(
        "capture_occluded|exact native window is not topmost at enough sampled points");
    }
    using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
    using (Graphics graphics = Graphics.FromImage(bitmap))
    using (MemoryStream stream = new MemoryStream()) {
      graphics.CopyFromScreen(
        bounds.left,
        bounds.top,
        0,
        0,
        new Size(width, height),
        CopyPixelOperation.SourceCopy);
      bitmap.Save(stream, ImageFormat.Png);
      return new WindowCaptureInfo {
        PngBase64 = Convert.ToBase64String(stream.ToArray()),
        X = bounds.left,
        Y = bounds.top,
        Width = width,
        Height = height,
        VisibleSamples = visibleSamples
      };
    }
  }
  static string Text(IntPtr h) {
    StringBuilder s = new StringBuilder(1024);
    GetWindowText(h, s, s.Capacity);
    return s.ToString();
  }
  static string ClassNameOf(IntPtr h) {
    StringBuilder s = new StringBuilder(256);
    GetClassName(h, s, s.Capacity);
    return s.ToString();
  }
  public static string WindowId(IntPtr h) { return "hwnd:0x" + h.ToInt64().ToString("X"); }
  public static IntPtr ParseWindowId(string value) {
    if (String.IsNullOrWhiteSpace(value)) return IntPtr.Zero;
    string raw = value.Trim();
    if (raw.StartsWith("hwnd:", StringComparison.OrdinalIgnoreCase)) raw = raw.Substring(5);
    if (raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) raw = raw.Substring(2);
    long parsed;
    return Int64.TryParse(raw, System.Globalization.NumberStyles.HexNumber, null, out parsed)
      ? new IntPtr(parsed) : IntPtr.Zero;
  }
  public static bool IsWindowHandle(IntPtr h) { return h != IntPtr.Zero && IsWindow(h); }
  public static bool IsOwnedBy(IntPtr candidate, IntPtr expectedOwner) {
    if (!IsWindowHandle(candidate) || !IsWindowHandle(expectedOwner) || candidate == expectedOwner) return false;
    HashSet<IntPtr> visited = new HashSet<IntPtr>();
    IntPtr current = candidate;
    while (current != IntPtr.Zero && visited.Add(current)) {
      current = GetWindow(current, 4);
      if (current == expectedOwner) return true;
    }
    return false;
  }
  public static bool SharesProcess(IntPtr first, IntPtr second) {
    if (!IsWindowHandle(first) || !IsWindowHandle(second)) return false;
    uint firstPid, secondPid;
    GetWindowThreadProcessId(first, out firstPid);
    GetWindowThreadProcessId(second, out secondPid);
    return firstPid != 0 && firstPid == secondPid;
  }
  public static bool IsContainedSameProcess(IntPtr candidate, IntPtr expectedSurface) {
    if (!SharesProcess(candidate, expectedSurface)) return false;
    RECT candidateBounds, surfaceBounds;
    if (!GetWindowRect(candidate, out candidateBounds)
        || !GetWindowRect(expectedSurface, out surfaceBounds)) return false;
    return candidateBounds.right > candidateBounds.left
      && candidateBounds.bottom > candidateBounds.top
      && candidateBounds.left >= surfaceBounds.left
      && candidateBounds.top >= surfaceBounds.top
      && candidateBounds.right <= surfaceBounds.right
      && candidateBounds.bottom <= surfaceBounds.bottom;
  }
  public static WindowInfo Info(IntPtr h) {
    return Info(h, true);
  }
  static WindowInfo Info(IntPtr h, bool includeApp) {
    if (!IsWindowHandle(h)) return null;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    RECT r;
    GetWindowRect(h, out r);
    RECT client;
    POINT clientOrigin = new POINT();
    bool hasClient = GetClientRect(h, out client) && ClientToScreen(h, ref clientOrigin);
    IntPtr owner = GetWindow(h, 4);
    string app = "";
    if (includeApp) {
      try { app = Process.GetProcessById((int)pid).ProcessName; } catch {}
    }
    return new WindowInfo {
      Handle = h,
      Id = WindowId(h),
      Title = Text(h),
      ClassName = ClassNameOf(h),
      App = app,
      Pid = pid,
      OwnerId = owner == IntPtr.Zero ? "" : WindowId(owner),
      Visible = IsWindowVisible(h),
      Focused = GetForegroundWindow() == h,
      Minimized = IsIconic(h),
      Maximized = IsZoomed(h),
      X = r.left,
      Y = r.top,
      Width = Math.Max(0, r.right - r.left),
      Height = Math.Max(0, r.bottom - r.top),
      ClientX = hasClient ? clientOrigin.x : r.left,
      ClientY = hasClient ? clientOrigin.y : r.top,
      ClientWidth = hasClient ? Math.Max(0, client.right - client.left) : Math.Max(0, r.right - r.left),
      ClientHeight = hasClient ? Math.Max(0, client.bottom - client.top) : Math.Max(0, r.bottom - r.top)
    };
  }
  public static WindowInfo[] Windows() {
    List<WindowInfo> result = new List<WindowInfo>();
    Dictionary<uint, string> apps = new Dictionary<uint, string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      WindowInfo info = Info(h, false);
      if (info != null && info.Visible && info.Width > 0 && info.Height > 0) {
        string app;
        if (!apps.TryGetValue(info.Pid, out app)) {
          app = "";
          try { app = Process.GetProcessById((int)info.Pid).ProcessName; } catch {}
          apps[info.Pid] = app;
        }
        info.App = app;
        result.Add(info);
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  public static WindowInfo[] WindowSnapshot() {
    List<WindowInfo> result = new List<WindowInfo>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      WindowInfo info = Info(h, false);
      if (info != null && info.Visible && info.Width > 0 && info.Height > 0) result.Add(info);
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  public static string[] RelatedWindowIds(IntPtr target) {
    if (!IsWindowHandle(target)) return new string[0];
    List<string> result = new List<string>();
    result.Add(WindowId(target));
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (h != target && IsWindowVisible(h) && IsOwnedBy(h, target)) {
        result.Add(WindowId(h));
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  public static bool IsMinimized(IntPtr h) { return IsWindowHandle(h) && IsIconic(h); }
  public static bool IsMaximized(IntPtr h) { return IsWindowHandle(h) && IsZoomed(h); }
  public static bool CloseWindow(IntPtr h) {
    if (!IsWindowHandle(h)) return false;
    SendMessageChecked(h, 0x0010, UIntPtr.Zero, IntPtr.Zero);
    return true;
  }
  public static IntPtr[] ChildHandles(IntPtr parent) {
    List<IntPtr> result = new List<IntPtr>();
    EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h)) result.Add(h);
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr h, POINT p, uint flags);
  [DllImport("user32.dll", SetLastError = true, EntryPoint = "SendMessageTimeoutW")]
  static extern IntPtr SendMessageTimeout(
    IntPtr h, uint message, UIntPtr wParam, IntPtr lParam,
    uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public uint cbSize;
    public uint flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  const uint SMTO_BLOCK = 0x1, SMTO_ABORTIFHUNG = 0x2;
  const uint WM_GETTEXT = 0x000D, WM_GETTEXTLENGTH = 0x000E, BM_GETCHECK = 0x00F0;
  const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102;
  const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
  const uint WM_LBUTTONDBLCLK = 0x0203, WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
  const uint WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208, WM_MOUSEWHEEL = 0x020A, WM_MOUSEHWHEEL = 0x020E;
  const uint MK_LBUTTON = 0x1, MK_RBUTTON = 0x2, MK_SHIFT = 0x4, MK_CONTROL = 0x8, MK_MBUTTON = 0x10;
  static UIntPtr SendMessageValue(IntPtr h, uint message, UIntPtr wParam, IntPtr lParam) {
    UIntPtr result;
    IntPtr sent = SendMessageTimeout(
      h, message, wParam, lParam, SMTO_BLOCK | SMTO_ABORTIFHUNG, 1000, out result);
    if (sent == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error == 0 || error == 1460) {
        throw new InvalidOperationException("background_target_hung|native window message timed out");
      }
      if (error == 5) {
        throw new InvalidOperationException("background_blocked_uipi|Windows integrity isolation blocked the native message");
      }
      throw new InvalidOperationException(
        "background_message_rejected|native window message failed with Win32 error " + error);
    }
    return result;
  }
  static void SendMessageChecked(IntPtr h, uint message, UIntPtr wParam, IntPtr lParam) {
    SendMessageValue(h, message, wParam, lParam);
  }
  static bool BelongsToTop(IntPtr top, IntPtr candidate) {
    if (!IsWindowHandle(top) || !IsWindowHandle(candidate)) return false;
    if (candidate != top && GetAncestor(candidate, 2) != top) return false;
    uint topPid, candidatePid;
    GetWindowThreadProcessId(top, out topPid);
    GetWindowThreadProcessId(candidate, out candidatePid);
    return topPid != 0 && topPid == candidatePid;
  }
  static IntPtr PointParam(int x, int y) {
    int packed = ((y & 0xFFFF) << 16) | (x & 0xFFFF);
    return new IntPtr(packed);
  }
  static POINT ClientPoint(IntPtr target, int screenX, int screenY) {
    POINT p = new POINT(); p.x = screenX; p.y = screenY;
    if (!ScreenToClient(target, ref p)) {
      throw new InvalidOperationException("background_message_rejected|could not map point into target window");
    }
    return p;
  }
  static IntPtr MessageTargetAtPoint(IntPtr top, int screenX, int screenY) {
    if (!IsWindowHandle(top)) {
      throw new InvalidOperationException("stale_target|native message target is stale or invalid");
    }
    RECT bounds;
    if (!GetWindowRect(top, out bounds)
        || screenX < bounds.left || screenX >= bounds.right
        || screenY < bounds.top || screenY >= bounds.bottom) {
      throw new InvalidOperationException("target_mismatch|native message point is outside the exact target window");
    }
    IntPtr current = top;
    for (int depth = 0; depth < 32; depth++) {
      POINT p = ClientPoint(current, screenX, screenY);
      IntPtr child = ChildWindowFromPointEx(current, p, 0x1 | 0x2 | 0x4);
      if (child == IntPtr.Zero || child == current || !BelongsToTop(top, child)) break;
      current = child;
    }
    return current;
  }
  static uint PointerModifiers(string modifiers) {
    uint flags = 0;
    if (String.IsNullOrWhiteSpace(modifiers)) return flags;
    foreach (string raw in modifiers.ToLowerInvariant().Split('+')) {
      string part = raw.Trim();
      if (part == "ctrl") flags |= MK_CONTROL;
      else if (part == "shift") flags |= MK_SHIFT;
      else if (part.Length != 0) {
        throw new InvalidOperationException(
          "background_unsupported|background pointer messages support only ctrl/shift modifiers; use explicit foreground delivery for " + part);
      }
    }
    return flags;
  }
  static void MouseClick(IntPtr target, IntPtr point, uint modifiers, uint down, uint up, uint button) {
    SendMessageChecked(target, down, new UIntPtr(modifiers | button), point);
    SendMessageChecked(target, up, new UIntPtr(modifiers), point);
  }
  public static string BackgroundPointer(
    IntPtr top, int screenX, int screenY, string kind, string modifiers) {
    IntPtr target = MessageTargetAtPoint(top, screenX, screenY);
    POINT p = ClientPoint(target, screenX, screenY);
    IntPtr point = PointParam(p.x, p.y);
    uint flags = PointerModifiers(modifiers);
    SendMessageChecked(target, WM_MOUSEMOVE, new UIntPtr(flags), point);
    string action = (kind ?? "").ToLowerInvariant();
    if (action == "move") return WindowId(target);
    if (action == "right") {
      MouseClick(target, point, flags, WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON);
      return WindowId(target);
    }
    if (action == "middle") {
      MouseClick(target, point, flags, WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON);
      return WindowId(target);
    }
    if (action != "click" && action != "double" && action != "triple") {
      throw new InvalidOperationException("background_unsupported|unknown background pointer action: " + kind);
    }
    MouseClick(target, point, flags, WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON);
    if (action == "double" || action == "triple") {
      System.Threading.Thread.Sleep(20);
      MouseClick(target, point, flags, WM_LBUTTONDBLCLK, WM_LBUTTONUP, MK_LBUTTON);
    }
    if (action == "triple") {
      System.Threading.Thread.Sleep(20);
      MouseClick(target, point, flags, WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON);
    }
    return WindowId(target);
  }
  public static string BackgroundDrag(
    IntPtr top, int screenX1, int screenY1, int screenX2, int screenY2, string modifiers) {
    IntPtr target = MessageTargetAtPoint(top, screenX1, screenY1);
    MessageTargetAtPoint(top, screenX2, screenY2);
    POINT start = ClientPoint(target, screenX1, screenY1);
    uint flags = PointerModifiers(modifiers);
    SendMessageChecked(target, WM_MOUSEMOVE, new UIntPtr(flags), PointParam(start.x, start.y));
    SendMessageChecked(target, WM_LBUTTONDOWN, new UIntPtr(flags | MK_LBUTTON), PointParam(start.x, start.y));
    for (int step = 1; step <= 12; step++) {
      int x = screenX1 + (screenX2 - screenX1) * step / 12;
      int y = screenY1 + (screenY2 - screenY1) * step / 12;
      POINT p = ClientPoint(target, x, y);
      SendMessageChecked(target, WM_MOUSEMOVE, new UIntPtr(flags | MK_LBUTTON), PointParam(p.x, p.y));
    }
    POINT end = ClientPoint(target, screenX2, screenY2);
    SendMessageChecked(target, WM_LBUTTONUP, new UIntPtr(flags), PointParam(end.x, end.y));
    return WindowId(target);
  }
  public static string BackgroundWheel(
    IntPtr top, int screenX, int screenY, int clicks, string modifiers) {
    return BackgroundWheel(top, screenX, screenY, clicks, modifiers, false);
  }
  public static string BackgroundWheel(
    IntPtr top, int screenX, int screenY, int clicks, string modifiers, bool horizontal) {
    IntPtr target = MessageTargetAtPoint(top, screenX, screenY);
    uint flags = PointerModifiers(modifiers);
    POINT client = ClientPoint(target, screenX, screenY);
    SendMessageChecked(target, WM_MOUSEMOVE, new UIntPtr(flags), PointParam(client.x, client.y));
    int delta = Math.Max(-12000, Math.Min(12000, clicks * 120));
    uint packed = ((uint)(delta & 0xFFFF) << 16) | flags;
    SendMessageChecked(target, horizontal ? WM_MOUSEHWHEEL : WM_MOUSEWHEEL, new UIntPtr(packed), PointParam(screenX, screenY));
    return WindowId(target);
  }
  static IntPtr KeyboardTarget(IntPtr top, IntPtr preferred) {
    if (!IsWindowHandle(top)) {
      throw new InvalidOperationException("stale_target|background keyboard target is stale or invalid");
    }
    if (preferred != IntPtr.Zero) {
      if (!BelongsToTop(top, preferred)) {
        throw new InvalidOperationException("target_mismatch|background keyboard ref belongs to a different window");
      }
      return preferred;
    }
    uint thread = GetWindowThreadProcessId(top, IntPtr.Zero);
    GUITHREADINFO info = new GUITHREADINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
    if (thread != 0 && GetGUIThreadInfo(thread, ref info) && BelongsToTop(top, info.hwndFocus)) {
      return info.hwndFocus;
    }
    return top;
  }
  public static ushort NamedVirtualKey(string name) {
    switch (name) {
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
    }
    if (name.Length >= 2 && name[0] == 'F') {
      int number;
      if (Int32.TryParse(name.Substring(1), out number) && number >= 1 && number <= 24) {
        return (ushort)(0x6F + number);
      }
    }
    throw new InvalidOperationException("background_unsupported|background keyboard does not support key token {" + name + "}");
  }
  static bool IsExtendedVirtualKey(ushort vk) {
    return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24
      || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28
      || vk == 0x2D || vk == 0x2E;
  }
  static void BackgroundVirtualKey(IntPtr target, ushort vk) {
    uint scan = MapVirtualKey(vk, 0);
    int state = 1 | ((int)scan << 16) | (IsExtendedVirtualKey(vk) ? 1 << 24 : 0);
    SendMessageChecked(target, WM_KEYDOWN, new UIntPtr(vk), new IntPtr(state));
    int released = state | unchecked((int)0xC0000000);
    SendMessageChecked(target, WM_KEYUP, new UIntPtr(vk), new IntPtr(released));
  }
  static void BackgroundChar(IntPtr target, char value) {
    SendMessageChecked(target, WM_CHAR, new UIntPtr(value), new IntPtr(1));
  }
  public static string BackgroundText(IntPtr top, IntPtr preferred, string text) {
    IntPtr target = KeyboardTarget(top, preferred);
    string value = text ?? "";
    foreach (char ch in value) {
      if (ch == '\n') BackgroundVirtualKey(target, 0x0D);
      else if (ch != '\r') BackgroundChar(target, ch);
    }
    return WindowId(target);
  }
  public static string BackgroundKeys(IntPtr top, IntPtr preferred, string keys) {
    IntPtr target = KeyboardTarget(top, preferred);
    string value = keys ?? "";
    for (int index = 0; index < value.Length; index++) {
      char ch = value[index];
      if (ch == '\r' || ch == '\n') {
        if (ch == '\r' && index + 1 < value.Length && value[index + 1] == '\n') index++;
        BackgroundVirtualKey(target, 0x0D);
        continue;
      }
      if (ch == '{') {
        if (index + 2 < value.Length && value.Substring(index, 3) == "{{}") {
          BackgroundChar(target, '{'); index += 2; continue;
        }
        if (index + 2 < value.Length && value.Substring(index, 3) == "{}}") {
          BackgroundChar(target, '}'); index += 2; continue;
        }
        int end = value.IndexOf('}', index + 1);
        if (end < 0) {
          throw new InvalidOperationException("background_unsupported|unclosed background key token");
        }
        string token = value.Substring(index + 1, end - index - 1).Trim().ToUpperInvariant();
        int repeat = 1;
        int space = token.LastIndexOf(' ');
        if (space > 0) {
          int parsed;
          if (Int32.TryParse(token.Substring(space + 1), out parsed) && parsed >= 1 && parsed <= 100) {
            repeat = parsed;
            token = token.Substring(0, space);
          }
        }
        ushort vk = NamedVirtualKey(token);
        for (int count = 0; count < repeat; count++) BackgroundVirtualKey(target, vk);
        index = end;
        continue;
      }
      if ("^%+~()".IndexOf(ch) >= 0) {
        throw new InvalidOperationException(
          "background_unsupported|background keyboard does not support SendKeys modifiers/groups; use explicit foreground delivery");
      }
      BackgroundChar(target, ch);
    }
    return WindowId(target);
  }
  public static string NativeObservableState(IntPtr target, string action) {
    if (!IsWindowHandle(target)) return "";
    string className = ClassNameOf(target).ToUpperInvariant();
    string normalized = (action ?? "").ToLowerInvariant();
    if ((normalized == "key" || normalized == "type") && className.Contains("EDIT")) {
      UIntPtr rawLength = SendMessageValue(
        target, WM_GETTEXTLENGTH, UIntPtr.Zero, IntPtr.Zero);
      int length = (int)Math.Min(32768UL, rawLength.ToUInt64());
      IntPtr buffer = Marshal.AllocHGlobal((length + 1) * 2);
      try {
        for (int offset = 0; offset < (length + 1) * 2; offset++) {
          Marshal.WriteByte(buffer, offset, 0);
        }
        SendMessageValue(target, WM_GETTEXT, new UIntPtr((uint)(length + 1)), buffer);
        return "native_text=" + (Marshal.PtrToStringUni(buffer) ?? "");
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
    if ((normalized == "click" || normalized == "double_click"
        || normalized == "right_click" || normalized == "middle_click"
        || normalized == "triple_click") && className.Contains("BUTTON")) {
      UIntPtr check = SendMessageValue(target, BM_GETCHECK, UIntPtr.Zero, IntPtr.Zero);
      return "native_check=" + check.ToUInt64();
    }
    return "";
  }
  // SetForegroundWindow from a background process is refused by the Windows
  // foreground lock. Verify the switch actually happened and escalate through
  // the documented workarounds; report failure honestly instead of typing
  // into whatever window the user happens to have focused.
  static bool TryFocusAttached(IntPtr h) {
    IntPtr foreground = GetForegroundWindow();
    uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
    uint currentThread = GetCurrentThreadId();
    bool attached = foregroundThread != 0 && foregroundThread != currentThread;
    if (attached) AttachThreadInput(currentThread, foregroundThread, true);
    try {
      ShowWindow(h, 9);
      SetForegroundWindow(h);
      return GetForegroundWindow() == h;
    } finally {
      if (attached) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }
  public static bool Focus(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return false;
    ShowWindow(h, 9);
    SetForegroundWindow(h);
    if (GetForegroundWindow() == h) return true;
    if (TryFocusAttached(h)) return true;
    keybd_event(0xFC, 0, 0, UIntPtr.Zero);
    keybd_event(0xFC, 0, 0x2, UIntPtr.Zero);
    for (int attempt = 0; attempt < 3; attempt++) {
      if (TryFocusAttached(h)) return true;
      System.Threading.Thread.Sleep(25);
    }
    return false;
  }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  /// Top-level window that would receive a click at (x, y).
  public static IntPtr WindowAtPoint(int x, int y) {
    POINT p = new POINT(); p.x = x; p.y = y;
    IntPtr h = WindowFromPoint(p);
    return h == IntPtr.Zero ? h : GetAncestor(h, 2);
  }
  public static IntPtr Foreground() { return GetForegroundWindow(); }
  public static POINT Cursor() {
    POINT p;
    GetCursorPos(out p);
    return p;
  }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  /// UIA reports physical pixels; a DPI-unaware process hit-tests and moves
  /// the cursor in virtualized coordinates, skewing every point on scaled
  /// monitors. Make this host per-monitor DPI aware so both sides agree.
  public static void MakeDpiAware() {
    if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
  }
  public const uint LDOWN = 0x02, LUP = 0x04, RDOWN = 0x08, RUP = 0x10, WHEEL = 0x0800, HWHEEL = 0x1000, MDOWN = 0x20, MUP = 0x40;
  public static void Click(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(40);
    mouse_event(LDOWN,0,0,0,IntPtr.Zero); mouse_event(LUP,0,0,0,IntPtr.Zero);
  }
  public static void DoubleClick(int x, int y) {
    Click(x, y); System.Threading.Thread.Sleep(80);
    mouse_event(LDOWN,0,0,0,IntPtr.Zero); mouse_event(LUP,0,0,0,IntPtr.Zero);
  }
  public static void RightClick(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(40);
    mouse_event(RDOWN,0,0,0,IntPtr.Zero); mouse_event(RUP,0,0,0,IntPtr.Zero);
  }
  public static void MiddleClick(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(40);
    mouse_event(MDOWN,0,0,0,IntPtr.Zero); mouse_event(MUP,0,0,0,IntPtr.Zero);
  }
  public static void TripleClick(int x, int y) {
    Click(x, y); System.Threading.Thread.Sleep(60);
    mouse_event(LDOWN,0,0,0,IntPtr.Zero); mouse_event(LUP,0,0,0,IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(LDOWN,0,0,0,IntPtr.Zero); mouse_event(LUP,0,0,0,IntPtr.Zero);
  }
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1); System.Threading.Thread.Sleep(60);
    mouse_event(LDOWN,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(150);
    for (int i = 1; i <= 12; i++) {
      SetCursorPos(x1 + (x2 - x1) * i / 12, y1 + (y2 - y1) * i / 12);
      System.Threading.Thread.Sleep(20);
    }
    System.Threading.Thread.Sleep(80);
    mouse_event(LUP,0,0,0,IntPtr.Zero);
  }
  // Named MouseWheel: PowerShell resolves members case-insensitively, so a
  // method called Wheel collides with the WHEEL constant above.
  public static void MouseWheel(int clicks) { mouse_event(WHEEL,0,0,clicks*120,IntPtr.Zero); }
  public static void MouseHWheel(int clicks) { mouse_event(HWHEEL,0,0,clicks*120,IntPtr.Zero); }

  // --- Keyboard: SendInput-based engine over the SendKeys grammar. ---
  // SendInput never flips NumLock/CapsLock (unlike Windows.Forms SendKeys),
  // and KEYEVENTF_UNICODE types any literal text regardless of layout.
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  const uint KUP = 0x2, KUNI = 0x4, KEXT = 0x1;
  static bool IsExt(ushort vk) {
    return vk==0x21||vk==0x22||vk==0x23||vk==0x24||vk==0x25||vk==0x26||vk==0x27||vk==0x28
      ||vk==0x2C||vk==0x2D||vk==0x2E||vk==0x5B||vk==0x5C||vk==0x5D||vk==0x6F||vk==0x90;
  }
  static INPUT KI(ushort vk, ushort scan, uint flags) {
    INPUT input = new INPUT(); input.type = 1;
    input.U.ki.wVk = vk; input.U.ki.wScan = scan; input.U.ki.dwFlags = flags;
    input.U.ki.time = 0; input.U.ki.dwExtraInfo = IntPtr.Zero;
    return input;
  }
  static void AddVk(List<INPUT> list, ushort vk, bool up) {
    uint flags = (IsExt(vk) ? KEXT : 0u) | (up ? KUP : 0u);
    list.Add(KI(vk, 0, flags));
  }
  static void AddUnicode(List<INPUT> list, char c) {
    list.Add(KI(0, (ushort)c, KUNI));
    list.Add(KI(0, (ushort)c, KUNI | KUP));
  }
  // Barrier: flush-and-pause marker between unicode text runs and VK key
  // events. Async input stacks (WinUI apps like new Notepad) process
  // character input and key input on separate paths and can reorder them
  // when both arrive in one tight batch; the pause lets the character
  // pipeline drain before a control key (and between chords like ^a^c).
  static void AddBarrier(List<INPUT> list) {
    if (list.Count == 0) return;
    INPUT b = new INPUT(); b.type = 0xFFFF;
    if (list[list.Count - 1].type == 0xFFFF) return;
    list.Add(b);
  }
  static void Dispatch(List<INPUT> list) {
    List<INPUT> seg = new List<INPUT>();
    for (int idx = 0; idx <= list.Count; idx++) {
      bool atEnd = idx == list.Count;
      if (!atEnd && list[idx].type != 0xFFFF) { seg.Add(list[idx]); continue; }
      for (int off = 0; off < seg.Count; off += 256) {
        int n = Math.Min(256, seg.Count - off);
        INPUT[] arr = seg.GetRange(off, n).ToArray();
        if (SendInput((uint)n, arr, Marshal.SizeOf(typeof(INPUT))) != (uint)n)
          throw new Exception("SendInput was blocked (is an elevated window focused?)");
        System.Threading.Thread.Sleep(3);
      }
      seg.Clear();
      if (!atEnd) System.Threading.Thread.Sleep(30);
    }
  }
  /// One VK tap (down+up) through SendInput; used to restore lock keys.
  public static void KeyTap(ushort vk) {
    List<INPUT> list = new List<INPUT>();
    AddVk(list, vk, false); AddVk(list, vk, true);
    Dispatch(list);
  }
  /// Hold or release one VK; wraps modifier-held clicks (ctrl+click etc.).
  public static void KeyDown(ushort vk) {
    List<INPUT> list = new List<INPUT>();
    AddVk(list, vk, false);
    Dispatch(list);
  }
  public static void KeyUp(ushort vk) {
    List<INPUT> list = new List<INPUT>();
    AddVk(list, vk, true);
    Dispatch(list);
  }
  /// Literal text entry (no grammar): every character lands exactly as given.
  public static void SendText(string text) {
    foreach (char ch in (text == null ? "" : text)) {
      if (ch == '\r') continue;
      List<INPUT> glyph = new List<INPUT>();
      if (ch == '\n') {
        AddVk(glyph, 0x0D, false);
        AddVk(glyph, 0x0D, true);
      } else {
        AddUnicode(glyph, ch);
      }
      Dispatch(glyph);
      // Chromium/WinUI can drop a tight Unicode batch even though SendInput
      // accepted it. Brief pacing preserves literal order across async queues.
      System.Threading.Thread.Sleep(4);
    }
  }
}`;
