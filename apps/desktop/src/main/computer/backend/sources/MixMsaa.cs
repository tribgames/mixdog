using System;
using Accessibility;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using INPUT = MixNativeInput.INPUT;
public sealed class MixMsaaNode
{
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
    /// Hidden, not merely scrolled away: a closed drop-down list or a collapsed
    /// dialog section, whose descendants often do not repeat the flag.
    public bool Invisible { get; private set; }

    internal MixMsaaNode(IAccessible accessible, object childId, string key, string windowId)
    {
        Accessible = accessible;
        ChildId = childId;
        Key = key;
        WindowId = windowId;
        Name = Value = Description = Role = State = DefaultAction = "";
        ControlType = "Custom";
    }

    static string Read(Func<string> getter)
    {
        try { return getter() ?? ""; } catch { return ""; }
    }

    static uint ReadUInt(Func<object> getter)
    {
        try
        {
            object value = getter();
            return value == null ? 0u : Convert.ToUInt32(value, CultureInfo.InvariantCulture);
        }
        catch
        {
            return 0u;
        }
    }

    public bool Refresh()
    {
        try
        {
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
            Invisible = (state & 0x8000u) != 0;
            return Width > 0 && Height > 0;
        }
        catch
        {
            return false;
        }
    }

    public string ObservableState()
    {
        if (!Refresh()) return "";
        return "value=" + Value + "|state=" + State;
    }

    public void DoDefaultAction()
    {
        if (!Refresh()) throw new InvalidOperationException("MSAA element is stale");
        if (String.IsNullOrWhiteSpace(DefaultAction))
        {
            throw new InvalidOperationException("MSAA element exposes no default action");
        }
        Accessible.accDoDefaultAction(ChildId);
        Refresh();
    }

    public string SetValue(string value)
    {
        if (!Refresh()) throw new InvalidOperationException("MSAA element is stale");
        Accessible.set_accValue(ChildId, value ?? "");
        Refresh();
        return Value;
    }
}

public class MixMsaaSnapshot
{
    public MixMsaaNode[] Nodes;
    public bool Complete;
}

public static class MixMsaa
{
    const uint OBJID_CLIENT = unchecked((uint)-4);
    const uint OBJID_MENU = unchecked((uint)-3);
    [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr hwnd);
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

    static long Identity(object value)
    {
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
      bool includeSelf,
      ref bool complete)
    {
        if (depth > 64) throw new InvalidOperationException("MSAA tree depth exceeds 64");
        long identity = Identity(accessible);
        if (!visited.Add(identity)) return;
        if (includeSelf)
        {
            if (result.Count >= maximum) { complete = false; return; }
            MixMsaaNode node = new MixMsaaNode(accessible, 0, path, windowId);
            if (node.Refresh()) result.Add(node); else complete = false;
            if (node.Invisible) return;
        }
        int count;
        try { count = Math.Max(0, accessible.accChildCount); } catch { complete = false; return; }
        if (count == 0) return;
        int childStart = 0;
        while (childStart < count && result.Count < maximum)
        {
            int requested = Math.Min(256, count - childStart);
            object[] children = new object[requested];
            int obtained;
            int hr = AccessibleChildren(accessible, childStart, requested, children, out obtained);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            int returned = Math.Min(Math.Max(0, obtained), children.Length);
            if (returned == 0) { complete = false; break; }
            for (int index = 0; index < returned; index++)
            {
                if (result.Count >= maximum) { complete = false; break; }
                object child = children[index];
                IAccessible nested = child as IAccessible;
                int childIndex = childStart + index;
                string childPath = path + "/" + childIndex.ToString(CultureInfo.InvariantCulture);
                if (nested != null)
                {
                    Traverse(nested, childPath, windowId, result, visited, maximum, depth + 1, true, ref complete);
                    continue;
                }
                int childId;
                try { childId = Convert.ToInt32(child, CultureInfo.InvariantCulture); } catch { complete = false; continue; }
                MixMsaaNode simple = new MixMsaaNode(accessible, childId, childPath, windowId);
                if (simple.Refresh()) result.Add(simple); else complete = false;
            }
            childStart += returned;
        }
        if (childStart < count) complete = false;
    }

    public static MixMsaaNode[] Snapshot(IntPtr hwnd, string windowId, int maximum)
    {
        return SnapshotWithStatus(hwnd, windowId, maximum).Nodes;
    }

    public static MixMsaaSnapshot SnapshotWithStatus(IntPtr hwnd, string windowId, int maximum)
    {
        return SnapshotObject(hwnd, windowId, maximum, OBJID_CLIENT);
    }

    const uint STATE_SYSTEM_PROTECTED = 0x20000000;
    const int CHILDID_SELF = 0;

