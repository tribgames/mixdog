/**
 * Computer-use host — main-process owner of local Windows desktop control and
 * of the loopback bridge that lets the session runtime's `computer` tool drive
 * it. Windows only for now.
 *
 * Engine: a single resident PowerShell process holds .NET UI Automation state
 * (an element map that survives between snapshot and invoke, which spawning
 * per command could not) and dispatches Win32 input. Screenshots are captured
 * on demand in Electron via desktopCapturer, not PowerShell. The runtime half discovers
 * this bridge through a heartbeated data-dir file, so the tool surface exists
 * only while the desktop app runs with Computer Use enabled — no daemon
 * protocol change.
 *
 * The PowerShell recipes (UIA tree walk, InvokePattern/ValuePattern, Win32
 * input) follow the well-known Microsoft UI Automation / user32 APIs; the
 * design was informed by PCClaw's win-ui-auto skill but the code here is
 * written against the public API surface, not copied.
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { desktopCapturer, screen } from 'electron';

const DISCOVERY_FILE = 'computer-bridge.json';
const DISCOVERY_VERSION = 1;
const HEARTBEAT_MS = 60_000;
const MAX_REQUEST_BYTES = 256 * 1024;
/** Per-command ceiling for the PowerShell host round trip. */
const COMMAND_TIMEOUT_MS = 45_000;
/** Line marker the resident PowerShell host prefixes on every response line. */
const RESPONSE_MARKER = '@@MIXCU@@';
const DEFAULT_SCREENSHOT_QUALITY = 55;
const DEFAULT_SCREENSHOT_MAX_WIDTH = 1280;
const MIN_SCREENSHOT_MAX_WIDTH = 256;
const MAX_SCREENSHOT_MAX_WIDTH = 3840;

interface ComputerCommand {
  action: string;
  window?: string;
  ref?: string;
  text?: string;
  keys?: string;
  dy?: number;
  app?: string;
  /** drag destination ref. */
  to?: string;
  /** screenshot display index (0-based) for multi-monitor setups. */
  screen?: number;
  quality?: number;
  maxWidth?: number;
}

interface ComputerCommandResult {
  text: string;
  image?: { mimeType: string; data: string };
}

interface PowerShellResponse {
  id: number;
  ok: boolean;
  result?: { text?: string; title?: string; width?: number; height?: number };
  error?: string;
}

function mixdogDataDirectory(): string {
  return process.env.MIXDOG_DATA_DIR
    || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}

/**
 * The resident PowerShell program. Reads one JSON request per line from stdin,
 * writes one marker-prefixed JSON response per line to stdout. Holds a ref →
 * AutomationElement map across requests so invoke/set_value can act on the
 * element a prior snapshot labelled.
 */
function powershellHostProgram(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class MixWin32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  // SetForegroundWindow from a background process is refused by the Windows
  // foreground lock. Verify the switch actually happened and escalate through
  // the documented workarounds; report failure honestly instead of typing
  // into whatever window the user happens to have focused.
  public static bool Focus(IntPtr h) {
    ShowWindow(h, 9);
    SetForegroundWindow(h);
    if (GetForegroundWindow() == h) return true;
    List<INPUT> alt = new List<INPUT>();
    AddVk(alt, 0x12, false); AddVk(alt, 0x12, true);
    Dispatch(alt);
    SetForegroundWindow(h);
    if (GetForegroundWindow() == h) return true;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint myThread = GetCurrentThreadId();
    AttachThreadInput(fgThread, myThread, true);
    ShowWindow(h, 9);
    SetForegroundWindow(h);
    AttachThreadInput(fgThread, myThread, false);
    System.Threading.Thread.Sleep(80);
    return GetForegroundWindow() == h;
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  /// Top-level window that would receive a click at (x, y).
  public static IntPtr WindowAtPoint(int x, int y) {
    POINT p = new POINT(); p.x = x; p.y = y;
    IntPtr h = WindowFromPoint(p);
    return h == IntPtr.Zero ? h : GetAncestor(h, 2);
  }
  public static IntPtr Foreground() { return GetForegroundWindow(); }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  /// UIA reports physical pixels; a DPI-unaware process hit-tests and moves
  /// the cursor in virtualized coordinates, skewing every point on scaled
  /// monitors. Make this host per-monitor DPI aware so both sides agree.
  public static void MakeDpiAware() {
    if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
  }
  public const uint LDOWN = 0x02, LUP = 0x04, RDOWN = 0x08, RUP = 0x10, WHEEL = 0x0800;
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
  /// Literal text entry (no grammar): every character lands exactly as given.
  public static void SendText(string text) {
    List<INPUT> list = new List<INPUT>();
    foreach (char ch in (text == null ? "" : text)) {
      if (ch == '\r') continue;
      if (ch == '\n') { AddBarrier(list); AddVk(list, 0x0D, false); AddVk(list, 0x0D, true); AddBarrier(list); continue; }
      AddUnicode(list, ch);
    }
    Dispatch(list);
  }
}
"@
[void][MixWin32]::MakeDpiAware()
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$Map = @{}
# Last focus_window target: typing actions re-assert it so agent keystrokes
# cannot land in whatever window the user happens to be using.
$LastFocus = [IntPtr]::Zero

function Find-Window($title) {
  $root = $AE::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll($TS::Children, $cond)
  if (-not $title) {
    $fg = $root.FindFirst($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::HasKeyboardFocusProperty, $true)))
    if ($fg) { return $fg }
  }
  foreach ($w in $wins) {
    $n = $w.Current.Name
    if ($title -and $n -and ($n -eq $title -or $n.ToLower().Contains($title.ToLower()))) { return $w }
  }
  if (-not $title -and $wins.Count -gt 0) { return $wins[0] }
  return $null
}

function Do-ListWindows {
  $root = $AE::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll($TS::Children, $cond)
  $lines = New-Object System.Collections.ArrayList
  foreach ($w in $wins) {
    $n = $w.Current.Name; $r = $w.Current.BoundingRectangle
    if ($n -and -not [double]::IsInfinity($r.Width)) {
      [void]$lines.Add(('{0} | {1}x{2} at {3},{4}' -f $n, [math]::Round($r.Width), [math]::Round($r.Height), [math]::Round($r.X), [math]::Round($r.Y)))
    }
  }
  if ($lines.Count -eq 0) { return @{ text = 'No windows found.' } }
  return @{ text = ('Windows:' + [Environment]::NewLine + ($lines -join [Environment]::NewLine)) }
}

function Snapshot-Window($title) {
  $win = Find-Window $title
  if (-not $win) { throw "window not found: $title" }
  $Map.Clear()
  # Performance is everything here. Per-node .Current.* access is a cross-process
  # COM call each; walking a heavy tree that way makes thousands of round trips
  # and hangs (observed 45s+ on WinUI apps). Instead: filter to interactive
  # control types and run ONE FindAll under an active CacheRequest, so the
  # matching elements arrive with their properties cached in a single pass and
  # every .Cached.* read below is local. Measured ~30ms on Notepad.
  $ctTypes = @('Button','Edit','CheckBox','RadioButton','ComboBox','List','ListItem',
    'MenuItem','TabItem','Hyperlink','Tree','TreeItem','Slider','Document','Spinner','SplitButton')
  $conds = foreach ($t in $ctTypes) {
    New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::$t)
  }
  $cond = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conds)
  $cr = New-Object System.Windows.Automation.CacheRequest
  [void]$cr.Add($AE::NameProperty)
  [void]$cr.Add($AE::ControlTypeProperty)
  [void]$cr.Add($AE::BoundingRectangleProperty)
  [void]$cr.Add($AE::IsEnabledProperty)
  $act = $cr.Activate()
  try { $els = $win.FindAll($TS::Descendants, $cond) } finally { $act.Dispose() }
  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add('Window: ' + $win.Current.Name)
  $listed = 0
  foreach ($el in $els) {
    if ($listed -ge 200) { [void]$lines.Add('... (truncated at 200 elements)'); break }
    $r = $el.Cached.BoundingRectangle
    if ([double]::IsInfinity($r.Width) -or $r.Width -le 0 -or $r.Height -le 0) { continue }
    $ct = $el.Cached.ControlType.ProgrammaticName -replace 'ControlType\.',''
    $ref = 'e' + $listed
    $Map[$ref] = $el
    $nm = $el.Cached.Name
    if ($nm.Length -gt 60) { $nm = $nm.Substring(0,60) }
    $cx = [math]::Round($r.X + $r.Width/2); $cy = [math]::Round($r.Y + $r.Height/2)
    $en = if ($el.Cached.IsEnabled) { '' } else { ' (disabled)' }
    [void]$lines.Add(('[{0}] {1} "{2}"{3} @{4},{5}' -f $ref, $ct, $nm, $en, $cx, $cy))
    $listed++
  }
  if ($listed -eq 0) { [void]$lines.Add('(no interactive elements found)') }
  return @{ text = ($lines -join [Environment]::NewLine) }
}