    /// <summary>
    /// Whether this window's own control hides what is typed into it. UIA's
    /// IsPassword answers only for providers that implement it; a WinForms edit
    /// with UseSystemPasswordChar leaves it false while still raising MSAA's
    /// PROTECTED state. This is the second opinion that keeps such a field off
    /// the typing board, and an unreadable window counts as protected.
    /// </summary>
    public static bool IsProtectedInput(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        object raw;
        Guid iid = IID_IAccessible;
        try
        {
            if (AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, ref iid, out raw) < 0) return true;
        }
        catch { return true; }
        IAccessible accessible = raw as IAccessible;
        if (accessible == null) return true;
        try
        {
            object state = accessible.get_accState(CHILDID_SELF);
            if (state == null) return true;
            return (Convert.ToUInt32(state, CultureInfo.InvariantCulture) & STATE_SYSTEM_PROTECTED) != 0;
        }
        catch { return true; }
    }

    public static MixMsaaNode[] MenuSnapshot(IntPtr hwnd, string windowId, int maximum)
    {
        if (GetMenu(hwnd) == IntPtr.Zero) return new MixMsaaNode[0];
        return SnapshotObject(hwnd, windowId, maximum, OBJID_MENU).Nodes;
    }

    static MixMsaaSnapshot SnapshotObject(IntPtr hwnd, string windowId, int maximum, uint objectId)
    {
        if (hwnd == IntPtr.Zero) throw new ArgumentException("MSAA window handle is required");
        if (maximum < 1 || maximum > 5000) throw new ArgumentOutOfRangeException("maximum");
        object raw;
        Guid iid = IID_IAccessible;
        int hr = AccessibleObjectFromWindow(hwnd, objectId, ref iid, out raw);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        IAccessible root = raw as IAccessible;
        if (root == null) return new MixMsaaSnapshot { Nodes = new MixMsaaNode[0], Complete = false };
        List<MixMsaaNode> result = new List<MixMsaaNode>();
        bool complete = true;
        Traverse(root, "0", windowId ?? "", result, new HashSet<long>(), maximum, 0, false, ref complete);
        return new MixMsaaSnapshot { Nodes = result.ToArray(), Complete = complete };
    }

    public static string RoleText(uint role)
    {
        StringBuilder text = new StringBuilder(128);
        return GetRoleTextW(role, text, (uint)text.Capacity) > 0
          ? text.ToString()
          : role.ToString(CultureInfo.InvariantCulture);
    }

    public static string StateText(uint state)
    {
        if (state == 0) return "normal";
        List<string> parts = new List<string>();
        for (int bit = 0; bit < 32; bit++)
        {
            uint flag = 1u << bit;
            if ((state & flag) == 0) continue;
            StringBuilder text = new StringBuilder(128);
            if (GetStateTextW(flag, text, (uint)text.Capacity) > 0) parts.Add(text.ToString());
            else parts.Add("0x" + flag.ToString("X", CultureInfo.InvariantCulture));
        }
        return String.Join(",", parts.ToArray());
    }

    /// MSAA role constants (oleacc.h) to the UIA control type they correspond to.
    public static string ControlTypeForRole(uint role)
    {
        switch (role)
        {
            case 0x01: return "TitleBar";
            case 0x02: return "MenuBar";
            case 0x03: return "ScrollBar";
            case 0x09: return "Window";
            case 0x0A: return "Client";
            case 0x0B: return "Menu";
            case 0x0C: return "MenuItem";
            case 0x0F: return "Document";
            case 0x10: return "Pane";
            case 0x14: return "Group";
            case 0x15: return "Separator";
            case 0x16: return "ToolBar";
            case 0x17: return "StatusBar";
            case 0x18: return "Table";
            case 0x19: return "HeaderItem";
            case 0x1D: return "DataItem";
            case 0x1E: return "Hyperlink";
            case 0x21: return "List";
            case 0x22: return "ListItem";
            case 0x23: return "Tree";
            case 0x24: return "TreeItem";
            case 0x25: return "TabItem";
            case 0x26: return "Pane";
            case 0x28: return "Image";
            case 0x29: return "Text";
            case 0x2A: return "Edit";
            case 0x2B: return "Button";
            case 0x2C: return "CheckBox";
            case 0x2D: return "RadioButton";
            case 0x2E: return "ComboBox";
            case 0x2F: return "ComboBox";
            case 0x30: return "ProgressBar";
            case 0x32: return "Edit";
            case 0x33: return "Slider";
            case 0x34: return "Spinner";
            case 0x38: return "Button";
            case 0x39: return "Button";
            case 0x3A: return "Button";
            case 0x3C: return "Tab";
            case 0x3E: return "SplitButton";
            case 0x3F: return "Edit";
            case 0x40: return "Button";
            default: return "Custom";
        }
    }
}