function Get-El($ref) {
  if (-not $Map.ContainsKey($ref)) { throw "ref $ref is stale or unknown; take a fresh snapshot" }
  return $Map[$ref]
}

function Do-Invoke($ref) {
  $el = Get-El $ref
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
    $pat.Invoke(); return @{ text = "invoked $ref" }
  }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
    $pat.Select(); return @{ text = "selected $ref" }
  }
  $p = Get-ElPoint $ref
  [MixWin32]::Click($p[0], $p[1])
  return @{ text = "clicked $ref (no invoke pattern; used center click)" }
}

function Do-SetValue($ref, $text) {
  $el = Get-El $ref
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
    $pat.SetValue($text); return @{ text = "set $ref value" }
  }
  try { $el.SetFocus() } catch {}
  Start-Sleep -Milliseconds 60
  $topHandle = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
  if ($topHandle -ne [IntPtr]::Zero -and [MixWin32]::Foreground() -ne $topHandle) {
    throw "element $ref window is not foreground (the user may be working elsewhere); value not typed"
  }
  [MixWin32]::SendText($text)
  return @{ text = "typed into $ref (no value pattern; used keystrokes)" }
}

function Do-Toggle($ref) {
  $el = Get-El $ref
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
    $pat.Toggle(); return @{ text = "toggled $ref -> $($pat.Current.ToggleState)" }
  }
  return Do-Invoke $ref
}

# Nearest top-level ancestor (child of the desktop root) for an element.
function Get-TopWindow($el) {
  $cur = $el
  for ($i = 0; $i -lt 50; $i++) {
    $parent = $Walker.GetParent($cur)
    if ($null -eq $parent) { return $cur }
    if ([System.Windows.Automation.Automation]::Compare($parent, $AE::RootElement)) { return $cur }
    $cur = $parent
  }
  return $cur
}

function Get-ElPoint($ref) {
  $el = Get-El $ref
  $r = $el.Current.BoundingRectangle
  if ([double]::IsInfinity($r.Width) -or $r.Width -le 0 -or $r.Height -le 0) { throw "element $ref has no clickable bounds" }
  $x = [int]($r.X + $r.Width/2)
  $y = [int]($r.Y + $r.Height/2)
  # Occlusion guard: a real click lands on whatever window is on top at that
  # point; refuse instead of clicking through to the wrong app.
  $topHandle = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
  $atPoint = [MixWin32]::WindowAtPoint($x, $y)
  if ($topHandle -ne [IntPtr]::Zero -and $atPoint -ne [IntPtr]::Zero -and $atPoint -ne $topHandle) {
    throw "element $ref is covered by another window at its click point; call focus_window first"
  }
  return @($x, $y)
}

function Do-DoubleClick($ref) {
  $p = Get-ElPoint $ref
  [MixWin32]::DoubleClick($p[0], $p[1])
  return @{ text = "double-clicked $ref" }
}

function Do-RightClick($ref) {
  $p = Get-ElPoint $ref
  [MixWin32]::RightClick($p[0], $p[1])
  return @{ text = "right-clicked $ref" }
}

function Do-Drag($ref, $to) {
  if (-not $to) { throw 'drag requires to (destination ref)' }
  $a = Get-ElPoint $ref
  $b = Get-ElPoint $to
  [MixWin32]::Drag($a[0], $a[1], $b[0], $b[1])
  return @{ text = "dragged $ref to $to" }
}

function Do-Scroll($ref, $dy) {
  $amt = if ($dy) { [int]$dy } else { 3 }
  if ($ref) {
    $el = Get-El $ref
    $pat = $null
    # Background path: ScrollPattern scrolls without touching mouse or focus.
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pat)) {
      $dir = if ($amt -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement }
      $n = [math]::Min([math]::Abs($amt) * 3, 30)
      for ($i = 0; $i -lt $n; $i++) {
        if (-not $pat.Current.VerticallyScrollable) { break }
        $pat.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $dir)
      }
      return @{ text = "scrolled $ref $n lines (background scroll pattern)" }
    }
    # Real wheel goes to the window under the pointer: park the pointer on the
    # element first (occlusion-checked).
    $p = Get-ElPoint $ref
    [void][MixWin32]::SetCursorPos($p[0], $p[1])
    Start-Sleep -Milliseconds 40
    [MixWin32]::MouseWheel(-$amt)
    return @{ text = "scrolled $amt wheel clicks at $ref" }
  }
  [MixWin32]::MouseWheel(-$amt)
  return @{ text = "scrolled $amt wheel clicks" }
}

function Do-Focus($title) {
  $win = Find-Window $title
  if (-not $win) { throw "window not found: $title" }
  $h = New-Object IntPtr($win.Current.NativeWindowHandle)
  if (-not [MixWin32]::Focus($h)) {
    throw "could not bring window to foreground (another app holds focus): $($win.Current.Name)"
  }
  $script:LastFocus = $h
  return @{ text = ('focused: ' + $win.Current.Name) }
}

function Get-WindowBounds($title) {
  $win = Find-Window $title
  if (-not $win) { throw "window not found: $title" }
  $r = $win.Current.BoundingRectangle
  if ([double]::IsInfinity($r.Width) -or $r.Width -le 0 -or $r.Height -le 0) {
    throw "window has no capturable bounds: $title"
  }
  return @{
    text = ('window bounds: ' + $win.Current.Name)
    title = $win.Current.Name
    width = [math]::Round($r.Width)
    height = [math]::Round($r.Height)
  }
}

# Hotkeys ride .NET SendKeys: its SendWait waits for the target to process
# each key, which raw SendInput batches cannot (WinUI apps sample modifier
# state asynchronously and scramble tight chord batches — same conclusion as
# cua-driver, which routes XAML input through UIA instead). SendKeys' one
# defect, flipping NumLock/CapsLock/ScrollLock, is detected and reverted here.
function Send-KeysGuarded($keys) {
  $locks = @(
    @{ token = '{NUMLOCK}'; vk = 0x90; key = [System.Windows.Forms.Keys]::NumLock },
    @{ token = '{CAPSLOCK}'; vk = 0x14; key = [System.Windows.Forms.Keys]::CapsLock },
    @{ token = '{SCROLLLOCK}'; vk = 0x91; key = [System.Windows.Forms.Keys]::Scroll }
  )
  $before = @{}
  foreach ($l in $locks) { $before[$l.token] = [System.Windows.Forms.Control]::IsKeyLocked($l.key) }
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Milliseconds 30
  foreach ($l in $locks) {
    if (([string]$keys).ToUpper().Contains($l.token)) { continue }
    if ([System.Windows.Forms.Control]::IsKeyLocked($l.key) -ne $before[$l.token]) { [MixWin32]::KeyTap([ushort]$l.vk) }
  }
}

# Keystrokes land on the FOREGROUND window. Re-assert the last focus_window
# target before sending; when the user moved to another window and it cannot
# be reclaimed, fail instead of typing into their window.
function Assert-TypingTarget {
  if ($script:LastFocus -eq [IntPtr]::Zero) { return }
  if ([MixWin32]::Foreground() -eq $script:LastFocus) { return }
  if (-not [MixWin32]::Focus($script:LastFocus)) {
    throw 'foreground changed (the user is working in another window); keys not sent. Call focus_window again.'
  }
}

# Plain text (no SendKeys grammar characters) rides IME-immune unicode
# SendInput: under an active Korean IME, SendKeys' per-key synthesis gets
# translated into jamo ("parity" becomes hangul noise), while
# KEYEVENTF_UNICODE lands the literal characters verbatim.
function Do-Key($keys) {
  Assert-TypingTarget
  if (([string]$keys) -notmatch '[{}^%+~()]') { [MixWin32]::SendText($keys) }
  else { Send-KeysGuarded $keys }
  return @{ text = 'sent keys' }
}
function Do-Launch($app) { Start-Process $app; return @{ text = ('launched ' + $app) } }

function Handle($req) {
  switch ($req.action) {
    'list_windows' { return Do-ListWindows }
    'snapshot'     { return Snapshot-Window $req.window }
    'invoke'       { return Do-Invoke $req.ref }
    'set_value'    { return Do-SetValue $req.ref $req.text }
    'toggle'       { return Do-Toggle $req.ref }
    'double_click' { return Do-DoubleClick $req.ref }
    'right_click'  { return Do-RightClick $req.ref }
    'drag'         { return Do-Drag $req.ref $req.to }
    'scroll'       { return Do-Scroll $req.ref $req.dy }
    'focus_window' { return Do-Focus $req.window }
    'window_bounds'{ return Get-WindowBounds $req.window }
    'key'          { return Do-Key $req.keys }
    'launch'       { return Do-Launch $req.app }
    default        { throw "unknown action: $($req.action)" }
  }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# Read stdin as UTF-8 explicitly: [Console]::In follows the console code page
# (CP949 etc.), which corrupts multibyte command payloads (e.g. Korean window
# titles) and breaks JSON parsing. A StreamReader over the raw handle is code-
# page independent.
$__stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
while ($true) {
  $line = $__stdin.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = [int]$req.id
    $res = Handle $req
    $out = @{ id = $id; ok = $true; result = $res } | ConvertTo-Json -Compress -Depth 6
  } catch {
    $out = @{ id = $id; ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
  }
  [Console]::Out.WriteLine('${RESPONSE_MARKER}' + $out)
}
`.replace('${RESPONSE_MARKER}', RESPONSE_MARKER);
}

export interface ComputerHost {
  dispose(): Promise<void>;
}

export function createComputerHost(): ComputerHost {
  const token = randomBytes(24).toString('base64url');
  let heartbeat: NodeJS.Timeout | null = null;
  let server: Server | null = null;
  let discoveryPath: string | null = null;
  let disposed = false;

  // Resident PowerShell host + its pending-request table.
  let ps: ChildProcessWithoutNullStreams | null = null;
  let hostScriptPath: string | null = null;
  let psBuffer = '';
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: PowerShellResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let commandChain: Promise<unknown> = Promise.resolve();

  function ensurePowerShell(): ChildProcessWithoutNullStreams {
    if (ps && !ps.killed) return ps;
    // The program runs from a temp .ps1 via -File, NOT piped through -Command -:
    // with -Command - PowerShell consumes stdin as the command text, colliding
    // with the per-command JSON we also write to stdin. -File leaves stdin
    // dedicated to runtime commands.
    if (!hostScriptPath) {
      const directory = mixdogDataDirectory();
      mkdirSync(directory, { recursive: true });
      hostScriptPath = join(directory, 'computer-host.ps1');
      writeFileSync(hostScriptPath, powershellHostProgram());
    }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hostScriptPath], {
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      psBuffer += chunk;
      let index = psBuffer.indexOf('\n');
      while (index >= 0) {
        const line = psBuffer.slice(0, index).replace(/\r$/, '');
        psBuffer = psBuffer.slice(index + 1);
        const marker = line.indexOf(RESPONSE_MARKER);
        if (marker >= 0) handlePsLine(line.slice(marker + RESPONSE_MARKER.length));
        index = psBuffer.indexOf('\n');
      }
    });
    child.stderr.on('data', () => { /* diagnostics ignored; errors ride responses */ });
    child.once('exit', () => {
      ps = null;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('computer host exited'));
      }
      pending.clear();
    });
    ps = child;
    return child;
  }

  function handlePsLine(json: string): void {
    let parsed: PowerShellResponse;
    try {
      parsed = JSON.parse(json) as PowerShellResponse;
    } catch {
      return;
    }
    const entry = pending.get(parsed.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(parsed.id);
    entry.resolve(parsed);
  }

  function callPowerShell(request: Record<string, unknown>): Promise<PowerShellResponse> {
    const child = ensurePowerShell();
    const id = nextId++;
    const line = `${JSON.stringify({ ...request, id })}\n`;
    return new Promise<PowerShellResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('computer command timed out'));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(line);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function screenshotInteger(
    value: number | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
    label: string,
  ): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
    }
    return value;
  }

  /** On-demand JPEG through Electron, scoped to the primary screen or one window. */
  async function captureScreenshot(command: ComputerCommand): Promise<{
    image: { mimeType: string; data: string };
    description: string;
  } | null> {
    const quality = screenshotInteger(command.quality, DEFAULT_SCREENSHOT_QUALITY, 0, 100, 'quality');
    const maxWidth = screenshotInteger(
      command.maxWidth,
      DEFAULT_SCREENSHOT_MAX_WIDTH,
      MIN_SCREENSHOT_MAX_WIDTH,
      MAX_SCREENSHOT_MAX_WIDTH,
      'maxWidth',
    );
    let sourceType: 'screen' | 'window' = 'screen';
    let sourceTitle = 'primary screen';
    let sourceWidth: number;
    let sourceHeight: number;
    let targetDisplayId = '';
    if (command.window?.trim()) {
      const bounds = await callPowerShell({ action: 'window_bounds', window: command.window.trim() });
      if (!bounds.ok) throw new Error(bounds.error || 'window bounds lookup failed');
      sourceType = 'window';
      sourceTitle = String(bounds.result?.title || command.window.trim());
      sourceWidth = Number(bounds.result?.width);
      sourceHeight = Number(bounds.result?.height);
      if (!Number.isFinite(sourceWidth) || sourceWidth <= 0 || !Number.isFinite(sourceHeight) || sourceHeight <= 0) {
        throw new Error(`window has no capturable bounds: ${sourceTitle}`);
      }
    } else {
      const displays = screen.getAllDisplays();
      const primaryIndex = Math.max(0, displays.findIndex((display) => display.id === screen.getPrimaryDisplay().id));
      const index = screenshotInteger(command.screen, primaryIndex, 0, Math.max(0, displays.length - 1), 'screen');
      const display = displays[index] ?? screen.getPrimaryDisplay();
      targetDisplayId = String(display.id);
      sourceWidth = display.size.width;
      sourceHeight = display.size.height;
      if (displays.length > 1) sourceTitle = `screen ${index + 1}/${displays.length}`;
    }
    const scale = Math.min(1, maxWidth / Math.max(1, sourceWidth));
    const sources = await desktopCapturer.getSources({
      types: [sourceType],
      thumbnailSize: {
        width: Math.max(1, Math.round(sourceWidth * scale)),
        height: Math.max(1, Math.round(sourceHeight * scale)),
      },
    });
    const source = sourceType === 'screen'
      ? sources.find((candidate) => candidate.display_id === targetDisplayId) || sources[0]
      : sources.find((candidate) => candidate.name === sourceTitle)
        || sources.find((candidate) => candidate.name.toLowerCase().includes(sourceTitle.toLowerCase()))
        || sources.find((candidate) => sourceTitle.toLowerCase().includes(candidate.name.toLowerCase()));
    if (!source) return null;
    const jpeg = source.thumbnail.toJPEG(quality);
    if (!jpeg || jpeg.length === 0) return null;
    const thumbnailSize = source.thumbnail.getSize();
    return {
      image: { mimeType: 'image/jpeg', data: jpeg.toString('base64') },
      description: `Screenshot of ${sourceType === 'window' ? `window "${source.name}"` : sourceTitle}`
        + ` (${thumbnailSize.width}x${thumbnailSize.height}, ${jpeg.length} bytes, JPEG quality ${quality})`,
    };
  }

  async function runCommand(command: ComputerCommand): Promise<ComputerCommandResult> {
    const action = String(command.action || '').trim();
    if (!action) throw new Error('computer command requires action');
    if (process.platform !== 'win32') {
      throw new Error('computer use is currently supported on Windows only');
    }
    if (action === 'screenshot') {
      const screenshot = await captureScreenshot(command);
      if (!screenshot) throw new Error(command.window ? `window capture failed: ${command.window}` : 'screen capture failed');
      return { text: screenshot.description, image: screenshot.image };
    }
    const response = await callPowerShell({
      action,
      window: command.window ?? null,
      ref: command.ref ?? null,
      to: command.to ?? null,
      text: command.text ?? null,
      keys: command.keys ?? null,
      dy: command.dy ?? null,
      app: command.app ?? null,
    });
    if (!response.ok) throw new Error(response.error || 'computer command failed');
    const text = String(response.result?.text || 'OK');
    return { text };
  }

  function executeSerialized(command: ComputerCommand): Promise<ComputerCommandResult> {
    const run = commandChain.then(() => runCommand(command));
    commandChain = run.catch(() => undefined);
    return run;
  }

  async function readRequestBody(request: IncomingMessage): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) {
          reject(new Error('request too large'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  function respond(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
  }

  function writeDiscovery(port: number): void {
    const directory = mixdogDataDirectory();
    mkdirSync(directory, { recursive: true });
    discoveryPath = join(directory, DISCOVERY_FILE);
    writeFileSync(discoveryPath, `${JSON.stringify({
      version: DISCOVERY_VERSION,
      port,
      token,
      pid: process.pid,
      startedAt: Date.now(),
    })}\n`);
    try {
      chmodSync(discoveryPath, 0o600);
    } catch { /* Windows ACLs: the per-user data dir is already private */ }
  }

  function heartbeatDiscovery(port: number): void {
    if (!discoveryPath) return;
    try {
      const now = new Date();
      utimesSync(discoveryPath, now, now);
    } catch {
      try {
        writeDiscovery(port);
      } catch { /* data dir gone mid-shutdown */ }
    }
  }

  server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/command') {
        respond(response, 404, { ok: false, error: 'not found' });
        return;
      }
      if (String(request.headers.authorization || '') !== `Bearer ${token}`) {
        respond(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      let command: ComputerCommand;
      try {
        command = JSON.parse(await readRequestBody(request)) as ComputerCommand;
      } catch (error) {
        respond(response, 400, { ok: false, error: `invalid request: ${(error as Error).message}` });
        return;
      }
      try {
        const value = await executeSerialized(command);
        respond(response, 200, { ok: true, value });
      } catch (error) {
        respond(response, 200, { ok: false, error: (error as Error).message || String(error) });
      }
    })().catch(() => {
      try { response.destroy(); } catch { /* already gone */ }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server?.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    if (port) {
      try {
        writeDiscovery(port);
        heartbeat = setInterval(() => heartbeatDiscovery(port), HEARTBEAT_MS);
        heartbeat.unref?.();
      } catch (error) {
        console.error('computer bridge discovery write failed:', error);
      }
    }
  });
  // Warm the PowerShell host now: the first command otherwise absorbs the full
  // cold-start cost of Add-Type compiling UIAutomation + WinForms + the inline
  // C#, which alone can blow past a command timeout. Starting at bridge
  // creation lets that finish during idle time before the first agent call.
  try { ensurePowerShell(); } catch { /* retried lazily on first command */ }

  return {
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (ps && !ps.killed) {
        try { ps.kill(); } catch { /* already gone */ }
      }
      ps = null;
      if (hostScriptPath) {
        try { unlinkSync(hostScriptPath); } catch { /* already gone */ }
      }
      hostScriptPath = null;
      if (discoveryPath) {
        try {
          const current = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { token?: string };
          if (current?.token === token) unlinkSync(discoveryPath);
        } catch { /* replaced or already gone */ }
      }
      await new Promise<void>((resolve) => {
        if (!server) { resolve(); return; }
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}