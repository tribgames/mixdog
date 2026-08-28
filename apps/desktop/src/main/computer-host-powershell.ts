/**
 * Computer-use host — main-process owner of local Windows desktop control and
 * of the loopback bridge that lets the session runtime's `computer` tool drive
 * it. Windows only for now.
 *
 * Engine: one resident PowerShell worker per agent session holds .NET UI
 * Automation state (an element map that survives between snapshot and invoke,
 * which spawning per command could not) and dispatches Win32 input. Screenshots are captured
 * on demand in Electron via desktopCapturer, not PowerShell. The runtime half discovers
 * this bridge through a heartbeated data-dir file, so the tool surface exists
 * only while the desktop app runs with Computer Use enabled — no daemon
 * protocol change.
 *
 * The PowerShell recipes (UIA tree walk, InvokePattern/ValuePattern, Win32
 * input) follow the public Microsoft UI Automation and user32 APIs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, desktopCapturer, nativeImage, screen, type NativeImage } from 'electron';
import {
  computeComputerWindowTransition,
  launchTransitionConfirmsTarget,
  normalizeComputerWindowRecords,
  type ComputerWindowRecord,
  type ComputerWindowTransition,
} from './computer-window-transition';
import {
  chromeOwnedConsentAllowRef,
  chromeNativeAddressField,
  chromeSetupControl,
  CHROME_REMOTE_DEBUGGING_URL,
  type ChromeUiaAncestor,
  type ChromeUiaElement,
} from './browser-chrome-uia';
import { beginComputerOperation } from './human-only-approval';

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
const DEFAULT_CAPTURE_AFTER_DELAY_MS = 150;
const MAX_CAPTURE_AFTER_DELAY_MS = 2_000;
const DEFAULT_CAPTURE_MAX_ELEMENTS = 80;
const DEFAULT_OCR_MAX_WORDS = 300;
const MAX_OCR_WORDS = 1_000;
const SCREENSHOT_SAMPLE_LIMIT = 4_096;
const SCREENSHOT_NEAR_BLACK_CHANNEL = 4;
const SCREENSHOT_NEAR_WHITE_CHANNEL = 251;
const SCREENSHOT_UNUSABLE_RATIO = 0.995;
const ABORT_CLEANUP_TIMEOUT_MS = 5_000;
const LAUNCH_SUCCESSOR_TIMEOUT_MS = 4_000;
const LAUNCH_POLL_INTERVAL_MS = 100;
const OWNED_CAPTURE_TIMEOUT_MS = 750;
const DESKTOP_CAPTURE_TIMEOUT_MS = 2_000;
const suppressedSequenceCaptures = new WeakSet<object>();
const trustedSequenceContinuations = new WeakSet<object>();

function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(2));
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const ELEMENT_ALIAS_ACTIONS = new Set([
  'invoke', 'set_value', 'toggle',
  'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'mouse_move', 'drag', 'type', 'key', 'scroll',
]);
const PIXEL_ALIAS_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'mouse_move', 'scroll', 'type',
]);
const OBSERVATION_BOUND_INPUT_ACTIONS = new Set([
  'invoke', 'set_value', 'toggle',
  'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'mouse_move', 'drag', 'type', 'key', 'scroll',
]);
const AUTO_CAPTURE_ACTIONS = new Set([
  ...OBSERVATION_BOUND_INPUT_ACTIONS,
  'focus_window', 'move_window', 'window_state', 'close_window', 'launch',
]);
const ABORT_CLEANUP_PROGRAM = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Globalization;
using System.Runtime.InteropServices;
public static class MixdogAbortCleanup {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, IntPtr extra);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr processId);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static IntPtr ParseWindowId(string value) {
    if (String.IsNullOrWhiteSpace(value)) return IntPtr.Zero;
    string raw = value.Trim();
    if (raw.StartsWith("hwnd:", StringComparison.OrdinalIgnoreCase)) raw = raw.Substring(5);
    if (raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) raw = raw.Substring(2);
    long parsed;
    return Int64.TryParse(raw, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out parsed)
      ? new IntPtr(parsed) : IntPtr.Zero;
  }
  static void Focus(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return;
    ShowWindow(hwnd, 9);
    if (SetForegroundWindow(hwnd) && GetForegroundWindow() == hwnd) return;
    uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint currentThread = GetCurrentThreadId();
    bool attached = foregroundThread != 0 && foregroundThread != currentThread
      && AttachThreadInput(foregroundThread, currentThread, true);
    try {
      ShowWindow(hwnd, 9);
      SetForegroundWindow(hwnd);
    } finally {
      if (attached) AttachThreadInput(foregroundThread, currentThread, false);
    }
  }
  public static void Run(string targetValue, string restoreValue, int cursorX, int cursorY) {
    byte[] keys = new byte[] { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
    foreach (byte key in keys) keybd_event(key, 0, 0x2, UIntPtr.Zero);
    mouse_event(0x04 | 0x10 | 0x40, 0, 0, 0, IntPtr.Zero);
    IntPtr target = ParseWindowId(targetValue);
    IntPtr restore = ParseWindowId(restoreValue);
    if (target != IntPtr.Zero && GetForegroundWindow() == target) {
      SetCursorPos(cursorX, cursorY);
      if (restore != IntPtr.Zero && restore != target) Focus(restore);
    }
  }
}
"@
[MixdogAbortCleanup]::Run(
  $env:MIXDOG_ABORT_TARGET,
  $env:MIXDOG_ABORT_RESTORE,
  [int]$env:MIXDOG_ABORT_CURSOR_X,
  [int]$env:MIXDOG_ABORT_CURSOR_Y)
`;

interface ComputerCommand {
  action: string;
  steps?: Array<Partial<ComputerCommand> & { action: string }>;
  window?: string;
  window_id?: string;
  frame_id?: string;
  ref?: string;
  element?: number;
  text?: string;
  keys?: string;
  dy?: number;
  amount?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  app?: string;
  /** drag destination ref. */
  to?: string;
  to_element?: number;
  /** click family without ref: frame pixels; move_window: physical coordinates. */
  x?: number;
  y?: number;
  /** drag destination in frame pixels. */
  to_x?: number;
  to_y?: number;
  /** move_window size in physical pixels. */
  width?: number;
  height?: number;
  /** click family: modifier keys held during the click, e.g. "ctrl+shift". */
  modifiers?: string;
  delivery?: 'background' | 'foreground';
  read_only?: boolean;
  /** wait: seconds to pause (0..30). */
  duration?: number;
  /** zoom: [x0, y0, x1, y1] region in frame pixels. */
  region?: number[];
  /** screenshot display index (0-based) for multi-monitor setups. */
  screen?: number;
  quality?: number;
  maxWidth?: number;
  query?: string;
  role?: string;
  visible_only?: boolean;
  include_noninteractive?: boolean;
  include_structure?: boolean;
  max_elements?: number;
  continuation?: string;
  mode?: 'state' | 'som' | 'vision' | 'ax';
  include_ocr?: boolean;
  ocr_language?: string;
  max_ocr_words?: number;
  state?: 'minimize' | 'maximize' | 'restore';
  session_id?: string;
  capture_after?: boolean;
  capture_delay_ms?: number;
  capture_after_mode?: 'state' | 'som' | 'vision' | 'ax';
  capture_after_max_elements?: number;
  capture_after_include_ocr?: boolean;
  capture_after_ocr_language?: string;
  capture_after_max_ocr_words?: number;
}

interface ComputerCommandResult {
  text: string;
  image?: { mimeType: string; data: string };
}

interface PowerShellResponse {
  id: number;
  ok: boolean;
  result?: {
    text?: string;
    title?: string;
    window_id?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    [key: string]: unknown;
  };
  error?: string;
}

interface CaptureFrame {
  id: string;
  sessionId: string;
  kind: 'screen' | 'window';
  sourceId: string;
  windowId?: string;
  displayId?: string;
  originX: number;
  originY: number;
  physicalWidth: number;
  physicalHeight: number;
  captureWidth: number;
  captureHeight: number;
  windowX?: number;
  windowY?: number;
  windowWidth?: number;
  windowHeight?: number;
  targetWindowX?: number;
  targetWindowY?: number;
  targetWindowWidth?: number;
  targetWindowHeight?: number;
  relatedWindowIds?: string[];
  displayX?: number;
  displayY?: number;
  displayWidth?: number;
  displayHeight?: number;
}

interface ObservedWindowScope {
  primaryWindowId: string;
  relatedWindowIds: string[];
}

interface PixelUnavailable {
  code: 'pixel_unavailable';
  reason: 'capture_source_unavailable'
    | 'empty_frame'
    | 'blank_black_frame'
    | 'blank_white_frame'
    | 'coordinate_mismatch';
  message: string;
  sampled_pixels?: number;
  near_black_ratio?: number;
  near_white_ratio?: number;
  expected_aspect_ratio?: number;
  actual_aspect_ratio?: number;
}

interface ScreenshotCapture {
  image?: { mimeType: string; data: string };
  description: string;
  frameId?: string;
  windowId?: string;
  frame?: CaptureFrame;
  pixelUnavailable?: PixelUnavailable;
}

interface ComputerElementRecord extends ChromeUiaElement {
  mark: number;
  center_x: number;
  center_y: number;
  frame_id?: string;
  window_id?: string;
}

interface ElementAliasTarget {
  kind: 'ref' | 'point';
  ref?: string;
  frameId?: string;
  windowId?: string;
  x?: number;
  y?: number;
}

interface OcrWordRecord {
  text: string;
  line: number;
  x: number;
  y: number;
  width: number;
  height: number;
  center_x: number;
  center_y: number;
}

interface InputRecoveryState {
  targetWindowId: string;
  restoreWindowId: string;
  cursorX: number;
  cursorY: number;
}

const BLOCKED_COMPUTER_KEY_PATTERNS = [
  /^%\{F4\}$/i,
  /^\^%\{(?:DEL|DELETE)\}$/i,
  /^#(?:L|\{L\})$/i,
];

const BLOCKED_COMPUTER_TYPE_PATTERNS = [
  /\bcurl\b[^|\r\n]*\|\s*(?:bash|sh)\b/i,
  /\bwget\b[^|\r\n]*\|\s*(?:bash|sh)\b/i,
  /\bsudo\s+rm\s+-[^\r\n]*[rf]/i,
  /\brm\s+-rf\s+\/\s*$/i,
  /:\s*\(\)\s*\{\s*:\|:\s*&\s*\}/,
];

const BLOCKED_COMPUTER_LAUNCH_ALWAYS_PATTERNS = [
  /[\r\n\0]|javascript:/i,
];
const BLOCKED_COMPUTER_NON_HTTP_LAUNCH_PATTERNS = [
  /&&|\|\|/,
  /(?:^|[\\/"'])\s*(?:cmd|powershell|pwsh|wt|wsl|bash|sh|zsh|fish|nu|wscript|cscript|mshta|rundll32|regsvr32)(?:\.exe)?(?:["'\s]|$)/i,
  /\.(?:bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|appref-ms)(?:["']?\s*)$/i,
];

function assertSafeComputerInput(command: ComputerCommand): void {
  if (command.action === 'key') {
    const keys = String(command.keys || '').replace(/\s+/g, '');
    if (BLOCKED_COMPUTER_KEY_PATTERNS.some((pattern) => pattern.test(keys))) {
      throw new Error('blocked_input: destructive or session-ending key combination');
    }
  }
  if (command.action === 'type') {
    const text = String(command.text || '');
    if (BLOCKED_COMPUTER_TYPE_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new Error('blocked_input: dangerous shell payload in type text');
    }
  }
  if (command.action === 'launch') {
    const app = String(command.app || '').trim();
    const httpUrl = /^https?:\/\//i.test(app);
    if (!app
      || BLOCKED_COMPUTER_LAUNCH_ALWAYS_PATTERNS.some((pattern) => pattern.test(app))
      || (!httpUrl
        && BLOCKED_COMPUTER_NON_HTTP_LAUNCH_PATTERNS.some((pattern) => pattern.test(app)))) {
      throw new Error('blocked_input: shell, script-host, or shortcut launch is unavailable in Computer Use');
    }
  }
}

function electronWindowForNativeId(windowId: string | undefined): BrowserWindow | null {
  const raw = String(windowId || '')
    .trim()
    .replace(/^hwnd:/i, '')
    .replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(raw)) return null;
  const expected = BigInt(`0x${raw}`);
  try {
    return BrowserWindow.getAllWindows().find((candidate) => {
      if (candidate.isDestroyed()) return false;
      const handle = candidate.getNativeWindowHandle();
      let value = 0n;
      for (let index = handle.length - 1; index >= 0; index -= 1) {
        value = (value << 8n) | BigInt(handle[index] ?? 0);
      }
      return value === expected;
    }) ?? null;
  } catch {
    return null;
  }
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
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$AccessibilityAssemblyPath = [Accessibility.IAccessible].Assembly.Location
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',$AccessibilityAssemblyPath) -TypeDefinition @"
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
    object[] children = new object[count];
    int obtained;
    int hr = AccessibleChildren(accessible, 0, count, children, out obtained);
    if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    for (int index = 0; index < obtained; index++) {
      if (result.Count >= maximum) break;
      object child = children[index];
      IAccessible nested = child as IAccessible;
      string childPath = path + "/" + index.ToString(CultureInfo.InvariantCulture);
      if (nested != null) {
        Traverse(nested, childPath, windowId, result, visited, maximum, depth + 1, true);
        continue;
      }
      int childId;
      try { childId = Convert.ToInt32(child, CultureInfo.InvariantCulture); } catch { continue; }
      MixMsaaNode simple = new MixMsaaNode(accessible, childId, childPath, windowId);
      if (simple.Refresh()) result.Add(simple);
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
  public static WindowCaptureInfo CaptureVisibleWindow(IntPtr h) {
    if (!IsWindowHandle(h)) {
      throw new InvalidOperationException("capture_source_unavailable|exact native window is stale or invalid");
    }
    if (IsIconic(h)) {
      throw new InvalidOperationException("capture_source_unavailable|minimized native window has no visible pixels");
    }
    RECT bounds;
    if (!GetWindowRect(h, out bounds)) {
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
}
"@
[void][MixWin32]::MakeDpiAware()
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$Sessions = @{}
$script:CurrentSession = $null

function Get-SessionState($id) {
  $key = if ($id) { [string]$id } else { 'default' }
  if (-not $Sessions.ContainsKey($key)) {
    $Sessions[$key] = @{
      Map = @{}
      Generation = 0
      LastFocus = [IntPtr]::Zero
      OriginalFocus = [IntPtr]::Zero
    }
  }
  return $Sessions[$key]
}

function Get-CurrentSession {
  if ($null -eq $script:CurrentSession) { throw 'computer session is not initialized' }
  return $script:CurrentSession
}

function Await-WinRt($operation, [Type]$resultType) {
  if ($null -eq $script:WinRtAsTaskGeneric) {
    $script:WinRtAsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
      Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation')
      })[0]
  }
  $asTask = $script:WinRtAsTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

function Resolve-WindowInfo($title, $windowId) {
  if ($windowId) {
    $handle = [MixWin32]::ParseWindowId([string]$windowId)
    if (-not [MixWin32]::IsWindowHandle($handle)) { throw "window_id is stale or invalid: $windowId" }
    return [MixWin32]::Info($handle)
  }
  if (-not $title) {
    $handle = [MixWin32]::Foreground()
    if (-not [MixWin32]::IsWindowHandle($handle)) { throw 'foreground window not found' }
    return [MixWin32]::Info($handle)
  }
  $exact = New-Object System.Collections.ArrayList
  $partial = New-Object System.Collections.ArrayList
  foreach ($info in [MixWin32]::Windows()) {
    if ($info.Title -eq $title) { [void]$exact.Add($info) }
    elseif ($info.Title -and $info.Title.ToLower().Contains(([string]$title).ToLower())) { [void]$partial.Add($info) }
  }
  if ($exact.Count -eq 1) { return $exact[0] }
  if ($exact.Count -gt 1) {
    $ids = @($exact | ForEach-Object { $_.Id }) -join ' | '
    throw "window title is ambiguous: $title (ids: $ids); use window_id"
  }
  if ($partial.Count -eq 1) { return $partial[0] }
  if ($partial.Count -gt 1) {
    $matches = @($partial | ForEach-Object { "$($_.Id) $($_.Title)" }) -join ' | '
    throw "window title is ambiguous: $title (matches: $matches); use window_id"
  }
  throw "window not found: $title"
}

function Find-Window($title, $windowId) {
  $info = Resolve-WindowInfo $title $windowId
  try { return $AE::FromHandle($info.Handle) } catch { throw "window has no UI Automation root: $($info.Id) $($info.Title)" }
}

function Do-ListWindows {
  $lines = New-Object System.Collections.ArrayList
  $windows = New-Object System.Collections.ArrayList
  foreach ($info in [MixWin32]::Windows()) {
    $focus = if ($info.Focused) { ' focused' } else { '' }
    $state = if ($info.Minimized) { ' minimized' } elseif ($info.Maximized) { ' maximized' } else { '' }
    $owner = if ($info.OwnerId) { " owner=$($info.OwnerId)" } else { '' }
    $title = if ($info.Title) { $info.Title } else { '<untitled>' }
    [void]$lines.Add(('{0} | app={1} pid={2} class={3}{4}{5}{6} | "{7}" | {8}x{9} at {10},{11}' -f
      $info.Id, $info.App, $info.Pid, $info.ClassName, $owner, $focus, $state, $title,
      $info.Width, $info.Height, $info.X, $info.Y))
    [void]$windows.Add([ordered]@{
      id = [string]$info.Id
      title = [string]$info.Title
      class_name = [string]$info.ClassName
      app = [string]$info.App
      pid = [long]$info.Pid
      owner_id = [string]$info.OwnerId
      focused = [bool]$info.Focused
      minimized = [bool]$info.Minimized
      maximized = [bool]$info.Maximized
      x = [int]$info.X
      y = [int]$info.Y
      width = [int]$info.Width
      height = [int]$info.Height
    })
  }
  if ($lines.Count -eq 0) { return @{ text = 'No windows found.'; windows = @() } }
  return @{
    text = ('Windows:' + [Environment]::NewLine + ($lines -join [Environment]::NewLine))
    windows = @($windows)
  }
}

function Do-WindowSnapshot {
  $windows = New-Object System.Collections.ArrayList
  foreach ($info in [MixWin32]::WindowSnapshot()) {
    [void]$windows.Add([ordered]@{
      id = [string]$info.Id
      title = [string]$info.Title
      class_name = [string]$info.ClassName
      app = ''
      pid = [long]$info.Pid
      owner_id = [string]$info.OwnerId
      focused = [bool]$info.Focused
      minimized = [bool]$info.Minimized
      maximized = [bool]$info.Maximized
      x = [int]$info.X
      y = [int]$info.Y
      width = [int]$info.Width
      height = [int]$info.Height
    })
  }
  return @{ windows = @($windows) }
}

function Do-RelatedWindows($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  return @{ window_ids = @([MixWin32]::RelatedWindowIds($info.Handle)) }
}

function Get-ElementPage($total, $offset, $max) {
  $end = [math]::Min([int]$total, [int]$offset + [int]$max)
  return @{
    End = $end
    Continuation = $(if ($end -lt [int]$total) { [string]$end } else { $null })
  }
}

function Format-ObservationValue($value, $maximum = 120) {
  $text = ([string]$value) -replace '[\r\n\t]+',' '
  $text = $text.Replace('"', "'").Trim()
  if ($text.Length -gt [int]$maximum) { return $text.Substring(0, [int]$maximum) }
  return $text
}

function Get-ElementObservation($el) {
  $observation = @{
    Name = [string]$el.Cached.Name
    AutomationId = [string]$el.Cached.AutomationId
    Value = ''
    Toggle = ''
    Selected = ''
    Expanded = ''
    Range = ''
    CanInvoke = $false
    CanSetValue = $false
    CanToggle = $false
    CanScroll = $false
  }
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
      $observation.Value = [string]$pat.Current.Value
      $observation.CanSetValue = $true
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
      $observation.Toggle = [string]$pat.Current.ToggleState
      $observation.CanToggle = $true
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
      $observation.Selected = [string]$pat.Current.IsSelected
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
      $observation.Expanded = [string]$pat.Current.ExpandCollapseState
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$pat)) {
      $observation.Range = [string]$pat.Current.Value
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat) -or
        $el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
      $observation.CanInvoke = $true
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pat)) {
      $observation.CanScroll = $true
    }
  } catch {}
  return [pscustomobject]$observation
}

function Get-MsaaObservation($node) {
  return [pscustomobject]@{
    Name = [string]$node.Name
    AutomationId = ''
    Value = [string]$node.Value
    Toggle = ''
    Selected = ''
    Expanded = ''
    Range = ''
    CanInvoke = -not [string]::IsNullOrWhiteSpace([string]$node.DefaultAction)
    CanSetValue = [string]$node.ControlType -in @('Edit','ComboBox')
    CanToggle = $false
    CanScroll = $false
    Source = 'msaa'
    Role = [string]$node.Role
    State = [string]$node.State
    DefaultAction = [string]$node.DefaultAction
  }
}

function Format-StructuredObservationState($observation, $kind) {
  if ($kind -eq 'msaa') {
    return Format-ObservationValue $observation.State 200
  }
  $parts = New-Object System.Collections.ArrayList
  if ($observation.Toggle) { [void]$parts.Add('toggle=' + $observation.Toggle) }
  if ($observation.Selected) { [void]$parts.Add('selected=' + $observation.Selected) }
  if ($observation.Expanded) { [void]$parts.Add('expanded=' + $observation.Expanded) }
  if ($observation.Range) { [void]$parts.Add('range=' + $observation.Range) }
  return ($parts -join ';')
}

function Get-ElementStructure($el) {
  $ancestors = New-Object System.Collections.ArrayList
  $parentRuntimeId = ''
  $inDocument = $false
  $parent = $Walker.GetParent($el)
  for ($depth = 0; $depth -lt 80 -and $null -ne $parent; $depth++) {
    if ([System.Windows.Automation.Automation]::Compare($parent, $AE::RootElement)) { break }
    $role = ''
    $name = ''
    try { $role = $parent.Current.ControlType.ProgrammaticName -replace 'ControlType\.','' } catch {}
    try { $name = [string]$parent.Current.Name } catch {}
    $runtimeId = Get-ElRuntimeKey $parent
    if ($depth -eq 0) { $parentRuntimeId = $runtimeId }
    if ($role -eq 'Document') { $inDocument = $true }
    [void]$ancestors.Add([ordered]@{
      runtime_id = [string]$runtimeId
      role = [string]$role
      name = (Format-ObservationValue $name 200)
    })
    $parent = $Walker.GetParent($parent)
  }
  $className = ''
  $hasKeyboardFocus = $false
  try { $className = [string]$el.Current.ClassName } catch {}
  try { $hasKeyboardFocus = [bool]$el.Current.HasKeyboardFocus } catch {}
  return [ordered]@{
    runtime_id = [string](Get-ElRuntimeKey $el)
    parent_runtime_id = [string]$parentRuntimeId
    class_name = [string]$className
    has_keyboard_focus = [bool]$hasKeyboardFocus
    in_document = [bool]$inDocument
    ancestors = @($ancestors)
  }
}

function Snapshot-Window($req) {
  $snapshotClock = [System.Diagnostics.Stopwatch]::StartNew()
  $info = Resolve-WindowInfo $req.window $req.window_id
  $win = Find-Window $req.window $req.window_id
  $state = Get-CurrentSession
  $state.Generation = [int]$state.Generation + 1
  $state.Map.Clear()
  $generation = $state.Generation
  $visibleOnly = if ($null -ne $req.visible_only) { [bool]$req.visible_only } else { $true }
  $includeNoninteractive = $null -ne $req.include_noninteractive -and [bool]$req.include_noninteractive
  $bounded = $null -ne $req.bounded -and [bool]$req.bounded
  $max = if ($null -ne $req.max_elements) { [int]$req.max_elements } else { 200 }
  if ($max -lt 1 -or $max -gt 1000) { throw 'max_elements must be 1..1000' }
  $offset = 0
  if ($req.continuation) {
    if (-not [int]::TryParse([string]$req.continuation, [ref]$offset) -or $offset -lt 0) {
      throw 'continuation must be a non-negative integer returned by snapshot/find'
    }
  }
  $query = ([string]$req.query).Trim().ToLower()
  $role = ([string]$req.role).Trim().ToLower()
  # Fetch the selected control classes once with cached properties, then filter
  # and page locally. The broader observation view is explicit so ordinary
  # snapshots do not flood the model with layout-only nodes.
  $interactiveCtTypes = @('Button','Edit','CheckBox','RadioButton','ComboBox','List','ListItem',
    'MenuItem','TabItem','Hyperlink','Tree','TreeItem','Slider','Document','Spinner','SplitButton')
  $ctTypes = @($interactiveCtTypes)
  if ($includeNoninteractive) {
    $ctTypes += @('Text','Custom','Group','Pane','Image','DataGrid','DataItem','Header',
      'HeaderItem','Table','ProgressBar','StatusBar','ToolBar','TitleBar','Separator')
  }
  $ctTypes = @($ctTypes | Select-Object -Unique)
  $conds = foreach ($t in $ctTypes) {
    New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::$t)
  }
  $cond = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conds)
  $cr = New-Object System.Windows.Automation.CacheRequest
  [void]$cr.Add($AE::NameProperty)
  [void]$cr.Add($AE::AutomationIdProperty)
  [void]$cr.Add($AE::ControlTypeProperty)
  [void]$cr.Add($AE::BoundingRectangleProperty)
  [void]$cr.Add($AE::IsEnabledProperty)
  [void]$cr.Add($AE::IsOffscreenProperty)
  $act = $cr.Activate()
  $uiaFindStarted = $snapshotClock.Elapsed.TotalMilliseconds
  try { $els = $win.FindAll($TS::Descendants, $cond) } finally { $act.Dispose() }
  $uiaFindMs = $snapshotClock.Elapsed.TotalMilliseconds - $uiaFindStarted
  if ($els.Count -gt 5000) {
    throw "accessibility candidate limit exceeded: $($els.Count) > 5000; narrow the role/query or use the interactive view"
  }
  $matches = New-Object System.Collections.ArrayList
  $seen = @{}
  $uiaFormatStarted = $snapshotClock.Elapsed.TotalMilliseconds
  foreach ($el in $els) {
    $r = $el.Cached.BoundingRectangle
    if ([double]::IsInfinity($r.Width) -or $r.Width -le 0 -or $r.Height -le 0) { continue }
    if ($visibleOnly) {
      if ($el.Cached.IsOffscreen) { continue }
      if ($r.X + $r.Width -le $info.X -or $r.X -ge $info.X + $info.Width -or
          $r.Y + $r.Height -le $info.Y -or $r.Y -ge $info.Y + $info.Height) { continue }
    }
    $ct = $el.Cached.ControlType.ProgrammaticName -replace 'ControlType\.',''
    if ($role -and $ct.ToLower() -ne $role) { continue }
    $observation = Get-ElementObservation $el
    $search = @(
      $observation.Name
      $observation.AutomationId
      $observation.Value
      $ct
    ) -join ' '
    if ($query -and -not $search.ToLower().Contains($query)) { continue }
    $dedupeKey = '{0}|{1}|{2}|{3}|{4}|{5}' -f
      [math]::Round($r.X), [math]::Round($r.Y), [math]::Round($r.Width), [math]::Round($r.Height),
      ([string]$observation.Name).ToLower(), $ct.ToLower()
    $record = @{
      Kind = 'uia'
      Element = $el
      Observation = $observation
      ControlType = $ct
      X = [double]$r.X
      Y = [double]$r.Y
      Width = [double]$r.Width
      Height = [double]$r.Height
      Enabled = [bool]$el.Cached.IsEnabled
      DedupeKey = $dedupeKey
    }
    [void]$matches.Add($record)
    $seen[$dedupeKey] = $record
  }
  $uiaFormatMs = $snapshotClock.Elapsed.TotalMilliseconds - $uiaFormatStarted
  $candidateCount = $els.Count
  $msaaWarning = ''
  $msaaSnapshotStarted = $snapshotClock.Elapsed.TotalMilliseconds
  $msaaMaximum = if ($bounded) {
    [math]::Min(5000, [math]::Max(200, ([int]$offset + [int]$max) * 8))
  } else {
    5000
  }
  $modernChromium = ([string]$info.ClassName) -like 'Chrome_WidgetWin*'
  if ($bounded -and ($matches.Count -gt 0 -or $modernChromium)) {
    $msaaNodes = @()
    $msaaWarning = if ($matches.Count -gt 0) {
      'MSAA enrichment skipped: UIA supplied the bounded capture'
    } else {
      'MSAA enrichment skipped: Chromium capture will use pixels or OCR'
    }
  } else {
    try {
      $msaaNodes = @([MixMsaa]::Snapshot($info.Handle, $info.Id, $msaaMaximum))
    } catch {
      throw "MSAA snapshot failed for $($info.Id): $([string]$_.Exception.Message)"
    }
  }
  $msaaSnapshotMs = $snapshotClock.Elapsed.TotalMilliseconds - $msaaSnapshotStarted
  $candidateCount += $msaaNodes.Count
  if ($candidateCount -gt 5000) {
    throw "accessibility candidate limit exceeded: $candidateCount > 5000; narrow the role/query"
  }
  foreach ($node in $msaaNodes) {
    if (-not $node.Refresh()) { continue }
    if ($visibleOnly) {
      if ($node.Offscreen) { continue }
      if ($node.X + $node.Width -le $info.X -or $node.X -ge $info.X + $info.Width -or
          $node.Y + $node.Height -le $info.Y -or $node.Y -ge $info.Y + $info.Height) { continue }
    }
    $ct = [string]$node.ControlType
    if ($ct -in @('Window','Client')) { continue }
    if (-not $includeNoninteractive -and -not ($interactiveCtTypes -contains $ct)) { continue }
    if ($role -and $ct.ToLower() -ne $role) { continue }
    $observation = Get-MsaaObservation $node
    $search = @(
      $observation.Name
      $observation.Value
      $observation.Role
      $observation.State
      $observation.DefaultAction
      $ct
    ) -join ' '
    if ($query -and -not $search.ToLower().Contains($query)) { continue }
    $dedupeKey = '{0}|{1}|{2}|{3}|{4}|{5}' -f
      $node.X, $node.Y, $node.Width, $node.Height,
      ([string]$node.Name).ToLower(), $ct.ToLower()
    $existing = $seen[$dedupeKey]
    $addsCapability = $null -ne $existing -and (
      ($observation.CanInvoke -and -not $existing.Observation.CanInvoke) -or
      ($observation.CanSetValue -and -not $existing.Observation.CanSetValue)
    )
    if ($null -ne $existing -and -not $addsCapability) { continue }
    $record = @{
      Kind = 'msaa'
      Msaa = $node
      Observation = $observation
      ControlType = $ct
      X = [double]$node.X
      Y = [double]$node.Y
      Width = [double]$node.Width
      Height = [double]$node.Height
      Enabled = [bool]$node.Enabled
      DedupeKey = $dedupeKey
    }
    [void]$matches.Add($record)
    if ($null -eq $existing) { $seen[$dedupeKey] = $record }
  }
  $lines = New-Object System.Collections.ArrayList
  $elementsOut = New-Object System.Collections.ArrayList
  [void]$lines.Add("Window: $($info.Title) [$($info.Id)]")
  $view = if ($includeNoninteractive) { 'all' } else { 'interactive' }
  [void]$lines.Add("Elements: total=$($matches.Count) candidates=$candidateCount view=$view offset=$offset max=$max generation=$generation")
  if ($msaaWarning) { [void]$lines.Add("Warning: $msaaWarning") }
  $page = Get-ElementPage $matches.Count $offset $max
  $end = $page.End
  for ($i = $offset; $i -lt $end; $i++) {
    $record = $matches[$i]
    $observation = $record.Observation
    $ct = $record.ControlType
    $ref = 's{0}:e{1}' -f $generation, ($i - $offset)
    if ($record.Kind -eq 'msaa') {
      Set-MsaaRef $state $ref $record.Msaa $info.Id $generation
    } else {
      Set-ElRef $state $ref $record.Element $info.Id $generation
    }
    $mark = ($i - $offset) + 1
    $nm = Format-ObservationValue $observation.Name 80
    $cx = [math]::Round($record.X + $record.Width/2); $cy = [math]::Round($record.Y + $record.Height/2)
    $en = if ($record.Enabled) { '' } else { ' (disabled)' }
    $details = New-Object System.Collections.ArrayList
    if ($record.Kind -eq 'msaa') { [void]$details.Add('source=msaa') }
    if ($observation.AutomationId) { [void]$details.Add('id="' + (Format-ObservationValue $observation.AutomationId 80) + '"') }
    if ($observation.Value) { [void]$details.Add('value="' + (Format-ObservationValue $observation.Value 120) + '"') }
    if ($observation.Toggle) { [void]$details.Add('toggle=' + $observation.Toggle) }
    if ($observation.Selected) { [void]$details.Add('selected=' + $observation.Selected) }
    if ($observation.Expanded) { [void]$details.Add('expanded=' + $observation.Expanded) }
    if ($observation.Range) { [void]$details.Add('range=' + $observation.Range) }
    if ($record.Kind -eq 'msaa' -and $observation.Role) {
      [void]$details.Add('role="' + (Format-ObservationValue $observation.Role 80) + '"')
    }
    if ($record.Kind -eq 'msaa' -and $observation.State) {
      [void]$details.Add('state="' + (Format-ObservationValue $observation.State 120) + '"')
    }
    if ($record.Kind -eq 'msaa' -and $observation.DefaultAction) {
      [void]$details.Add('default_action="' + (Format-ObservationValue $observation.DefaultAction 80) + '"')
    }
    $actions = New-Object System.Collections.ArrayList
    if ($record.Enabled) { [void]$actions.Add('click') }
    if ($observation.CanInvoke) { [void]$actions.Add('invoke') }
    if ($observation.CanSetValue) { [void]$actions.Add('set_value') }
    if ($observation.CanToggle) { [void]$actions.Add('toggle') }
    if ($observation.CanScroll) { [void]$actions.Add('scroll') }
    $elementOut = [ordered]@{
      mark = [int]$mark
      ref = [string]$ref
      source = $(if ($record.Kind -eq 'msaa') { 'msaa' } else { 'uia' })
      role = [string]$ct
      name = (Format-ObservationValue $observation.Name 200)
      value = (Format-ObservationValue $observation.Value 300)
      state = (Format-StructuredObservationState $observation $record.Kind)
      enabled = [bool]$record.Enabled
      x = [int][math]::Round($record.X)
      y = [int][math]::Round($record.Y)
      width = [int][math]::Round($record.Width)
      height = [int][math]::Round($record.Height)
      center_x = [int]$cx
      center_y = [int]$cy
      actions = @($actions)
    }
    if ($req.include_structure -and $record.Kind -eq 'uia') {
      $structure = Get-ElementStructure $record.Element
      $elementOut.runtime_id = $structure.runtime_id
      $elementOut.parent_runtime_id = $structure.parent_runtime_id
      $elementOut.class_name = $structure.class_name
      $elementOut.has_keyboard_focus = $structure.has_keyboard_focus
      $elementOut.in_document = $structure.in_document
      $elementOut.ancestors = @($structure.ancestors)
    }
    [void]$elementsOut.Add($elementOut)
    $detailText = if ($details.Count) { ' ' + ($details -join ' ') } else { '' }
    [void]$lines.Add(('[{0}] {1} "{2}"{3}{4} @{5},{6}' -f $ref, $ct, $nm, $en, $detailText, $cx, $cy))
  }
  if ($matches.Count -eq 0) { [void]$lines.Add('(no matching elements found)') }
  if ($null -ne $page.Continuation) { [void]$lines.Add("Continuation: $($page.Continuation)") }
  return @{
    text = ($lines -join [Environment]::NewLine)
    window_id = $info.Id
    generation = $generation
    total_elements = $matches.Count
    continuation = $page.Continuation
    elements = @($elementsOut)
    timings_ms = @{
      uia_find_ms = [math]::Round($uiaFindMs, 2)
      uia_format_ms = [math]::Round($uiaFormatMs, 2)
      msaa_snapshot_ms = [math]::Round($msaaSnapshotMs, 2)
      total_ms = [math]::Round($snapshotClock.Elapsed.TotalMilliseconds, 2)
    }
  }
}

function Get-ElRuntimeKey($el) {
  try { return [string](@($el.GetRuntimeId()) -join ',') } catch { return '' }
}

function Set-ElRef($state, $ref, $el, $windowId, $generation) {
  $state.Map[$ref] = @{
    Kind = 'uia'
    Element = $el
    WindowId = [string]$windowId
    Generation = [int]$generation
    RuntimeId = Get-ElRuntimeKey $el
  }
}

function Set-MsaaRef($state, $ref, $node, $windowId, $generation) {
  $state.Map[$ref] = @{
    Kind = 'msaa'
    Msaa = $node
    WindowId = [string]$windowId
    Generation = [int]$generation
    RuntimeId = [string]$node.Key
  }
}

function Get-RefRecord($ref) {
  $map = (Get-CurrentSession).Map
  if (-not $map.ContainsKey($ref)) { throw "ref $ref is stale, from another session, or unknown; take a fresh snapshot/find" }
  $record = $map[$ref]
  if ([int]$record.Generation -ne [int](Get-CurrentSession).Generation) {
    throw "ref $ref is stale; take a fresh snapshot/find"
  }
  if ($record.Kind -eq 'msaa') {
    $top = [MixWin32]::ParseWindowId([string]$record.WindowId)
    if ($null -eq $record.Msaa -or
        (-not [MixWin32]::IsWindowHandle($top)) -or
        ([string]$record.Msaa.WindowId -ne [string]$record.WindowId) -or
        (-not $record.Msaa.Refresh())) {
      throw "ref $ref is stale or its MSAA target changed; take a fresh snapshot/find"
    }
    return $record
  }
  if ($null -eq $record.Element) { throw "ref $ref is stale; take a fresh snapshot/find" }
  $el = $record.Element
  try {
    $top = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
    $runtimeId = Get-ElRuntimeKey $el
    if ((-not [MixWin32]::IsWindowHandle($top)) -or
        ([MixWin32]::WindowId($top) -ne [string]$record.WindowId) -or
        ($runtimeId -ne [string]$record.RuntimeId)) {
      throw "ref $ref no longer identifies the same element"
    }
  } catch {
    throw "ref $ref is stale or its target changed; take a fresh snapshot/find"
  }
  return $record
}

function Get-El($ref) {
  $record = Get-RefRecord $ref
  if ($record.Kind -ne 'uia') { throw "ref $ref is an MSAA element, not a UIA element" }
  return $record.Element
}

function Get-RefTopHandle($record) {
  if ($record.Kind -eq 'msaa') {
    return [MixWin32]::ParseWindowId([string]$record.WindowId)
  }
  return New-Object IntPtr((Get-TopWindow $record.Element).Current.NativeWindowHandle)
}

function Get-ObservableTargetState($target, $action) {
  if ($null -eq $target) { return $null }
  if ($target -is [System.Collections.IDictionary] -and $target.Contains('Kind')) {
    if ($target.Kind -eq 'msaa') {
      try { return [string]$target.Msaa.ObservableState() } catch { return $null }
    }
    return Get-ObservableElementState $target.Element $action
  }
  return Get-ObservableElementState $target $action
}

function New-ActionResult($action, $path, $effect, $verified, $message, $code, $delivery, $windowId) {
  $accepted = $null -eq $code -and $path -ne 'none' -and $effect -ne 'suspected_noop'
  return @{
    text = $message
    action = $action
    path = $path
    effect = $effect
    verified = $verified
    delivery_accepted = $accepted
    goal_verified = $verified
    code = $code
    delivery = $delivery
    window_id = $windowId
  }
}

function Background-Unavailable($action, $message, $windowId, $code = 'background_unavailable') {
  return New-ActionResult $action 'none' 'suspected_noop' $false $message $code 'background' $windowId
}

function Invoke-BackgroundSemantic($ref, [scriptblock]$operation) {
  $record = Get-RefRecord $ref
  $target = Get-RefTopHandle $record
  $foregroundBefore = [MixWin32]::Foreground()
  $result = $null
  try {
    $result = & $operation
  } finally {
    $foregroundAfter = [MixWin32]::Foreground()
    $targetTookFocus = $target -ne [IntPtr]::Zero -and (
      $foregroundAfter -eq $target -or
      [MixWin32]::IsContainedSameProcess($foregroundAfter, $target) -or
      [MixWin32]::IsOwnedBy($foregroundAfter, $target)
    )
    if (
      $foregroundBefore -ne [IntPtr]::Zero -and
      $foregroundBefore -ne $target -and
      [MixWin32]::IsWindowHandle($foregroundBefore) -and
      $targetTookFocus
    ) {
      [void][MixWin32]::Focus($foregroundBefore)
    }
  }
  return $result
}

function Native-BackgroundFailure($action, $exception, $windowId) {
  $detail = [string]$exception.Message
  $code = 'background_unavailable'
  foreach ($candidate in @(
    'background_target_hung',
    'background_blocked_uipi',
    'background_message_rejected',
    'background_unsupported',
    'target_mismatch',
    'stale_target'
  )) {
    if ($detail.Contains($candidate + '|')) {
      $code = $candidate
      $detail = $detail.Substring($detail.IndexOf($candidate + '|') + $candidate.Length + 1)
      $detail = $detail.Trim('"')
      break
    }
  }
  return Background-Unavailable $action $detail $windowId $code
}

function Get-ObservableElementState($el, $action) {
  if ($null -eq $el) { return $null }
  try {
    $parts = New-Object System.Collections.ArrayList
    $pat = $null
    if ($action -in @('click','double_click','right_click','middle_click','triple_click')) {
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
        [void]$parts.Add('toggle=' + [string]$pat.Current.ToggleState)
      }
      $pat = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
        [void]$parts.Add('selected=' + [string]$pat.Current.IsSelected)
      }
      $pat = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
        [void]$parts.Add('expanded=' + [string]$pat.Current.ExpandCollapseState)
      }
    }
    if ($action -in @('key','type')) {
      $pat = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
        [void]$parts.Add('value=' + [string]$pat.Current.Value)
      }
    }
    if ($action -eq 'drag') {
      $pat = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$pat)) {
        [void]$parts.Add('range=' + [string]$pat.Current.Value)
      }
    }
    if ($action -eq 'scroll') {
      $pat = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pat)) {
        [void]$parts.Add('scroll=' + [string]$pat.Current.HorizontalScrollPercent + ',' + [string]$pat.Current.VerticalScrollPercent)
      }
    }
    $nativeHandle = Get-NativeElementHandle $el
    $native = [MixWin32]::NativeObservableState($nativeHandle, $action)
    if ($native) { [void]$parts.Add($native) }
    if ($parts.Count -eq 0) { return $null }
    return [string]($parts -join '|')
  } catch {
    return $null
  }
}

function Complete-NativeAction($action, $messageTarget, $windowId, $before, $targetState, $message) {
  $stateChanged = $false
  if ($null -ne $before) {
    Start-Sleep -Milliseconds 40
    $after = Get-ObservableTargetState $targetState $action
    $stateChanged = $null -ne $after -and $after -ne $before
  }
  $suffix = if ($stateChanged) {
    '; target state changed, but the requested goal is not verified'
  } else {
    '; refresh state before treating it as complete'
  }
  $result = New-ActionResult $action 'win32_message' 'unverifiable' $false ($message + $suffix) $null 'background' $windowId
  $result.state_changed = $stateChanged
  return $result
}

function Do-Invoke($ref) {
  $record = Get-RefRecord $ref
  if ($record.Kind -eq 'msaa') {
    try {
      $defaultAction = [string]$record.Msaa.DefaultAction
      $record.Msaa.DoDefaultAction()
      return New-ActionResult 'invoke' 'msaa_default_action' 'unverifiable' $false "invoked $ref through MSAA default action: $defaultAction" $null 'background' $record.WindowId
    } catch {
      $message = 'MSAA default action failed for {0}: {1}' -f $ref, $_.Exception.Message
      return Background-Unavailable 'invoke' $message $record.WindowId 'msaa_action_failed'
    }
  }
  $el = $record.Element
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
    $before = [string]$pat.Current.ToggleState
    $pat.Toggle()
    $after = [string]$pat.Current.ToggleState
    $verified = $before -ne $after
    return New-ActionResult 'invoke' 'uia_toggle' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified "activated $ref through UIA toggle from $before to $after" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
  }
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
    $pat.Invoke()
    return New-ActionResult 'invoke' 'uia_invoke' 'unverifiable' $false "invoked $ref through UIA" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
  }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
    $pat.Select()
    return New-ActionResult 'invoke' 'uia_selection' 'unverifiable' $false "selected $ref through UIA" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
  }
  $top = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
  return Background-Unavailable 'invoke' "element $ref exposes no semantic toggle/invoke/select action; no physical fallback was attempted" ([MixWin32]::WindowId($top))
}

function Do-SetValue($ref, $text) {
  $record = Get-RefRecord $ref
  if ($record.Kind -eq 'msaa') {
    try {
      $actual = [string]$record.Msaa.SetValue([string]$text)
      $verified = $actual -eq [string]$text
      $effect = if ($verified) { 'confirmed' } else { 'unverifiable' }
      return New-ActionResult 'set_value' 'msaa_value' $effect $verified "set $ref value through MSAA; readback=$verified" $null 'background' $record.WindowId
    } catch {
      $message = 'MSAA value set failed for {0}: {1}' -f $ref, $_.Exception.Message
      return Background-Unavailable 'set_value' $message $record.WindowId 'msaa_value_failed'
    }
  }
  $el = $record.Element
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
    $pat.SetValue($text)
    $actual = ''
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
      $actual = [string]$pat.Current.Value
      if ($actual -eq [string]$text) { break }
      Start-Sleep -Milliseconds 25
    }
    $verified = $actual -eq [string]$text
    $effect = if ($verified) { 'confirmed' } else { 'unverifiable' }
    return New-ActionResult 'set_value' 'uia_value' $effect $verified "set $ref value through UIA; readback=$verified" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
  }
  $topHandle = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
  return Background-Unavailable 'set_value' "element $ref exposes no ValuePattern; no keystroke fallback was attempted" ([MixWin32]::WindowId($topHandle))
}

function Do-Toggle($ref) {
  $record = Get-RefRecord $ref
  if ($record.Kind -eq 'msaa') {
    $result = Do-Invoke $ref
    $result.action = 'toggle'
    return $result
  }
  $el = $record.Element
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
    $before = $pat.Current.ToggleState
    $pat.Toggle()
    $after = $before
    for ($attempt = 0; $attempt -lt 10 -and $before -eq $after; $attempt++) {
      Start-Sleep -Milliseconds 25
      $freshPattern = $null
      try {
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$freshPattern)) {
          $after = $freshPattern.Current.ToggleState
        }
      } catch {}
    }
    $verified = $before -ne $after
    return New-ActionResult 'toggle' 'uia_toggle' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified "toggled $ref from $before to $after" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
  }
  $result = Do-Invoke $ref
  $result.action = 'toggle'
  return $result
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

function Assert-InputTarget($targetHandle, $action) {
  $lastFocus = (Get-CurrentSession).LastFocus
  if ($lastFocus -eq [IntPtr]::Zero) {
    throw "$action requires focus_window first"
  }
  if ([MixWin32]::Foreground() -ne $lastFocus) {
    throw 'foreground changed (the user is working in another window); input not sent. Call focus_window again.'
  }
  if ($targetHandle -eq [IntPtr]::Zero) {
    throw "$action target is not a window"
  }
  if ($targetHandle -ne $lastFocus) {
    throw "$action target differs from the focused window; call focus_window for the intended target"
  }
}

function Get-ElPoint($ref, $requireTopmost = $true) {
  $record = Get-RefRecord $ref
  if ($record.Kind -eq 'msaa') {
    $x = [int]($record.Msaa.X + $record.Msaa.Width/2)
    $y = [int]($record.Msaa.Y + $record.Msaa.Height/2)
    $topHandle = [MixWin32]::ParseWindowId([string]$record.WindowId)
  } else {
    $el = $record.Element
    $r = $el.Current.BoundingRectangle
    if ([double]::IsInfinity($r.Width) -or $r.Width -le 0 -or $r.Height -le 0) { throw "element $ref has no clickable bounds" }
    $x = [int]($r.X + $r.Width/2)
    $y = [int]($r.Y + $r.Height/2)
    $topHandle = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
  }
  # Occlusion guard: a real click lands on whatever window is on top at that
  # point; refuse instead of clicking through to the wrong app.
  $atPoint = [MixWin32]::WindowAtPoint($x, $y)
  if ($requireTopmost -and $topHandle -ne [IntPtr]::Zero -and $atPoint -ne [IntPtr]::Zero -and
      $atPoint -ne $topHandle -and -not [MixWin32]::IsContainedSameProcess($atPoint, $topHandle)) {
    throw "element $ref is covered by another window at its click point; call focus_window first"
  }
  return @($x, $y, $topHandle)
}

# ref resolves to the occlusion-guarded element center; raw x/y are physical
# screen coordinates (a raw click hits whatever the model sees on top there).
function Get-PointArg($req) {
  if ($req.ref) { return Get-ElPoint $req.ref ($req.delivery -eq 'foreground') }
  if ($null -eq $req.x -or $null -eq $req.y) { throw "$($req.action) requires ref or x/y screen coordinates" }
  $x = [int]$req.x
  $y = [int]$req.y
  if ($req.window_id -or $req.window) {
    $selected = Resolve-WindowInfo $req.window $req.window_id
    $atPoint = [MixWin32]::WindowAtPoint($x, $y)
    if ($atPoint -eq $selected.Handle) { return @($x, $y, $selected.Handle) }
    if ($atPoint -ne [IntPtr]::Zero -and [MixWin32]::IsContainedSameProcess($atPoint, $selected.Handle)) {
      return @($x, $y, $atPoint)
    }
    if ($atPoint -ne [IntPtr]::Zero -and [MixWin32]::IsOwnedBy($atPoint, $selected.Handle)) {
      foreach ($allowedId in @($req.allowed_window_ids)) {
        if ([MixWin32]::ParseWindowId([string]$allowedId) -eq $atPoint) {
          return @($x, $y, $atPoint)
        }
      }
    }
    if ($req.delivery -ne 'foreground') { return @($x, $y, $selected.Handle) }
    return @($x, $y, $atPoint)
  }
  return @($x, $y, [MixWin32]::WindowAtPoint($x, $y))
}

function Invoke-ForegroundInput($targetHandle, $action, $body) {
  if (-not [MixWin32]::IsWindowHandle($targetHandle)) {
    return New-ActionResult $action 'foreground' 'suspected_noop' $false "$action target window is invalid" 'target_required' 'foreground' $null
  }
  $previous = [MixWin32]::Foreground()
  $cursor = [MixWin32]::Cursor()
  if (-not [MixWin32]::Focus($targetHandle)) {
    return New-ActionResult $action 'foreground' 'suspected_noop' $false "could not temporarily focus target window" 'foreground_unavailable' 'foreground' ([MixWin32]::WindowId($targetHandle))
  }
  if ($previous -ne $targetHandle) {
    # SetForegroundWindow can report success before the target message loop is
    # ready for keyboard or pointer input. Keep a bounded focus-settle interval
    # between the verified switch and input dispatch.
    [System.Threading.Thread]::Sleep(120)
  }
  if ([MixWin32]::Foreground() -ne $targetHandle) {
    return New-ActionResult $action 'foreground' 'suspected_noop' $false "foreground changed before input dispatch; no input was sent" 'foreground_changed' 'foreground' ([MixWin32]::WindowId($targetHandle))
  }
  try {
    & $body
    # SendInput only enqueues events. Custom renderers such as Chromium consume
    # them asynchronously, so keep the exact target foreground through a
    # bounded input-settle interval before restoring the user's prior window.
    [System.Threading.Thread]::Sleep(240)
    return New-ActionResult $action 'foreground_sendinput' 'unverifiable' $false "$action input dispatched; refresh state before treating it as complete" $null 'foreground' ([MixWin32]::WindowId($targetHandle))
  } finally {
    $stillTargeted = [MixWin32]::Foreground() -eq $targetHandle
    if ($stillTargeted) {
      [void][MixWin32]::SetCursorPos($cursor.x, $cursor.y)
      # Focus restoration can enqueue a final Chromium cursor move after
      # SetCursorPos returns. Reassert once after that queue drains.
      [System.Threading.Thread]::Sleep(30)
      [void][MixWin32]::SetCursorPos($cursor.x, $cursor.y)
    }
    if ($stillTargeted -and $previous -ne [IntPtr]::Zero -and $previous -ne $targetHandle -and [MixWin32]::IsWindowHandle($previous)) {
      [void][MixWin32]::Focus($previous)
    }
  }
}

function Get-ModifierVks($modifiers) {
  if (-not $modifiers) { return @() }
  $vks = @()
  foreach ($part in ([string]$modifiers).ToLower().Split('+')) {
    switch ($part.Trim()) {
      'ctrl'  { $vks += 0x11 }
      'shift' { $vks += 0x10 }
      'alt'   { $vks += 0x12 }
      'win'   { $vks += 0x5B }
      'super' { $vks += 0x5B }
      ''      { }
      default { throw "unknown modifier: $part (use ctrl, shift, alt, win)" }
    }
  }
  return $vks
}

function Test-AllowedPointTarget($candidate, $selectedHandle, $allowedWindowIds) {
  if ($candidate -eq $selectedHandle) { return $true }
  if ([MixWin32]::IsContainedSameProcess($candidate, $selectedHandle)) { return $true }
  if ([MixWin32]::IsOwnedBy($candidate, $selectedHandle)) {
    foreach ($allowedId in @($allowedWindowIds)) {
      if ([MixWin32]::ParseWindowId([string]$allowedId) -eq $candidate) { return $true }
    }
  }
  return $false
}

function Do-ClickFamily($req, $kind) {
  $p = Get-PointArg $req
  $target = $p[2]
  $refRecord = if ($req.ref) { Get-RefRecord $req.ref } else { $null }
  $before = Get-ObservableTargetState $refRecord $req.action
  $selectedHandle = [IntPtr]::Zero
  $allowedWindowIds = @($req.allowed_window_ids)
  if ($req.window_id -or $req.window) {
    $selected = Resolve-WindowInfo $req.window $req.window_id
    $selectedHandle = $selected.Handle
    $allowedOwnedTarget = $target -ne $selected.Handle -and
      [MixWin32]::IsOwnedBy($target, $selected.Handle) -and
      (Test-AllowedPointTarget $target $selected.Handle $allowedWindowIds)
    $pointTargetAllowed = Test-AllowedPointTarget $target $selected.Handle $allowedWindowIds
    if (-not $pointTargetAllowed -and $req.delivery -ne 'foreground') {
      return New-ActionResult $req.action 'none' 'suspected_noop' $false 'frame point is covered by or belongs to a different window' 'target_mismatch' $req.delivery $selected.Id
    }
    if (-not $allowedOwnedTarget) { $target = $selected.Handle }
  }
  if ($req.delivery -ne 'foreground') {
    if (-not $req.ref -and -not $req.window_id -and -not $req.window) {
      return Background-Unavailable $req.action 'background pixel input requires an exact window_id-bound frame' $null 'target_required'
    }
    try {
      $messageTarget = [MixWin32]::BackgroundPointer($target, $p[0], $p[1], $kind, $req.modifiers)
      $message = "$($req.action) delivered to $messageTarget as a native window message"
      return Complete-NativeAction $req.action $messageTarget ([MixWin32]::WindowId($target)) $before $refRecord $message
    } catch {
      return Native-BackgroundFailure $req.action $_.Exception ([MixWin32]::WindowId($target))
    }
  }
  return Invoke-ForegroundInput $target $req.action {
    if ($selectedHandle -ne [IntPtr]::Zero) {
      # Foreground delivery deliberately brings the exact target forward.
      # Revalidate only after that focus settles: checking before focus makes
      # every legitimately covered target impossible to operate.
      $focusedPointTarget = [MixWin32]::WindowAtPoint($p[0], $p[1])
      if (-not (Test-AllowedPointTarget $focusedPointTarget $selectedHandle $allowedWindowIds)) {
        throw 'target_mismatch|frame point remains covered after exact target focus'
      }
    }
    $vks = Get-ModifierVks $req.modifiers
    foreach ($vk in $vks) { [MixWin32]::KeyDown([System.UInt16]$vk) }
    try {
      switch ($kind) {
        'click'  { [MixWin32]::Click($p[0], $p[1]) }
        'double' { [MixWin32]::DoubleClick($p[0], $p[1]) }
        'right'  { [MixWin32]::RightClick($p[0], $p[1]) }
        'middle' { [MixWin32]::MiddleClick($p[0], $p[1]) }
        'triple' { [MixWin32]::TripleClick($p[0], $p[1]) }
        'move'   { [void][MixWin32]::SetCursorPos($p[0], $p[1]) }
      }
    } finally {
      for ($i = $vks.Count - 1; $i -ge 0; $i--) { [MixWin32]::KeyUp([System.UInt16]$vks[$i]) }
    }
  }
}

function Do-MouseMove($req) {
  return Do-ClickFamily $req 'move'
}

function Do-Wait($req) {
  $s = if ($null -ne $req.duration) { [double]$req.duration } else { 1 }
  if ($s -lt 0 -or $s -gt 30) { throw 'wait duration must be 0..30 seconds' }
  Start-Sleep -Milliseconds ([int]($s * 1000))
  return @{ text = ('waited ' + $s + 's') }
}

function Do-Drag($req) {
  if ($null -ne $req.x -or $null -ne $req.y -or $null -ne $req.to_x -or $null -ne $req.to_y) {
    if ($null -eq $req.x -or $null -eq $req.y -or $null -eq $req.to_x -or $null -eq $req.to_y) {
      throw 'coordinate drag requires x, y, to_x, and to_y from one frame_id'
    }
    if (-not $req.window_id -and -not $req.window) {
      return Background-Unavailable 'drag' 'coordinate drag requires an exact window_id-bound frame' $null 'target_required'
    }
    $info = Resolve-WindowInfo $req.window $req.window_id
    $x1 = [int]$req.x; $y1 = [int]$req.y
    $x2 = [int]$req.to_x; $y2 = [int]$req.to_y
    if ($req.delivery -ne 'foreground') {
      try {
        $messageTarget = [MixWin32]::BackgroundDrag(
          $info.Handle, $x1, $y1, $x2, $y2, $req.modifiers)
        return New-ActionResult 'drag' 'win32_message' 'unverifiable' $false "drag delivered to $messageTarget as native window messages; refresh state before treating it as complete" $null 'background' $info.Id
      } catch {
        return Native-BackgroundFailure 'drag' $_.Exception $info.Id
      }
    }
    return Invoke-ForegroundInput $info.Handle 'drag' {
      [MixWin32]::Drag($x1, $y1, $x2, $y2)
    }
  }
  if (-not $req.to) { throw 'drag requires to (destination ref)' }
  $refRecord = Get-RefRecord $req.ref
  $before = Get-ObservableTargetState $refRecord 'drag'
  $foreground = $req.delivery -eq 'foreground'
  $a = Get-ElPoint $req.ref $foreground
  $b = Get-ElPoint $req.to $foreground
  if ($a[2] -ne $b[2]) {
    return New-ActionResult 'drag' 'none' 'suspected_noop' $false 'drag endpoints belong to different windows' 'target_mismatch' $req.delivery $null
  }
  if ($req.delivery -ne 'foreground') {
    try {
      $messageTarget = [MixWin32]::BackgroundDrag($a[2], $a[0], $a[1], $b[0], $b[1], $req.modifiers)
      return Complete-NativeAction 'drag' $messageTarget ([MixWin32]::WindowId($a[2])) $before $refRecord "drag delivered to $messageTarget as native window messages"
    } catch {
      return Native-BackgroundFailure 'drag' $_.Exception ([MixWin32]::WindowId($a[2]))
    }
  }
  return Invoke-ForegroundInput $a[2] 'drag' {
    [MixWin32]::Drag($a[0], $a[1], $b[0], $b[1])
  }
}

function Do-Scroll($req) {
  $direction = ([string]$req.direction).ToLower()
  $amount = if ($null -ne $req.amount) {
    [math]::Max(1, [math]::Min(100, [math]::Abs([int]$req.amount)))
  } elseif ($null -ne $req.dy) {
    [math]::Max(1, [math]::Min(100, [math]::Abs([int]$req.dy)))
  } else { 3 }
  $horizontal = $direction -in @('left','right')
  $amt = if ($direction -in @('up','left')) {
    -$amount
  } elseif ($direction -in @('down','right')) {
    $amount
  } elseif ($null -ne $req.dy -and [int]$req.dy -lt 0) {
    -$amount
  } else {
    $amount
  }
  $wheelClicks = if ($horizontal) { $amt } else { -$amt }
  if ($null -ne $req.x -or $null -ne $req.y) {
    if ($null -eq $req.x -or $null -eq $req.y) { throw 'coordinate scroll requires x and y from frame_id' }
    if (-not $req.window_id -and -not $req.window) {
      return Background-Unavailable 'scroll' 'coordinate scroll requires an exact window_id-bound frame' $null 'target_required'
    }
    $info = Resolve-WindowInfo $req.window $req.window_id
    $x = [int]$req.x; $y = [int]$req.y
    if ($req.delivery -ne 'foreground') {
      try {
        $messageTarget = [MixWin32]::BackgroundWheel(
          $info.Handle, $x, $y, $wheelClicks, $req.modifiers, $horizontal)
        return New-ActionResult 'scroll' 'win32_message' 'unverifiable' $false "scrolled $direction at frame point through native window messages; refresh state before treating it as complete" $null 'background' $info.Id
      } catch {
        return Native-BackgroundFailure 'scroll' $_.Exception $info.Id
      }
    }
    return Invoke-ForegroundInput $info.Handle 'scroll' {
      [void][MixWin32]::SetCursorPos($x, $y)
      if ($horizontal) { [MixWin32]::MouseHWheel($wheelClicks) }
      else { [MixWin32]::MouseWheel($wheelClicks) }
    }
  }
  if ($req.ref) {
    $refRecord = Get-RefRecord $req.ref
    if ($refRecord.Kind -eq 'uia') {
      $el = $refRecord.Element
      $pat = $null
      # Background path: ScrollPattern scrolls without touching mouse or focus.
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pat)) {
        $before = if ($horizontal) { $pat.Current.HorizontalScrollPercent } else { $pat.Current.VerticalScrollPercent }
        $dir = if ($amt -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement }
        $n = [math]::Min([math]::Abs($amt) * 3, 30)
        for ($i = 0; $i -lt $n; $i++) {
          if ($horizontal) {
            if (-not $pat.Current.HorizontallyScrollable) { break }
            $pat.Scroll($dir, [System.Windows.Automation.ScrollAmount]::NoAmount)
          } else {
            if (-not $pat.Current.VerticallyScrollable) { break }
            $pat.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $dir)
          }
        }
        $after = if ($horizontal) { $pat.Current.HorizontalScrollPercent } else { $pat.Current.VerticalScrollPercent }
        $verified = $before -ne $after
        return New-ActionResult 'scroll' 'uia_scroll' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified "scrolled $($req.ref) $direction $n increments through UIA" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
      }
    }
    if ($req.delivery -ne 'foreground') {
      $p = Get-ElPoint $req.ref $false
      $before = Get-ObservableTargetState $refRecord 'scroll'
      try {
        $messageTarget = [MixWin32]::BackgroundWheel($p[2], $p[0], $p[1], $wheelClicks, $req.modifiers, $horizontal)
        return Complete-NativeAction 'scroll' $messageTarget ([MixWin32]::WindowId($p[2])) $before $refRecord "scroll delivered to $messageTarget as a native window message"
      } catch {
        return Native-BackgroundFailure 'scroll' $_.Exception ([MixWin32]::WindowId($p[2]))
      }
    }
    $p = Get-ElPoint $req.ref
    return Invoke-ForegroundInput $p[2] 'scroll' {
      [void][MixWin32]::SetCursorPos($p[0], $p[1])
      if ($horizontal) { [MixWin32]::MouseHWheel($wheelClicks) }
      else { [MixWin32]::MouseWheel($wheelClicks) }
    }
  }
  if ($req.delivery -ne 'foreground') {
    if (-not $req.window_id -and -not $req.window) {
      return Background-Unavailable 'scroll' 'background scroll requires an exact ref or window_id' $null 'target_required'
    }
    $info = Resolve-WindowInfo $req.window $req.window_id
    $x = [int]($info.X + $info.Width/2)
    $y = [int]($info.Y + $info.Height/2)
    try {
      $messageTarget = [MixWin32]::BackgroundWheel($info.Handle, $x, $y, $wheelClicks, $req.modifiers, $horizontal)
      return New-ActionResult 'scroll' 'win32_message' 'unverifiable' $false "scroll delivered to $messageTarget as a native window message; refresh state before treating it as complete" $null 'background' $info.Id
    } catch {
      return Native-BackgroundFailure 'scroll' $_.Exception $info.Id
    }
  }
  $info = Resolve-WindowInfo $req.window $req.window_id
  return Invoke-ForegroundInput $info.Handle 'scroll' {
    $x = [int]($info.X + $info.Width/2)
    $y = [int]($info.Y + $info.Height/2)
    [void][MixWin32]::SetCursorPos($x, $y)
    if ($horizontal) { [MixWin32]::MouseHWheel($wheelClicks) }
    else { [MixWin32]::MouseWheel($wheelClicks) }
  }
}

function Do-Focus($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  $state = Get-CurrentSession
  $previous = [MixWin32]::Foreground()
  if ($state.OriginalFocus -eq [IntPtr]::Zero -and $previous -ne $info.Handle) {
    $state.OriginalFocus = $previous
  }
  if (-not [MixWin32]::Focus($info.Handle)) {
    return New-ActionResult 'focus_window' 'foreground' 'suspected_noop' $false "could not bring window to foreground: $($info.Title)" 'foreground_unavailable' 'foreground' $info.Id
  }
  $state.LastFocus = $info.Handle
  return New-ActionResult 'focus_window' 'foreground' 'confirmed' $true "focused: $($info.Title)" $null 'foreground' $info.Id
}

function Get-WindowBounds($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  if ($info.Width -le 0 -or $info.Height -le 0) {
    throw "window has no capturable bounds: $($info.Id)"
  }
  return @{
    text = ('window bounds: ' + $info.Title)
    title = $info.Title
    window_id = $info.Id
    owner_id = $info.OwnerId
    x = $info.X
    y = $info.Y
    width = $info.Width
    height = $info.Height
    client_x = $info.ClientX
    client_y = $info.ClientY
    client_width = $info.ClientWidth
    client_height = $info.ClientHeight
    related_window_ids = @([MixWin32]::RelatedWindowIds($info.Handle))
  }
}

function Get-WindowCapture($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  try {
    $capture = [MixWin32]::CaptureVisibleWindow($info.Handle)
  } catch {
    throw "native window capture failed for $($info.Id): $($_.Exception.Message)"
  }
  return @{
    text = ('native window capture: ' + $info.Title)
    title = $info.Title
    window_id = $info.Id
    x = $capture.X
    y = $capture.Y
    width = $capture.Width
    height = $capture.Height
    visible_samples = $capture.VisibleSamples
    capture_source = 'screen_region'
    image_base64 = $capture.PngBase64
  }
}

function Get-WindowIntegrity($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  $integrity = [MixWin32]::WindowIntegrity($info.Handle)
  return @{
    text = ('window integrity: ' + $integrity.TargetName)
    window_id = $info.Id
    known = $integrity.Known
    higher = $integrity.Higher
    own_rid = $integrity.OwnRid
    target_rid = $integrity.TargetRid
    own_name = $integrity.OwnName
    target_name = $integrity.TargetName
  }
}

function Get-InputRecoveryState($req) {
  $state = Get-CurrentSession
  $target = [IntPtr]::Zero
  if ($req.ref) {
    $target = Get-RefTopHandle (Get-RefRecord $req.ref)
  } elseif ($req.window_id -or $req.window) {
    $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
  } elseif ([MixWin32]::IsWindowHandle($state.LastFocus)) {
    $target = $state.LastFocus
  }
  if (-not [MixWin32]::IsWindowHandle($target)) {
    throw 'foreground input target is unavailable before dispatch'
  }
  $foreground = [MixWin32]::Foreground()
  $restore = if ([MixWin32]::IsWindowHandle($state.OriginalFocus)) {
    $state.OriginalFocus
  } else {
    $foreground
  }
  $cursor = [MixWin32]::Cursor()
  return @{
    text = 'foreground input recovery state captured'
    target_window_id = [MixWin32]::WindowId($target)
    foreground_window_id = $(if ([MixWin32]::IsWindowHandle($foreground)) { [MixWin32]::WindowId($foreground) } else { '' })
    restore_window_id = $(if ([MixWin32]::IsWindowHandle($restore)) { [MixWin32]::WindowId($restore) } else { '' })
    cursor_x = $cursor.x
    cursor_y = $cursor.y
  }
}

function Restore-InputRecoveryState($req) {
  $restore = [MixWin32]::ParseWindowId([string]$req.restore_window_id)
  if (-not [MixWin32]::IsWindowHandle($restore)) {
    throw 'input recovery restore window is stale or invalid'
  }
  if ([MixWin32]::Foreground() -ne $restore) {
    [void][MixWin32]::Focus($restore)
  }
  [void][MixWin32]::SetCursorPos([int]$req.cursor_x, [int]$req.cursor_y)
  [System.Threading.Thread]::Sleep(30)
  [void][MixWin32]::SetCursorPos([int]$req.cursor_x, [int]$req.cursor_y)
  $foreground = [MixWin32]::Foreground()
  $cursor = [MixWin32]::Cursor()
  return @{
    foreground_window_id = $(if ([MixWin32]::IsWindowHandle($foreground)) { [MixWin32]::WindowId($foreground) } else { '' })
    cursor_x = $cursor.x
    cursor_y = $cursor.y
  }
}

# Hotkeys ride .NET SendKeys: its SendWait waits for the target to process
# each key, which raw SendInput batches cannot. SendKeys' lock-key side effect
# is detected and reverted here.
function Send-KeysGuarded($keys) {
  $keyText = [string]$keys
  $modifierVks = @()
  $vk = $null
  $repeat = 1
  if ($keyText -match '^(?<mods>[\^%+]+)(?<key>[A-Za-z0-9])$') {
    foreach ($modifier in $matches['mods'].ToCharArray()) {
      switch ($modifier) {
        '^' { $modifierVks += 0x11 }
        '%' { $modifierVks += 0x12 }
        '+' { $modifierVks += 0x10 }
      }
    }
    $vk = [int][char](([string]$matches['key']).ToUpperInvariant())
  } elseif ($keyText -match '^(?<mods>[\^%+]*)\{(?<key>[A-Za-z]+[0-9]*)(?:\s+(?<repeat>[0-9]{1,3}))?\}$') {
    foreach ($modifier in $matches['mods'].ToCharArray()) {
      switch ($modifier) {
        '^' { $modifierVks += 0x11 }
        '%' { $modifierVks += 0x12 }
        '+' { $modifierVks += 0x10 }
      }
    }
    try {
      $vk = [MixWin32]::NamedVirtualKey(([string]$matches['key']).ToUpperInvariant())
    } catch {
      $vk = $null
    }
    if ($matches['repeat']) {
      $repeat = [int]$matches['repeat']
      if ($repeat -lt 1 -or $repeat -gt 100) { $vk = $null }
    }
  }
  if ($null -ne $vk) {
    foreach ($modifierVk in $modifierVks) { [MixWin32]::KeyDown([System.UInt16]$modifierVk) }
    try {
      for ($count = 0; $count -lt $repeat; $count++) {
        [MixWin32]::KeyTap([System.UInt16]$vk)
      }
    } finally {
      for ($i = $modifierVks.Count - 1; $i -ge 0; $i--) {
        [MixWin32]::KeyUp([System.UInt16]$modifierVks[$i])
      }
    }
    return
  }
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
    if ([System.Windows.Forms.Control]::IsKeyLocked($l.key) -ne $before[$l.token]) { [MixWin32]::KeyTap([System.UInt16]$l.vk) }
  }
}

function Get-NativeElementHandle($el) {
  $cur = $el
  for ($i = 0; $i -lt 50 -and $null -ne $cur; $i++) {
    $handle = New-Object IntPtr($cur.Current.NativeWindowHandle)
    if ($handle -ne [IntPtr]::Zero) { return $handle }
    $cur = $Walker.GetParent($cur)
  }
  return [IntPtr]::Zero
}

function Get-ExactNativeElementHandle($el) {
  if ($null -eq $el) { return [IntPtr]::Zero }
  return New-Object IntPtr($el.Current.NativeWindowHandle)
}

# Keystrokes land on the FOREGROUND window. Re-assert the last focus_window
# target before sending; when the user moved to another window and it cannot
# be reclaimed, fail instead of typing into their window.
function Assert-TypingTarget {
  $lastFocus = (Get-CurrentSession).LastFocus
  if ($lastFocus -eq [IntPtr]::Zero) {
    throw 'key requires focus_window first'
  }
  if ([MixWin32]::Foreground() -eq $lastFocus) { return }
  throw 'foreground changed (the user is working in another window); keys not sent. Call focus_window again.'
}

# Plain text (no SendKeys grammar characters) rides IME-immune unicode
# SendInput: under an active Korean IME, SendKeys' per-key synthesis gets
# translated into jamo ("parity" becomes hangul noise), while
# KEYEVENTF_UNICODE lands the literal characters verbatim.
function Do-Key($req) {
  if ($req.delivery -ne 'foreground') {
    $target = [IntPtr]::Zero
    $preferred = [IntPtr]::Zero
    $refRecord = $null
    if ($req.ref) {
      $refRecord = Get-RefRecord $req.ref
      $target = Get-RefTopHandle $refRecord
      if ($refRecord.Kind -eq 'msaa') {
        return Background-Unavailable 'key' 'MSAA ref does not expose an exact native keyboard target; use set_value or explicit foreground delivery' $refRecord.WindowId 'background_unsupported'
      }
      $preferred = Get-ExactNativeElementHandle $refRecord.Element
      if ($preferred -eq [IntPtr]::Zero) {
        return Background-Unavailable 'key' 'element has no exact native keyboard target; use explicit foreground delivery' $refRecord.WindowId 'background_unsupported'
      }
    } elseif ($req.window_id -or $req.window) {
      $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
    } else {
      return Background-Unavailable 'key' 'background key requires an exact ref or window_id' $null 'target_required'
    }
    $before = Get-ObservableTargetState $refRecord 'key'
    try {
      $messageTarget = [MixWin32]::BackgroundKeys($target, $preferred, [string]$req.keys)
      return Complete-NativeAction 'key' $messageTarget ([MixWin32]::WindowId($target)) $before $refRecord "keys delivered to $messageTarget as native window messages"
    } catch {
      return Native-BackgroundFailure 'key' $_.Exception ([MixWin32]::WindowId($target))
    }
  }
  $target = [IntPtr]::Zero
  $focusPoint = $null
  if ($req.ref) {
    $focusPoint = Get-ElPoint $req.ref $false
    $target = $focusPoint[2]
  } elseif ($req.window_id -or $req.window) {
    $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
  } else {
    $target = (Get-CurrentSession).LastFocus
  }
  if (-not [MixWin32]::IsWindowHandle($target)) {
    return New-ActionResult 'key' 'none' 'suspected_noop' $false 'key requires window_id/window or a prior focus_window in this session' 'target_required' 'foreground' $null
  }
  return Invoke-ForegroundInput $target 'key' {
    if ($null -ne $focusPoint) {
      [MixWin32]::Click($focusPoint[0], $focusPoint[1])
      Start-Sleep -Milliseconds 80
    }
    if (([string]$req.keys) -notmatch '[{}^%+~()]') { [MixWin32]::SendText([string]$req.keys) }
    else { Send-KeysGuarded $req.keys }
  }
}

function Do-Type($req) {
  $text = if ($null -eq $req.text) { '' } else { [string]$req.text }
  if ($req.delivery -ne 'foreground') {
    $target = [IntPtr]::Zero
    $preferred = [IntPtr]::Zero
    $refRecord = $null
    if ($req.ref) {
      $refRecord = Get-RefRecord $req.ref
      $target = Get-RefTopHandle $refRecord
      if ($refRecord.Kind -eq 'msaa') {
        return Background-Unavailable 'type' 'MSAA ref does not expose an exact native keyboard target; use set_value or explicit foreground delivery' $refRecord.WindowId 'background_unsupported'
      }
      $preferred = Get-ExactNativeElementHandle $refRecord.Element
      if ($preferred -eq [IntPtr]::Zero) {
        return Background-Unavailable 'type' 'element has no exact native keyboard target; use set_value or explicit foreground delivery' $refRecord.WindowId 'background_unsupported'
      }
    } elseif ($req.window_id -or $req.window) {
      $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
    } else {
      return Background-Unavailable 'type' 'background type requires an exact ref or window_id' $null 'target_required'
    }
    $before = Get-ObservableTargetState $refRecord 'type'
    try {
      if ($null -ne $req.x -and $null -ne $req.y) {
        [void][MixWin32]::BackgroundPointer(
          $target, [int]$req.x, [int]$req.y, 'click', $null)
        Start-Sleep -Milliseconds 80
      }
      $messageTarget = [MixWin32]::BackgroundText($target, $preferred, $text)
      return Complete-NativeAction 'type' $messageTarget ([MixWin32]::WindowId($target)) $before $refRecord "typed $($text.Length) literal characters into $messageTarget as native window messages"
    } catch {
      return Native-BackgroundFailure 'type' $_.Exception ([MixWin32]::WindowId($target))
    }
  }
  $target = [IntPtr]::Zero
  $focusPoint = $null
  if ($req.ref) {
    $focusPoint = Get-ElPoint $req.ref $false
    $target = $focusPoint[2]
  } elseif ($req.window_id -or $req.window) {
    $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
    if ($null -ne $req.x -and $null -ne $req.y) {
      $focusPoint = @([int]$req.x, [int]$req.y, $target)
    }
  } else {
    $target = (Get-CurrentSession).LastFocus
  }
  if (-not [MixWin32]::IsWindowHandle($target)) {
    return New-ActionResult 'type' 'none' 'suspected_noop' $false 'type requires window_id/window or a prior focus_window in this session' 'target_required' 'foreground' $null
  }
  return Invoke-ForegroundInput $target 'type' {
    if ($null -ne $focusPoint) {
      [MixWin32]::Click($focusPoint[0], $focusPoint[1])
      Start-Sleep -Milliseconds 80
    }
    [MixWin32]::SendText($text)
  }
}

function Do-OcrImage($req) {
  $encoded = [string]$req.image_base64
  if ([string]::IsNullOrWhiteSpace($encoded)) { throw 'ocr_image requires image_base64' }
  $maximum = if ($null -ne $req.max_ocr_words) { [int]$req.max_ocr_words } else { 300 }
  if ($maximum -lt 1 -or $maximum -gt 1000) { throw 'max_ocr_words must be 1..1000' }
  [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
  $path = [System.IO.Path]::Combine(
    [System.IO.Path]::GetTempPath(),
    'mixdog-ocr-' + [Guid]::NewGuid().ToString('N') + '.img')
  $stream = $null
  $bitmap = $null
  try {
    [System.IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($encoded))
    $file = Await-WinRt (
      [Windows.Storage.StorageFile]::GetFileFromPathAsync($path)
    ) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt (
      $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
    ) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-WinRt (
      [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
    ) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-WinRt (
      $decoder.GetSoftwareBitmapAsync()
    ) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $language = ([string]$req.ocr_language).Trim()
    $engine = if ($language) {
      [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
        ([Windows.Globalization.Language]::new($language)))
    } else {
      [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
      throw "Windows OCR has no recognizer for language '$language'"
    }
    $ocr = Await-WinRt (
      $engine.RecognizeAsync($bitmap)
    ) ([Windows.Media.Ocr.OcrResult])
    $words = New-Object System.Collections.ArrayList
    $lines = New-Object System.Collections.ArrayList
    $totalWords = 0
    $lineIndex = 0
    foreach ($line in $ocr.Lines) {
      $minX = [double]::PositiveInfinity; $minY = [double]::PositiveInfinity
      $maxX = [double]::NegativeInfinity; $maxY = [double]::NegativeInfinity
      foreach ($word in $line.Words) {
        $rect = $word.BoundingRect
        $minX = [math]::Min($minX, [double]$rect.X)
        $minY = [math]::Min($minY, [double]$rect.Y)
        $maxX = [math]::Max($maxX, [double]$rect.X + [double]$rect.Width)
        $maxY = [math]::Max($maxY, [double]$rect.Y + [double]$rect.Height)
        if ($totalWords -lt $maximum) {
          [void]$words.Add([ordered]@{
            text = [string]$word.Text
            line = [int]$lineIndex
            x = [int][math]::Round($rect.X)
            y = [int][math]::Round($rect.Y)
            width = [int][math]::Round($rect.Width)
            height = [int][math]::Round($rect.Height)
            center_x = [int][math]::Round($rect.X + $rect.Width / 2)
            center_y = [int][math]::Round($rect.Y + $rect.Height / 2)
          })
        }
        $totalWords++
      }
      [void]$lines.Add([ordered]@{
        line = [int]$lineIndex
        text = [string]$line.Text
        x = $(if ([double]::IsInfinity($minX)) { 0 } else { [int][math]::Round($minX) })
        y = $(if ([double]::IsInfinity($minY)) { 0 } else { [int][math]::Round($minY) })
        width = $(if ([double]::IsInfinity($minX)) { 0 } else { [int][math]::Round($maxX - $minX) })
        height = $(if ([double]::IsInfinity($minY)) { 0 } else { [int][math]::Round($maxY - $minY) })
      })
      $lineIndex++
    }
    return @{
      text = ('OCR: ' + $lineIndex + ' lines, ' + $totalWords + ' words')
      language = [string]$engine.RecognizerLanguage.LanguageTag
      lines = @($lines)
      words = @($words)
      total_words = [int]$totalWords
      truncated_words = [math]::Max(0, [int]$totalWords - [int]$words.Count)
    }
  } finally {
    if ($null -ne $bitmap -and $bitmap -is [System.IDisposable]) { $bitmap.Dispose() }
    if ($null -ne $stream -and $stream -is [System.IDisposable]) { $stream.Dispose() }
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}

function Do-OcrStatus($req) {
  [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
  $requested = ([string]$req.ocr_language).Trim()
  $installed = @(
    [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages |
      ForEach-Object { [string]$_.LanguageTag }
  )
  $engine = if ($requested) {
    [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
      ([Windows.Globalization.Language]::new($requested)))
  } else {
    [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  }
  return @{
    text = 'Windows OCR readiness'
    available = $null -ne $engine
    requested_language = $(if ($requested) { $requested } else { $null })
    active_language = $(if ($null -ne $engine) { [string]$engine.RecognizerLanguage.LanguageTag } else { $null })
    installed_languages = @($installed)
  }
}

# Clipboard passthrough is an explicit global operation. Semantic set_value is
# preferred because it neither replaces the user's clipboard nor steals focus.
function Do-ClipboardRead {
  $text = [System.Windows.Forms.Clipboard]::GetText()
  if (-not $text) { return @{ text = 'Clipboard is empty or not text.' } }
  if ($text.Length -gt 30000) { $text = $text.Substring(0, 30000) + '... (truncated)' }
  return @{ text = $text }
}

function Do-ClipboardWrite($text) {
  if ($null -eq $text -or ([string]$text).Length -eq 0) {
    [System.Windows.Forms.Clipboard]::Clear()
    $verified = -not [System.Windows.Forms.Clipboard]::ContainsText()
    return New-ActionResult 'clipboard_write' 'clipboard' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified 'cleared clipboard' $null 'background' $null
  }
  [System.Windows.Forms.Clipboard]::SetText([string]$text)
  $verified = [System.Windows.Forms.Clipboard]::GetText() -eq [string]$text
  return New-ActionResult 'clipboard_write' 'clipboard' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified ('clipboard set: ' + ([string]$text).Length + ' chars') $null 'background' $null
}

# Move/resize a top-level window; omitted fields keep the current bounds. Also
# the agent's remedy when the occlusion guard reports a covered element.
function Do-MoveWindow($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  $x = if ($null -ne $req.x) { [int]$req.x } else { $info.X }
  $y = if ($null -ne $req.y) { [int]$req.y } else { $info.Y }
  $w = if ($null -ne $req.width) { [int]$req.width } else { $info.Width }
  $hh = if ($null -ne $req.height) { [int]$req.height } else { $info.Height }
  [void][MixWin32]::ShowWindow($info.Handle, 9)
  if (-not [MixWin32]::MoveWindow($info.Handle, $x, $y, $w, $hh, $true)) {
    throw "could not move window: $($info.Id)"
  }
  $after = [MixWin32]::Info($info.Handle)
  $verified = $after.X -eq $x -and $after.Y -eq $y -and $after.Width -eq $w -and $after.Height -eq $hh
  $message = 'moved {0} to {1},{2} size {3}x{4}' -f $info.Id, $x, $y, $w, $hh
  return New-ActionResult 'move_window' 'win32' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified $message $null 'background' $info.Id
}

function Do-WindowState($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  $state = ([string]$req.state).ToLower()
  $command = switch ($state) {
    'minimize' { 6 }
    'maximize' { 3 }
    'restore' { 9 }
    default { throw 'window_state requires state=minimize, maximize, or restore' }
  }
  [void][MixWin32]::ShowWindow($info.Handle, $command)
  Start-Sleep -Milliseconds 80
  $verified = switch ($state) {
    'minimize' { [MixWin32]::IsMinimized($info.Handle) }
    'maximize' { [MixWin32]::IsMaximized($info.Handle) }
    'restore' { -not [MixWin32]::IsMinimized($info.Handle) }
  }
  return New-ActionResult 'window_state' 'win32' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified "$state window $($info.Id)" $null 'background' $info.Id
}

function Do-CloseWindow($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  if (-not [MixWin32]::CloseWindow($info.Handle)) {
    return New-ActionResult 'close_window' 'win32' 'suspected_noop' $false "could not request close for $($info.Id)" 'window_close_rejected' 'background' $info.Id
  }
  Start-Sleep -Milliseconds 120
  $verified = -not [MixWin32]::IsWindowHandle($info.Handle)
  $message = if ($verified) {
    "closed window $($info.Id)"
  } else {
    "close requested for $($info.Id); the app may be showing a save or confirmation dialog"
  }
  return New-ActionResult 'close_window' 'win32' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified $message $null 'background' $info.Id
}

function Do-Launch($app) {
  $target = [string]$app
  if ([string]::IsNullOrWhiteSpace($target)) { throw 'launch requires app' }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $target
  $startInfo.UseShellExecute = $true
  try {
    $process = [System.Diagnostics.Process]::Start($startInfo)
  } catch [System.ComponentModel.Win32Exception] {
    $nativeCode = [int]$_.Exception.NativeErrorCode
    $category = switch ($nativeCode) {
      { $_ -in 2, 3 } { 'target_not_found'; break }
      5 { 'access_denied'; break }
      { $_ -in 31, 1155 } { 'no_file_association'; break }
      1223 { 'launch_cancelled'; break }
      default { 'shell_launch_failed' }
    }
    throw "launch failed [$category/$nativeCode] for '$target': $($_.Exception.Message)"
  } catch {
    throw "launch failed [shell_launch_failed] for '$target': $($_.Exception.Message)"
  }
  $result = New-ActionResult 'launch' 'windows_shell' 'unverifiable' $false ('launched ' + $target) $null 'background' $null
  if ($null -ne $process) {
    $result.pid = [int]$process.Id
    try { $result.app_hint = [string]$process.ProcessName } catch {}
  }
  return $result
}

function Release-SessionState {
  $state = Get-CurrentSession
  $current = [MixWin32]::Foreground()
  if (($state.OriginalFocus -ne [IntPtr]::Zero) -and
      ($current -eq $state.LastFocus) -and
      [MixWin32]::IsWindowHandle($state.OriginalFocus)) {
    [void][MixWin32]::Focus($state.OriginalFocus)
  }
  $state.Map.Clear()
  $state.Generation = [int]$state.Generation + 1
  $state.LastFocus = [IntPtr]::Zero
  $state.OriginalFocus = [IntPtr]::Zero
  return @{ text = 'computer session released' }
}

function Invalidate-RefsForRequest($req) {
  $readActions = @('list_windows','window_snapshot','related_windows','snapshot','find','clipboard_read','wait','window_bounds','window_capture','window_integrity','input_recovery_state','ocr_image','ocr_status','release_session')
  if ($null -ne $req -and -not ($readActions -contains [string]$req.action)) {
    $state = Get-CurrentSession
    $state.Map.Clear()
    $state.Generation = [int]$state.Generation + 1
  }
}

function Handle($req) {
  $script:CurrentSession = Get-SessionState $req.session_id
  $readActions = @('list_windows','window_snapshot','related_windows','snapshot','find','clipboard_read','wait','window_bounds','window_capture','window_integrity','input_recovery_state','ocr_image','ocr_status')
  if ($req.read_only -and -not ($readActions -contains [string]$req.action)) {
    throw "read_only run: '$($req.action)' is a mutation"
  }
  switch ($req.action) {
    'list_windows' { return Do-ListWindows }
    'window_snapshot' { return Do-WindowSnapshot }
    'related_windows' { return Do-RelatedWindows $req }
    'snapshot'     { return Snapshot-Window $req }
    'find'         { return Snapshot-Window $req }
    'invoke'       { return Invoke-BackgroundSemantic $req.ref { Do-Invoke $req.ref } }
    'set_value'    { return Invoke-BackgroundSemantic $req.ref { Do-SetValue $req.ref $req.text } }
    'toggle'       { return Invoke-BackgroundSemantic $req.ref { Do-Toggle $req.ref } }
    'click'        { return Do-ClickFamily $req 'click' }
    'double_click' { return Do-ClickFamily $req 'double' }
    'right_click'  { return Do-ClickFamily $req 'right' }
    'middle_click' { return Do-ClickFamily $req 'middle' }
    'triple_click' { return Do-ClickFamily $req 'triple' }
    'mouse_move'   { return Do-MouseMove $req }
    'wait'         { return Do-Wait $req }
    'drag'         { return Do-Drag $req }
    'scroll'       { return Do-Scroll $req }
    'focus_window' { return Do-Focus $req }
    'window_bounds'{ return Get-WindowBounds $req }
    'window_capture'{ return Get-WindowCapture $req }
    'window_integrity'{ return Get-WindowIntegrity $req }
    'input_recovery_state' { return Get-InputRecoveryState $req }
    'restore_input_state' { return Restore-InputRecoveryState $req }
    'move_window'  { return Do-MoveWindow $req }
    'key'          { return Do-Key $req }
    'type'         { return Do-Type $req }
    'window_state' { return Do-WindowState $req }
    'close_window' { return Do-CloseWindow $req }
    'ocr_image'    { return Do-OcrImage $req }
    'ocr_status'   { return Do-OcrStatus $req }
    'clipboard_read'  { return Do-ClipboardRead }
    'clipboard_write' { return Do-ClipboardWrite $req.text }
    'launch'       { return Do-Launch $req.app }
    'release_session' { return Release-SessionState }
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
    try { $res = Handle $req } finally { Invalidate-RefsForRequest $req }
    $out = @{ id = $id; ok = $true; result = $res } | ConvertTo-Json -Compress -Depth 6
  } catch {
    $out = @{ id = $id; ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
  }
  [Console]::Out.WriteLine('${RESPONSE_MARKER}' + $out)
}
`.replace('${RESPONSE_MARKER}', RESPONSE_MARKER);
}

export interface ChromeRemoteDebuggingTarget {
  windowId: string;
  pid: number;
}

export interface ChromeRemoteDebuggingSetup extends ChromeRemoteDebuggingTarget {
  openedSetupPage: boolean;
  enabledByMixdog: boolean;
}

export interface PowerShellComputerHost {
  setBridgeEnabled(enabled: boolean): void;
  inspectChromeRemoteDebuggingTarget(): Promise<ChromeRemoteDebuggingTarget>;
  prepareChromeRemoteDebugging(
    target: ChromeRemoteDebuggingTarget,
  ): Promise<ChromeRemoteDebuggingSetup>;
  acceptChromeRemoteDebuggingConsent(
    setup: ChromeRemoteDebuggingSetup,
    signal?: AbortSignal,
  ): Promise<boolean>;
  finalizeChromeRemoteDebuggingSetup(setup: ChromeRemoteDebuggingSetup): Promise<void>;
  releaseChromeRemoteDebugging(setup: ChromeRemoteDebuggingSetup): Promise<void>;
  dispose(): Promise<void>;
}

export function createPowerShellComputerHost(
  options: { bridgeEnabled?: boolean } = {},
): PowerShellComputerHost {
  let token = randomBytes(24).toString('base64url');
  let heartbeat: NodeJS.Timeout | null = null;
  let server: Server | null = null;
  let discoveryPath: string | null = null;
  let bridgeWanted = options.bridgeEnabled !== false;
  let bridgeGeneration = 0;
  let disposed = false;

  // Agent-scoped resident PowerShell workers + their shared pending-request table.
  const powerShellBySession = new Map<string, ChildProcessWithoutNullStreams>();
  let hostScriptPath: string | null = null;
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (r: PowerShellResponse) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
    child: ChildProcessWithoutNullStreams;
  }>();
  const commandChainsBySession = new Map<string, Promise<unknown>>();
  let foregroundChain: Promise<unknown> = Promise.resolve();
  let nextFrameId = 1;
  const framesBySession = new Map<string, Map<string, CaptureFrame>>();
  const elementTargetsBySession = new Map<string, Map<number, ElementAliasTarget>>();
  const observedWindowBySession = new Map<string, ObservedWindowScope>();
  const targetClaims = new Map<string, { sessionId: string; lastUsedAt: number }>();
  const targetsBySession = new Map<string, Set<string>>();
  const activeExecutionsBySession = new Map<string, {
    sessionId: string;
    aborted: boolean;
    recovery?: InputRecoveryState;
  }>();
  const executionContext = new AsyncLocalStorage<{
    sessionId: string;
    aborted: boolean;
    recovery?: InputRecoveryState;
  }>();
  const sessionAbortEpochs = new Map<string, number>();
  const sessionRecoveryBySession = new Map<string, InputRecoveryState>();
  const TARGET_CLAIM_STALE_MS = 10 * 60_000;

  function sessionIdFor(command: ComputerCommand): string {
    return String(command.session_id || 'default');
  }

  function expireStaleTargetClaims(now = Date.now()): void {
    for (const [windowId, claim] of targetClaims) {
      if (now - claim.lastUsedAt < TARGET_CLAIM_STALE_MS) continue;
      targetClaims.delete(windowId);
      const sessionTargets = targetsBySession.get(claim.sessionId);
      sessionTargets?.delete(windowId);
      if (sessionTargets?.size === 0) targetsBySession.delete(claim.sessionId);
    }
  }

  function touchTargetClaims(sessionId: string): void {
    const now = Date.now();
    expireStaleTargetClaims(now);
    for (const windowId of targetsBySession.get(sessionId) || []) {
      const claim = targetClaims.get(windowId);
      if (claim?.sessionId === sessionId) claim.lastUsedAt = now;
    }
  }

  function claimComputerTargets(command: ComputerCommand, windowIds: Array<string | undefined>): void {
    const sessionId = sessionIdFor(command);
    const now = Date.now();
    expireStaleTargetClaims(now);
    const exactWindowIds = [...new Set(windowIds.map((value) => String(value || '')).filter(Boolean))];
    for (const windowId of exactWindowIds) {
      const claim = targetClaims.get(windowId);
      if (claim && claim.sessionId !== sessionId) {
        throw new Error(`computer_target_in_use: ${windowId} is reserved by another agent`);
      }
    }
    let sessionTargets = targetsBySession.get(sessionId);
    if (!sessionTargets) {
      sessionTargets = new Set();
      targetsBySession.set(sessionId, sessionTargets);
    }
    for (const windowId of exactWindowIds) {
      targetClaims.set(windowId, { sessionId, lastUsedAt: now });
      sessionTargets.add(windowId);
    }
  }

  function releaseTargetClaims(sessionId: string): void {
    for (const windowId of targetsBySession.get(sessionId) || []) {
      if (targetClaims.get(windowId)?.sessionId === sessionId) targetClaims.delete(windowId);
    }
    targetsBySession.delete(sessionId);
  }

  function runForegroundExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = foregroundChain.then(operation);
    foregroundChain = run.catch(() => undefined);
    return run;
  }

  async function releaseComputerSession(command: ComputerCommand): Promise<ComputerCommandResult> {
    const sessionId = sessionIdFor(command);
    const child = powerShellBySession.get(sessionId);
    try {
      if (child && !child.killed) {
        await callPowerShell({
          action: 'release_session',
          session_id: sessionId,
          read_only: false,
        });
      }
    } finally {
      if (child && !child.killed) {
        retirePowerShell(child, new Error('computer session released'));
      }
      framesBySession.delete(sessionId);
      elementTargetsBySession.delete(sessionId);
      observedWindowBySession.delete(sessionId);
      sessionRecoveryBySession.delete(sessionId);
      releaseTargetClaims(sessionId);
    }
    return { text: 'computer session released' };
  }

  async function cleanupAbortedInput(recovery?: InputRecoveryState): Promise<void> {
    if (!recovery?.targetWindowId) return;
    await new Promise<void>((resolve) => {
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        ABORT_CLEANUP_PROGRAM,
      ], {
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          MIXDOG_ABORT_TARGET: recovery.targetWindowId,
          MIXDOG_ABORT_RESTORE: recovery.restoreWindowId,
          MIXDOG_ABORT_CURSOR_X: String(recovery.cursorX),
          MIXDOG_ABORT_CURSOR_Y: String(recovery.cursorY),
        },
      });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish();
      }, ABORT_CLEANUP_TIMEOUT_MS);
      child.once('error', finish);
      child.once('exit', finish);
    });
  }

  async function abortComputerSession(command: ComputerCommand): Promise<ComputerCommandResult> {
    const sessionId = sessionIdFor(command);
    sessionAbortEpochs.set(sessionId, (sessionAbortEpochs.get(sessionId) || 0) + 1);
    const activeExecution = activeExecutionsBySession.get(sessionId);
    const recovery = activeExecution?.recovery || sessionRecoveryBySession.get(sessionId);
    if (activeExecution) activeExecution.aborted = true;
    const child = powerShellBySession.get(sessionId);
    if (child && !child.killed) {
      retirePowerShell(child, new Error('computer_session_aborted: command stopped by session cancellation'));
    }
    activeExecutionsBySession.delete(sessionId);
    framesBySession.delete(sessionId);
    elementTargetsBySession.delete(sessionId);
    observedWindowBySession.delete(sessionId);
    sessionRecoveryBySession.delete(sessionId);
    releaseTargetClaims(sessionId);
    await runForegroundExclusive(() => cleanupAbortedInput(recovery));
    return { text: 'computer session aborted; input state and session resources were released' };
  }

  function rememberFrame(frame: CaptureFrame): void {
    let frames = framesBySession.get(frame.sessionId);
    if (!frames) {
      frames = new Map();
      framesBySession.set(frame.sessionId, frames);
    }
    frames.set(frame.id, frame);
    while (frames.size > 8) frames.delete(frames.keys().next().value as string);
  }

  function rememberObservedWindowScope(
    command: ComputerCommand,
    primaryWindowId: string,
    relatedWindowIds: string[] = [],
  ): void {
    if (!primaryWindowId) return;
    observedWindowBySession.set(sessionIdFor(command), {
      primaryWindowId,
      relatedWindowIds: [...new Set([
        primaryWindowId,
        ...relatedWindowIds.map(String).filter(Boolean),
      ])],
    });
  }

  function normalizeElementRecords(value: unknown): ComputerElementRecord[] {
    if (!Array.isArray(value)) return [];
    const elements: ComputerElementRecord[] = [];
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const mark = Number(row.mark);
      const ref = String(row.ref || '');
      if (!Number.isInteger(mark) || mark < 1 || !ref) continue;
      const ancestors: ChromeUiaAncestor[] = Array.isArray(row.ancestors)
        ? row.ancestors.flatMap((rawAncestor) => {
            if (!rawAncestor || typeof rawAncestor !== 'object') return [];
            const ancestor = rawAncestor as Record<string, unknown>;
            return [{
              runtime_id: String(ancestor.runtime_id || ''),
              role: String(ancestor.role || ''),
              name: String(ancestor.name || ''),
            }];
          })
        : [];
      elements.push({
        mark,
        ref,
        source: row.source === 'msaa' ? 'msaa' : 'uia',
        role: String(row.role || ''),
        name: String(row.name || ''),
        value: String(row.value || ''),
        state: String(row.state || ''),
        enabled: row.enabled === true,
        x: Number(row.x) || 0,
        y: Number(row.y) || 0,
        width: Number(row.width) || 0,
        height: Number(row.height) || 0,
        center_x: Number(row.center_x) || 0,
        center_y: Number(row.center_y) || 0,
        actions: Array.isArray(row.actions)
          ? row.actions.map((action) => String(action)).filter(Boolean)
          : [],
        runtime_id: String(row.runtime_id || '') || undefined,
        parent_runtime_id: String(row.parent_runtime_id || '') || undefined,
        class_name: String(row.class_name || '') || undefined,
        has_keyboard_focus: row.has_keyboard_focus === true,
        in_document: row.in_document === true,
        ancestors,
      });
    }
    return elements;
  }

  function rememberElementTargets(command: ComputerCommand, elements: ComputerElementRecord[]): void {
    const targets = new Map<number, ElementAliasTarget>();
    for (const element of elements) {
      if (element.source === 'ocr') {
        if (!element.frame_id) continue;
        targets.set(element.mark, {
          kind: 'point',
          frameId: element.frame_id,
          windowId: element.window_id,
          x: element.center_x,
          y: element.center_y,
        });
      } else {
        targets.set(element.mark, { kind: 'ref', ref: element.ref });
      }
    }
    elementTargetsBySession.set(sessionIdFor(command), targets);
  }

  function elementTarget(
    command: ComputerCommand,
    mark: number | undefined,
    label: string,
  ): ElementAliasTarget | undefined {
    if (mark === undefined) return undefined;
    if (!Number.isInteger(mark) || mark < 1) throw new Error(`${label} must be a positive integer from the latest capture`);
    const target = elementTargetsBySession.get(sessionIdFor(command))?.get(mark);
    if (!target) throw new Error(`stale_element: ${label}=${mark} is not in the latest capture for this session`);
    return target;
  }

  function resolveElementAliases(command: ComputerCommand): ComputerCommand {
    const markedTarget = ELEMENT_ALIAS_ACTIONS.has(command.action)
      ? elementTarget(command, command.element, 'element')
      : undefined;
    const markedDestination = command.action === 'drag'
      ? elementTarget(command, command.to_element, 'to_element')
      : undefined;
    if (markedTarget?.kind === 'point' && !PIXEL_ALIAS_ACTIONS.has(command.action)) {
      throw new Error(`OCR element marks do not support '${command.action}'; use a semantic ref or click the OCR mark first`);
    }
    if (markedTarget?.kind === 'ref' && markedTarget.ref && command.ref
      && markedTarget.ref !== command.ref) {
      throw new Error('element and ref identify different controls');
    }
    if (markedDestination?.kind === 'ref' && markedDestination.ref && command.to
      && markedDestination.ref !== command.to) {
      throw new Error('to_element and to identify different controls');
    }
    if (markedTarget && markedDestination && markedTarget.kind !== markedDestination.kind) {
      throw new Error('drag source and destination must both be semantic elements or both be OCR/frame points');
    }
    return {
      ...command,
      ...(markedTarget?.kind === 'ref' && markedTarget.ref ? { ref: markedTarget.ref } : {}),
      ...(markedTarget?.kind === 'point' ? {
        ref: undefined,
        frame_id: markedTarget.frameId,
        window_id: markedTarget.windowId || command.window_id,
        x: markedTarget.x,
        y: markedTarget.y,
      } : {}),
      ...(markedDestination?.kind === 'ref' && markedDestination.ref
        ? { to: markedDestination.ref }
        : {}),
      ...(markedDestination?.kind === 'point' ? {
        to: undefined,
        frame_id: markedDestination.frameId,
        window_id: markedDestination.windowId || command.window_id,
        to_x: markedDestination.x,
        to_y: markedDestination.y,
      } : {}),
    };
  }

  async function requireValidFrame(command: ComputerCommand): Promise<CaptureFrame> {
    const frameId = String(command.frame_id || '');
    if (!frameId) throw new Error('frame_id is required for pixel coordinates');
    const frame = framesBySession.get(sessionIdFor(command))?.get(frameId);
    if (!frame) throw new Error(`stale_frame: unknown frame_id ${frameId} in this session`);
    if (frame.kind === 'window') {
      const bounds = await callPowerShell({
        action: 'window_bounds',
        window_id: frame.windowId,
        session_id: frame.sessionId,
        read_only: true,
      });
      if (!bounds.ok) throw new Error(`stale_frame: target window is gone (${frame.windowId})`);
      const same = Number(bounds.result?.x) === (frame.targetWindowX ?? frame.windowX)
        && Number(bounds.result?.y) === (frame.targetWindowY ?? frame.windowY)
        && Number(bounds.result?.width) === (frame.targetWindowWidth ?? frame.windowWidth)
        && Number(bounds.result?.height) === (frame.targetWindowHeight ?? frame.windowHeight);
      if (!same) throw new Error(`stale_frame: target window moved or resized (${frame.id})`);
    } else {
      const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === frame.displayId);
      const origin = display?.nativeOrigin ?? (display ? { x: display.bounds.x, y: display.bounds.y } : null);
      const same = !!display && !!origin
        && origin.x === frame.displayX
        && origin.y === frame.displayY
        && Math.round(display.size.width * display.scaleFactor) === frame.displayWidth
        && Math.round(display.size.height * display.scaleFactor) === frame.displayHeight;
      if (!same) throw new Error(`stale_frame: display layout changed (${frame.id})`);
    }
    return frame;
  }

  function framePoint(frame: CaptureFrame, x: number, y: number): { x: number; y: number } {
    if (!Number.isInteger(x) || !Number.isInteger(y)
      || x < 0 || y < 0 || x >= frame.captureWidth || y >= frame.captureHeight) {
      throw new Error(`frame coordinates must be inside 0..${frame.captureWidth - 1},0..${frame.captureHeight - 1}`);
    }
    return {
      x: frame.originX + Math.round((x * frame.physicalWidth) / frame.captureWidth),
      y: frame.originY + Math.round((y * frame.physicalHeight) / frame.captureHeight),
    };
  }

  function ensurePowerShell(sessionId: string): ChildProcessWithoutNullStreams {
    const existing = powerShellBySession.get(sessionId);
    if (existing && !existing.killed) return existing;
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
    let childBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      childBuffer += chunk;
      let index = childBuffer.indexOf('\n');
      while (index >= 0) {
        const line = childBuffer.slice(0, index).replace(/\r$/, '');
        childBuffer = childBuffer.slice(index + 1);
        const marker = line.indexOf(RESPONSE_MARKER);
        if (marker >= 0) handlePsLine(line.slice(marker + RESPONSE_MARKER.length));
        index = childBuffer.indexOf('\n');
      }
    });
    child.stderr.on('data', () => { /* diagnostics ignored; errors ride responses */ });
    child.once('exit', () => {
      if (powerShellBySession.get(sessionId) === child) powerShellBySession.delete(sessionId);
      for (const [id, entry] of pending) {
        if (entry.child !== child) continue;
        clearTimeout(entry.timer);
        entry.reject(new Error('computer host exited'));
        pending.delete(id);
      }
    });
    powerShellBySession.set(sessionId, child);
    return child;
  }

  function retirePowerShell(child: ChildProcessWithoutNullStreams, error: Error): void {
    for (const [sessionId, activeChild] of powerShellBySession) {
      if (activeChild === child) powerShellBySession.delete(sessionId);
    }
    for (const [id, entry] of pending) {
      if (entry.child !== child) continue;
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
    try { child.kill(); } catch { /* already gone */ }
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
    const sessionId = String(request.session_id || 'default');
    const child = ensurePowerShell(sessionId);
    const id = nextId++;
    const line = `${JSON.stringify({ ...request, id })}\n`;
    return new Promise<PowerShellResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        retirePowerShell(child, new Error('computer command timed out; the input host was restarted'));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, child });
      try {
        child.stdin.write(line);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async function callPowerShellElevated(
    request: Record<string, unknown>,
  ): Promise<PowerShellResponse> {
    ensurePowerShell(String(request.session_id || 'default'));
    if (!hostScriptPath) throw new Error('privileged_worker_unavailable: computer host script is missing');
    const directory = mixdogDataDirectory();
    mkdirSync(directory, { recursive: true });
    const elevatedBootstrap = String.raw`
$ErrorActionPreference = 'Stop'
$token = [string]$env:MIXDOG_ELEVATED_TOKEN
$hostScript = [string]$env:MIXDOG_ELEVATED_HOST_SCRIPT
$hostSha256 = [string]$env:MIXDOG_ELEVATED_HOST_SHA256
$requestPath = [string]$env:MIXDOG_ELEVATED_REQUEST
$requestSha256 = [string]$env:MIXDOG_ELEVATED_REQUEST_SHA256
$responsePath = [string]$env:MIXDOG_ELEVATED_RESPONSE
$marker = [string]$env:MIXDOG_ELEVATED_MARKER
$protectedHost = $null

function Get-Sha256Hex([byte[]]$bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Set-AdminOnlyDirectory([string]$path) {
  [void][System.IO.Directory]::CreateDirectory($path)
  $administrators = New-Object System.Security.Principal.SecurityIdentifier(
    [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  $system = New-Object System.Security.Principal.SecurityIdentifier(
    [System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($administrators)
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $full = [System.Security.AccessControl.FileSystemRights]::FullControl
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $administrators, $full, $inheritance, $propagation, $allow)))
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $system, $full, $inheritance, $propagation, $allow)))
  [System.IO.Directory]::SetAccessControl($path, $acl)
}

try {
  if ([string]::IsNullOrWhiteSpace($token) -or
      [string]::IsNullOrWhiteSpace($hostScript) -or
      [string]::IsNullOrWhiteSpace($hostSha256) -or
      [string]::IsNullOrWhiteSpace($requestPath) -or
      [string]::IsNullOrWhiteSpace($requestSha256) -or
      [string]::IsNullOrWhiteSpace($responsePath) -or
      [string]::IsNullOrWhiteSpace($marker)) {
    throw 'privileged worker environment is incomplete'
  }
  if ($token -notmatch '^[A-Za-z0-9_-]{32,}$') {
    throw 'privileged worker token is malformed'
  }
  $hostBytes = [System.IO.File]::ReadAllBytes($hostScript)
  if ((Get-Sha256Hex $hostBytes) -ne $hostSha256.ToLowerInvariant()) {
    throw 'privileged worker host authentication failed'
  }
  $requestBytes = [System.IO.File]::ReadAllBytes($requestPath)
  if ((Get-Sha256Hex $requestBytes) -ne $requestSha256.ToLowerInvariant()) {
    throw 'privileged worker request authentication failed'
  }
  $requestText = [System.Text.Encoding]::UTF8.GetString($requestBytes)
  $request = $requestText | ConvertFrom-Json
  $allowed = @('click','double_click','right_click','middle_click','triple_click','mouse_move','drag','scroll','key','type')
  if (-not ($allowed -contains [string]$request.action)) {
    throw "privileged worker action is not allowed: $($request.action)"
  }
  if ([string]$request.delivery -ne 'foreground') {
    throw 'privileged worker requires delivery=foreground'
  }
  if ([string]$request.window_id -notmatch '^hwnd:0x[0-9a-fA-F]+$') {
    throw 'privileged worker requires exact window_id'
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$request.ref) -or
      -not [string]::IsNullOrWhiteSpace([string]$request.to)) {
    throw 'privileged worker requires frame-bound coordinates or direct keys/text'
  }
  $normalizedKeys = ([string]$request.keys) -replace '\\s+', ''
  if ($normalizedKeys -match '^(?i:%\\{F4\\}|\\^%\\{(?:DEL|DELETE)\\}|#(?:L|\\{L\\}))$') {
    throw 'privileged worker blocked a destructive or session-ending key combination'
  }
  $workerDirectory = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Mixdog\ComputerWorker'
  Set-AdminOnlyDirectory $workerDirectory
  $protectedHost = Join-Path $workerDirectory ('host-' + $token + '.ps1')
  [System.IO.File]::WriteAllBytes($protectedHost, $hostBytes)
  $powershell = Join-Path $PSHOME 'powershell.exe'
  $lines = @(
    $requestText |
      & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $protectedHost 2>&1 |
      ForEach-Object { [string]$_ }
  )
  $response = @($lines | Where-Object { $_.StartsWith($marker) } | Select-Object -Last 1)
  if ($response.Count -ne 1) {
    throw 'privileged worker host returned no structured response'
  }
  [System.IO.File]::WriteAllText(
    $responsePath,
    $token + [Environment]::NewLine + [string]$response[0],
    [System.Text.Encoding]::UTF8)
  exit 0
} catch {
  try {
    [System.IO.File]::WriteAllText(
      $responsePath,
      $token + [Environment]::NewLine + 'ERROR:' + $_.Exception.Message,
      [System.Text.Encoding]::UTF8)
  } catch {}
  exit 1
} finally {
  if (-not [string]::IsNullOrWhiteSpace($protectedHost)) {
    Remove-Item -LiteralPath $protectedHost -Force -ErrorAction SilentlyContinue
  }
}
`;
    const nonce = randomBytes(24).toString('base64url');
    const requestPath = join(directory, `computer-elevated-${nonce}.request.json`);
    const responsePath = join(directory, `computer-elevated-${nonce}.response.txt`);
    const id = nextId++;
    const requestBytes = Buffer.from(`${JSON.stringify({ ...request, id })}\n`, 'utf8');
    const hostBytes = readFileSync(hostScriptPath);
    const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    writeFileSync(requestPath, requestBytes, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const bootstrapEncoded = Buffer.from(elevatedBootstrap, 'utf16le').toString('base64');
    const launcher = [
      "$ErrorActionPreference = 'Stop'",
      "$powershell = Join-Path $PSHOME 'powershell.exe'",
      `$bootstrap = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${bootstrapEncoded}'))`,
      "function ConvertTo-MixdogLiteral([string]$value) { return \"'\" + $value.Replace(\"'\", \"''\") + \"'\" }",
      "$variableNames = @('MIXDOG_ELEVATED_TOKEN','MIXDOG_ELEVATED_HOST_SCRIPT','MIXDOG_ELEVATED_HOST_SHA256','MIXDOG_ELEVATED_REQUEST','MIXDOG_ELEVATED_REQUEST_SHA256','MIXDOG_ELEVATED_RESPONSE','MIXDOG_ELEVATED_MARKER')",
      "$prelude = @($variableNames | ForEach-Object { '$env:' + $_ + ' = ' + (ConvertTo-MixdogLiteral ([string][Environment]::GetEnvironmentVariable($_))) }) -join [Environment]::NewLine",
      '$elevatedScript = $prelude + [Environment]::NewLine + $bootstrap',
      '$elevatedEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($elevatedScript))',
      "$arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$elevatedEncoded)",
      'try {',
      "  $process = Start-Process -FilePath $powershell -Verb RunAs -ArgumentList $arguments -Wait -PassThru",
      '  exit $process.ExitCode',
      '} catch {',
      "  [Console]::Error.WriteLine(('launcher_error:' + $_.Exception.Message))",
      '  exit 1223',
      '}',
    ].join('; ');
    try {
      const launcherResult = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          launcher,
        ], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            MIXDOG_ELEVATED_TOKEN: nonce,
            MIXDOG_ELEVATED_HOST_SCRIPT: hostScriptPath!,
            MIXDOG_ELEVATED_HOST_SHA256: sha256(hostBytes),
            MIXDOG_ELEVATED_REQUEST: requestPath,
            MIXDOG_ELEVATED_REQUEST_SHA256: sha256(requestBytes),
            MIXDOG_ELEVATED_RESPONSE: responsePath,
            MIXDOG_ELEVATED_MARKER: RESPONSE_MARKER,
          },
        });
        let stdout = '';
        let stderr = '';
        const appendBounded = (current: string, chunk: Buffer): string =>
          `${current}${chunk.toString('utf8')}`.slice(-4096);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout = appendBounded(stdout, chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = appendBounded(stderr, chunk);
        });
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* launcher already exited */ }
          reject(new Error('privileged_worker_timeout: UAC consent or elevated input timed out'));
        }, 120_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve({
            code: Number(code ?? 1),
            stdout,
            stderr,
          });
        });
      });
      let envelope = '';
      try {
        envelope = readFileSync(responsePath, 'utf8');
      } catch {
        const launcherDetail = `${launcherResult.stderr}\n${launcherResult.stdout}`
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 1000);
        if (launcherResult.code === 1223) {
          throw new Error('privileged_worker_cancelled: UAC consent was declined');
        }
        if (launcherResult.code === 0) {
          throw new Error('privileged_worker_unavailable: elevated worker returned no response');
        }
        throw new Error(
          `privileged_worker_launcher_failed: elevated worker exited with code ${launcherResult.code}`
          + (launcherDetail ? ` (${launcherDetail})` : ''),
        );
      }
      const newline = envelope.indexOf('\n');
      const responseToken = (newline >= 0 ? envelope.slice(0, newline) : envelope)
        .replace(/^\uFEFF/, '')
        .replace(/\r$/, '');
      const responseLine = newline >= 0 ? envelope.slice(newline + 1).trim() : '';
      if (responseToken !== nonce) {
        throw new Error('privileged_worker_rejected: response authentication failed');
      }
      if (responseLine.startsWith('ERROR:')) {
        throw new Error(`privileged_worker_failed: ${responseLine.slice(6)}`);
      }
      const marker = responseLine.indexOf(RESPONSE_MARKER);
      if (marker < 0) throw new Error('privileged_worker_failed: structured response is missing');
      const parsed = JSON.parse(responseLine.slice(marker + RESPONSE_MARKER.length)) as PowerShellResponse;
      if (parsed.id !== id) throw new Error('privileged_worker_rejected: response id mismatch');
      return parsed;
    } finally {
      try { unlinkSync(requestPath); } catch { /* already removed */ }
      try { unlinkSync(responsePath); } catch { /* no response on UAC cancellation */ }
    }
  }

  async function readWindowIntegrity(
    windowId: string | undefined,
    sessionId: string,
  ): Promise<{ known: boolean; higher: boolean; ownName: string; targetName: string }> {
    if (!windowId) return { known: false, higher: false, ownName: 'Unknown', targetName: 'Unknown' };
    const response = await callPowerShell({
      action: 'window_integrity',
      window_id: windowId,
      session_id: sessionId,
      read_only: true,
    });
    if (!response.ok) throw new Error(response.error || 'window integrity lookup failed');
    return {
      known: response.result?.known === true,
      higher: response.result?.higher === true,
      ownName: String(response.result?.own_name || 'Unknown'),
      targetName: String(response.result?.target_name || 'Unknown'),
    };
  }

  async function readComputerWindows(
    command: ComputerCommand,
    includeApp = false,
  ): Promise<ComputerWindowRecord[] | null> {
    try {
      const response = await callPowerShell({
        action: includeApp ? 'list_windows' : 'window_snapshot',
        session_id: sessionIdFor(command),
        read_only: true,
      });
      if (!response.ok) return null;
      return normalizeComputerWindowRecords(response.result?.windows);
    } catch {
      return null;
    }
  }

  async function resolveAppWindowId(command: ComputerCommand): Promise<string> {
    const requested = String(command.app || '').trim().toLowerCase();
    if (!requested) throw new Error('app target is empty');
    const windows = await readComputerWindows(command, true);
    if (!windows) throw new Error('could not enumerate windows for app targeting');
    const exact = windows.filter((window) => window.app.toLowerCase() === requested);
    const matches = exact.length > 0
      ? exact
      : windows.filter((window) =>
          window.app.toLowerCase().includes(requested)
          || window.title.toLowerCase().includes(requested)
          || window.className.toLowerCase().includes(requested));
    if (matches.length === 0) {
      throw new Error(`no visible window matched app "${command.app}"`);
    }
    if (matches.length === 1) return matches[0].id;
    const focused = matches.filter((window) => window.focused);
    if (focused.length === 1) return focused[0].id;
    const candidates = matches
      .slice(0, 12)
      .map((window) => `${window.id} "${window.title || '<untitled>'}"`)
      .join(' | ');
    throw new Error(`app target is ambiguous: ${command.app} (${candidates}); use window_id`);
  }

  async function resolveForegroundWindowId(command: ComputerCommand): Promise<string> {
    const windows = await readComputerWindows(command);
    const focused = windows?.filter((window) => window.focused) || [];
    if (focused.length !== 1) {
      throw new Error('no single foreground window is available; use app or window_id');
    }
    return focused[0].id;
  }

  async function listComputerApps(command: ComputerCommand): Promise<ComputerCommandResult> {
    const windows = await readComputerWindows(command);
    if (!windows) throw new Error('could not enumerate apps');
    const groups = new Map<string, {
      name: string;
      pid: number;
      focused: boolean;
      minimized: boolean;
      windows: Array<{
        window_id: string;
        title: string;
        class_name: string;
        minimized: boolean;
        maximized: boolean;
      }>;
    }>();
    for (const window of windows) {
      const key = `${window.app.toLowerCase()}\0${window.pid}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          name: window.app,
          pid: window.pid,
          focused: false,
          minimized: true,
          windows: [],
        };
        groups.set(key, group);
      }
      group.focused ||= window.focused;
      group.minimized &&= window.minimized;
      group.windows.push({
        window_id: window.id,
        title: window.title,
        class_name: window.className,
        minimized: window.minimized,
        maximized: window.maximized,
      });
    }
    const apps = [...groups.values()]
      .map((group) => ({
        ...group,
        window_count: group.windows.length,
      }))
      .sort((left, right) =>
        Number(right.focused) - Number(left.focused)
        || left.name.localeCompare(right.name));
    return { text: JSON.stringify({ apps }) };
  }

  async function diagnoseComputer(command: ComputerCommand): Promise<ComputerCommandResult> {
    const startedAt = performance.now();
    const windows = await readComputerWindows(command, true);
    const requestedWindowId = String(command.window_id || '');
    const target = requestedWindowId
      ? windows?.find((window) => window.id === requestedWindowId)
      : windows?.find((window) => window.focused);
    let accessibility: Record<string, unknown> = {
      available: null,
      reason: target ? 'not_probed' : 'no exact or foreground target was available',
    };
    if (target) {
      try {
        const probe = await callPowerShell({
          action: 'snapshot',
          window_id: target.id,
          max_elements: 1,
          visible_only: true,
          session_id: sessionIdFor(command),
          read_only: true,
        });
        accessibility = probe.ok
          ? {
              available: true,
              target_window_id: target.id,
              returned_elements: Array.isArray(probe.result?.elements)
                ? probe.result.elements.length
                : 0,
            }
          : {
              available: false,
              target_window_id: target.id,
              reason: probe.error || 'accessibility probe failed',
            };
      } catch (error) {
        accessibility = {
          available: false,
          target_window_id: target.id,
          reason: (error as Error).message || String(error),
        };
      }
    }
    let ocr: Record<string, unknown>;
    try {
      const probe = await callPowerShell({
        action: 'ocr_status',
        ocr_language: command.ocr_language ?? null,
        session_id: sessionIdFor(command),
        read_only: true,
      });
      ocr = probe.ok
        ? {
            available: probe.result?.available === true,
            requested_language: probe.result?.requested_language ?? null,
            active_language: probe.result?.active_language ?? null,
            installed_languages: Array.isArray(probe.result?.installed_languages)
              ? probe.result.installed_languages
              : [],
          }
        : { available: false, reason: probe.error || 'OCR readiness probe failed' };
    } catch (error) {
      ocr = { available: false, reason: (error as Error).message || String(error) };
    }
    const displays = screen.getAllDisplays().map((display, index) => ({
      index,
      id: String(display.id),
      primary: display.id === screen.getPrimaryDisplay().id,
      scale_factor: display.scaleFactor,
      width: display.size.width,
      height: display.size.height,
    }));
    const issues: string[] = [];
    if (!windows) issues.push('window enumeration failed');
    if (requestedWindowId && !target) issues.push(`requested window is unavailable: ${requestedWindowId}`);
    if (accessibility.available === false) issues.push(String(accessibility.reason || 'accessibility unavailable'));
    if (command.ocr_language && ocr.available !== true) {
      issues.push(`Windows OCR language is unavailable: ${command.ocr_language}`);
    }
    return {
      text: JSON.stringify({
        ok: windows !== null,
        action: 'diagnose',
        platform: 'win32',
        ready: windows !== null,
        backend: 'win32_uia_powershell_electron',
        windows: {
          available: windows !== null,
          count: windows?.length || 0,
          focused_window_id: windows?.find((window) => window.focused)?.id || null,
        },
        capabilities: {
          exact_window_capture: true,
          semantic_accessibility: accessibility,
          ocr,
          delivery_modes: ['background', 'foreground'],
          focus_cursor_restore: true,
          app_owned_electron_text: true,
          browser_content_route: 'browser_use',
          capture_probe: 'run capture against an exact target; diagnostics does not expose screen pixels',
        },
        permissions: {
          screen_capture: 'not_required_on_windows',
          accessibility: 'not_required_on_windows',
          input: 'target_integrity_dependent',
        },
        displays,
        issues,
        timings_ms: { total_ms: elapsedMs(startedAt) },
      }),
    };
  }

  function transitionConfirmsSemanticAction(
    action: string,
    result: Record<string, unknown>,
    transition: ComputerWindowTransition | null,
    targetWindowId: string | undefined,
    launchTarget = '',
  ): boolean {
    if (result.verified === true || !transition) return false;
    if (action === 'launch') return launchTransitionConfirmsTarget(transition, launchTarget);
    if (action !== 'invoke' || !targetWindowId) return false;
    const semanticPath = ['uia_invoke', 'uia_selection', 'msaa_default_action']
      .includes(String(result.path || ''));
    if (!semanticPath) return false;
    return transition.closed_windows.some((window) => window.id === targetWindowId)
      || transition.changed_windows.some((window) => window.id === targetWindowId)
      || transition.next_target !== undefined;
  }

  function recommendedRecovery(
    action: string,
    effect: string,
    code: string | undefined,
    delivery: string,
    transition: ComputerWindowTransition | null,
    targetWindow?: ComputerWindowRecord,
  ): 'switch_target' | 'recapture' | 'pixel' | 'foreground' | 'browser_use' | undefined {
    if (transition?.next_target) return 'switch_target';
    if (code === 'target_mismatch' || code === 'stale_target' || code === 'stale_frame') {
      return 'recapture';
    }
    const browserTarget = targetWindow
      && /^(chrome|msedge|edge|brave)$/i.test(targetWindow.app)
      && /Chrome_WidgetWin/i.test(targetWindow.className);
    if (browserTarget
      && (effect === 'suspected_noop' || code?.startsWith('background_'))
      && ['click', 'double_click', 'right_click', 'type', 'key', 'scroll'].includes(action)) {
      return 'browser_use';
    }
    if (delivery === 'background'
      && (effect === 'suspected_noop' || code?.startsWith('background_'))
      && ['invoke', 'set_value', 'toggle'].includes(action)) {
      return 'pixel';
    }
    if (delivery === 'background'
      && (effect === 'suspected_noop' || code?.startsWith('background_'))) {
      return 'foreground';
    }
    return undefined;
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

  function pixelUnavailable(
    reason: PixelUnavailable['reason'],
    message: string,
    details: Partial<PixelUnavailable> = {},
  ): PixelUnavailable {
    return {
      code: 'pixel_unavailable',
      reason,
      message,
      ...details,
    };
  }

  function screenshotQualityIssue(
    image: NativeImage,
    expectedWidth: number,
    expectedHeight: number,
  ): PixelUnavailable | undefined {
    const size = image.getSize();
    if (!size.width || !size.height || image.isEmpty()) {
      return pixelUnavailable('empty_frame', 'capture returned an empty pixel frame');
    }
    const expectedAspectRatio = expectedWidth / Math.max(1, expectedHeight);
    const actualAspectRatio = size.width / Math.max(1, size.height);
    const aspectError = Math.abs(actualAspectRatio - expectedAspectRatio)
      / Math.max(0.0001, expectedAspectRatio);
    if (!Number.isFinite(aspectError) || aspectError > 0.05) {
      return pixelUnavailable(
        'coordinate_mismatch',
        'capture dimensions do not match the target coordinate space',
        {
          expected_aspect_ratio: Number(expectedAspectRatio.toFixed(4)),
          actual_aspect_ratio: Number(actualAspectRatio.toFixed(4)),
        },
      );
    }
    const bitmap = image.toBitmap();
    const totalPixels = Math.floor(bitmap.length / 4);
    if (!totalPixels) {
      return pixelUnavailable('empty_frame', 'capture returned no readable pixel data');
    }
    const stride = Math.max(1, Math.floor(totalPixels / SCREENSHOT_SAMPLE_LIMIT));
    let sampled = 0;
    let nearBlack = 0;
    let nearWhite = 0;
    for (let pixel = 0; pixel < totalPixels; pixel += stride) {
      const offset = pixel * 4;
      const blue = bitmap[offset] ?? 0;
      const green = bitmap[offset + 1] ?? 0;
      const red = bitmap[offset + 2] ?? 0;
      sampled += 1;
      if (red <= SCREENSHOT_NEAR_BLACK_CHANNEL
        && green <= SCREENSHOT_NEAR_BLACK_CHANNEL
        && blue <= SCREENSHOT_NEAR_BLACK_CHANNEL) {
        nearBlack += 1;
      }
      if (red >= SCREENSHOT_NEAR_WHITE_CHANNEL
        && green >= SCREENSHOT_NEAR_WHITE_CHANNEL
        && blue >= SCREENSHOT_NEAR_WHITE_CHANNEL) {
        nearWhite += 1;
      }
    }
    const nearBlackRatio = nearBlack / Math.max(1, sampled);
    if (nearBlackRatio >= SCREENSHOT_UNUSABLE_RATIO) {
      return pixelUnavailable(
        'blank_black_frame',
        'capture is effectively all black; no coordinate frame was issued',
        {
          sampled_pixels: sampled,
          near_black_ratio: Number(nearBlackRatio.toFixed(4)),
        },
      );
    }
    const nearWhiteRatio = nearWhite / Math.max(1, sampled);
    if (nearWhiteRatio >= SCREENSHOT_UNUSABLE_RATIO) {
      return pixelUnavailable(
        'blank_white_frame',
        'capture is effectively all white; no coordinate frame was issued',
        {
          sampled_pixels: sampled,
          near_white_ratio: Number(nearWhiteRatio.toFixed(4)),
        },
      );
    }
    return undefined;
  }

  /** On-demand JPEG through Electron, scoped to the primary screen or one window. */
  async function captureVisibleNativeWindow(
    windowId: string,
    sessionId: string,
  ): Promise<{
    image: NativeImage;
    sourceId: string;
    sourceName: string;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null> {
    try {
      const response = await callPowerShell({
        action: 'window_capture',
        window_id: windowId,
        session_id: sessionId,
        read_only: true,
      });
      const encoded = String(response.result?.image_base64 || '');
      if (!response.ok || !encoded) return null;
      const image = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64'));
      const size = image.getSize();
      if (image.isEmpty() || size.width <= 0 || size.height <= 0) return null;
      return {
        image,
        sourceId: `native-window:${windowId}`,
        sourceName: String(response.result?.title || windowId),
        x: Math.round(Number(response.result?.x) || 0),
        y: Math.round(Number(response.result?.y) || 0),
        width: Math.round(Number(response.result?.width) || size.width),
        height: Math.round(Number(response.result?.height) || size.height),
      };
    } catch {
      return null;
    }
  }

  async function captureScreenshot(
    command: ComputerCommand,
    allowOwnerFallback = true,
  ): Promise<ScreenshotCapture> {
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
    let targetWindowId = '';
    // Physical-pixel origin and width of the captured surface, so the caption
    // can state the exact image-to-screen coordinate mapping for click x/y.
    let originX = 0;
    let originY = 0;
    let physicalWidth = 0;
    let physicalHeight = 0;
    let targetWindowX = 0;
    let targetWindowY = 0;
    let targetWindowWidth = 0;
    let targetWindowHeight = 0;
    let captureOwnerWindowId = '';
    let clientOriginX = 0;
    let clientOriginY = 0;
    let clientWidth = 0;
    let clientHeight = 0;
    let relatedWindowIds: string[] | null = null;
    if (command.window_id?.trim() || command.window?.trim()) {
      const bounds = await callPowerShell({
        action: 'window_bounds',
        window: command.window?.trim() || null,
        window_id: command.window_id?.trim() || null,
        session_id: sessionIdFor(command),
        read_only: true,
      });
      if (!bounds.ok) throw new Error(bounds.error || 'window bounds lookup failed');
      sourceType = 'window';
      sourceTitle = String(bounds.result?.title || command.window?.trim() || command.window_id);
      targetWindowId = String(bounds.result?.window_id || command.window_id || '');
      captureOwnerWindowId = String(bounds.result?.owner_id || '');
      sourceWidth = Number(bounds.result?.width);
      sourceHeight = Number(bounds.result?.height);
      if (!Number.isFinite(sourceWidth) || sourceWidth <= 0 || !Number.isFinite(sourceHeight) || sourceHeight <= 0) {
        throw new Error(`window has no capturable bounds: ${sourceTitle}`);
      }
      originX = Math.round(Number(bounds.result?.x) || 0);
      originY = Math.round(Number(bounds.result?.y) || 0);
      physicalWidth = sourceWidth;
      physicalHeight = sourceHeight;
      targetWindowX = originX;
      targetWindowY = originY;
      targetWindowWidth = sourceWidth;
      targetWindowHeight = sourceHeight;
      clientOriginX = Math.round(Number(bounds.result?.client_x) || originX);
      clientOriginY = Math.round(Number(bounds.result?.client_y) || originY);
      clientWidth = Math.round(Number(bounds.result?.client_width) || 0);
      clientHeight = Math.round(Number(bounds.result?.client_height) || 0);
      const ids = Array.isArray(bounds.result?.related_window_ids)
        ? bounds.result.related_window_ids.map(String).filter(Boolean)
        : [];
      relatedWindowIds = ids.includes(targetWindowId) ? ids : [targetWindowId, ...ids];
    } else {
      const displays = screen.getAllDisplays();
      const primaryIndex = Math.max(0, displays.findIndex((display) => display.id === screen.getPrimaryDisplay().id));
      const index = screenshotInteger(command.screen, primaryIndex, 0, Math.max(0, displays.length - 1), 'screen');
      const display = displays[index] ?? screen.getPrimaryDisplay();
      targetDisplayId = String(display.id);
      sourceWidth = display.size.width;
      sourceHeight = display.size.height;
      const nativeOrigin = display.nativeOrigin ?? { x: display.bounds.x, y: display.bounds.y };
      originX = nativeOrigin.x;
      originY = nativeOrigin.y;
      physicalWidth = Math.round(display.size.width * display.scaleFactor);
      physicalHeight = Math.round(display.size.height * display.scaleFactor);
      if (displays.length > 1) sourceTitle = `screen ${index + 1}/${displays.length}`;
    }
    const scale = Math.min(1, maxWidth / Math.max(1, sourceWidth));
    let capturedImage: NativeImage | undefined;
    let capturedSourceId = '';
    let capturedSourceName = sourceTitle;
    const ownedWindow = targetWindowId ? electronWindowForNativeId(targetWindowId) : null;
    if (ownedWindow && !ownedWindow.isDestroyed() && !ownedWindow.webContents.isDestroyed()) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const ownedImage = await Promise.race([
          ownedWindow.capturePage(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('app-owned capture timed out')),
              OWNED_CAPTURE_TIMEOUT_MS,
            );
          }),
        ]);
        const ownedSize = ownedImage.getSize();
        const candidateImage = ownedSize.width > maxWidth
          ? ownedImage.resize({ width: maxWidth, quality: 'best' })
          : ownedImage;
        const candidateSize = candidateImage.getSize();
        const candidateRatio = candidateSize.width / Math.max(1, candidateSize.height);
        const expectedGeometry = [
          { width: physicalWidth, height: physicalHeight },
          { width: clientWidth, height: clientHeight },
        ].filter((candidate) => candidate.width > 0 && candidate.height > 0)
          .reduce((best, candidate) => {
            const error = Math.abs(candidate.width / candidate.height - candidateRatio);
            const bestError = Math.abs(best.width / best.height - candidateRatio);
            return error < bestError ? candidate : best;
          });
        if (!screenshotQualityIssue(
          candidateImage,
          expectedGeometry.width,
          expectedGeometry.height,
        )) {
          capturedImage = candidateImage;
          capturedSourceId = `browser-window:${targetWindowId}`;
        }
      } catch {
        capturedImage = undefined;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    if (!capturedImage) {
      const sources = await withTimeout(
        desktopCapturer.getSources({
          types: [sourceType],
          thumbnailSize: {
            width: Math.max(1, Math.round(sourceWidth * scale)),
            height: Math.max(1, Math.round(sourceHeight * scale)),
          },
        }),
        DESKTOP_CAPTURE_TIMEOUT_MS,
        'desktop capture',
      ).catch(() => null);
      const windowHandleDecimal = targetWindowId
        ? Number.parseInt(targetWindowId.replace(/^hwnd:/i, '').replace(/^0x/i, ''), 16)
        : Number.NaN;
      const source = sources
        ? (sourceType === 'screen'
            ? sources.find((candidate) => candidate.display_id === targetDisplayId)
            : sources.find((candidate) => Number.isFinite(windowHandleDecimal)
                && candidate.id.split(':').some((part) => Number(part) === windowHandleDecimal)))
        : undefined;
      if (source) {
        capturedImage = source.thumbnail;
        capturedSourceId = source.id;
        capturedSourceName = source.name;
      }
      if (!capturedImage && targetWindowId) {
        const nativeCapture = await captureVisibleNativeWindow(
          targetWindowId,
          sessionIdFor(command),
        );
        if (nativeCapture) {
          const nativeSize = nativeCapture.image.getSize();
          capturedImage = nativeSize.width > maxWidth
            ? nativeCapture.image.resize({ width: maxWidth, quality: 'best' })
            : nativeCapture.image;
          capturedSourceId = nativeCapture.sourceId;
          capturedSourceName = nativeCapture.sourceName;
          originX = nativeCapture.x;
          originY = nativeCapture.y;
          physicalWidth = nativeCapture.width;
          physicalHeight = nativeCapture.height;
        }
      }
      if (!capturedImage) {
        if (allowOwnerFallback
          && targetWindowId
          && captureOwnerWindowId
          && captureOwnerWindowId !== targetWindowId) {
          const ownerCapture = await captureScreenshot({
            ...command,
            window: undefined,
            window_id: captureOwnerWindowId,
          }, false);
          if (ownerCapture.image && ownerCapture.frame && ownerCapture.frameId) {
            return {
              ...ownerCapture,
              description: `${ownerCapture.description}; requested child window ${targetWindowId}`
                + ` was captured through owner ${captureOwnerWindowId}`,
            };
          }
        }
        const unavailable = pixelUnavailable(
          'capture_source_unavailable',
          sources
            ? `exact ${sourceType} capture source is unavailable`
            : `exact ${sourceType} capture did not settle before the safety deadline`,
        );
        return {
          description: unavailable.message,
          ...(targetWindowId ? { windowId: targetWindowId } : {}),
          pixelUnavailable: unavailable,
        };
      }
    }
    const thumbnailSize = capturedImage.getSize();
    if (targetWindowId && clientWidth > 0 && clientHeight > 0) {
      const actualAspectRatio = thumbnailSize.width / Math.max(1, thumbnailSize.height);
      const candidates = [
        { x: originX, y: originY, width: physicalWidth, height: physicalHeight },
        { x: clientOriginX, y: clientOriginY, width: clientWidth, height: clientHeight },
      ];
      const geometry = candidates.reduce((best, candidate) => {
        const candidateRatio = candidate.width / Math.max(1, candidate.height);
        const candidateError = Math.abs(candidateRatio - actualAspectRatio)
          / Math.max(0.0001, candidateRatio);
        const bestRatio = best.width / Math.max(1, best.height);
        const bestError = Math.abs(bestRatio - actualAspectRatio)
          / Math.max(0.0001, bestRatio);
        return candidateError < bestError ? candidate : best;
      });
      originX = geometry.x;
      originY = geometry.y;
      physicalWidth = geometry.width;
      physicalHeight = geometry.height;
    }
    const qualityIssue = screenshotQualityIssue(
      capturedImage,
      physicalWidth || sourceWidth,
      physicalHeight || sourceHeight,
    );
    if (qualityIssue) {
      return {
        description: qualityIssue.message,
        ...(targetWindowId ? { windowId: targetWindowId } : {}),
        pixelUnavailable: qualityIssue,
      };
    }
    const jpeg = capturedImage.toJPEG(quality);
    if (!jpeg || jpeg.length === 0) {
      const unavailable = pixelUnavailable('empty_frame', 'capture could not encode a pixel frame');
      return {
        description: unavailable.message,
        ...(targetWindowId ? { windowId: targetWindowId } : {}),
        pixelUnavailable: unavailable,
      };
    }
    const frameId = `frame-${nextFrameId++}`;
    const frame: CaptureFrame = {
      id: frameId,
      sessionId: sessionIdFor(command),
      kind: sourceType,
      sourceId: capturedSourceId,
      ...(targetWindowId ? { windowId: targetWindowId } : {}),
      ...(targetDisplayId ? { displayId: targetDisplayId } : {}),
      originX,
      originY,
      physicalWidth,
      physicalHeight,
      ...(targetWindowId ? {
        relatedWindowIds: relatedWindowIds || [targetWindowId],
      } : {}),
      captureWidth: thumbnailSize.width,
      captureHeight: thumbnailSize.height,
      ...(targetWindowId ? {
        windowX: originX,
        windowY: originY,
        windowWidth: physicalWidth,
        windowHeight: physicalHeight,
        targetWindowX,
        targetWindowY,
        targetWindowWidth,
        targetWindowHeight,
      } : {
        displayX: originX,
        displayY: originY,
        displayWidth: physicalWidth,
        displayHeight: physicalHeight,
      }),
    };
    rememberFrame(frame);
    return {
      image: { mimeType: 'image/jpeg', data: jpeg.toString('base64') },
      description: `Screenshot of ${sourceType === 'window' ? `window "${capturedSourceName}"` : sourceTitle}`
        + ` (${thumbnailSize.width}x${thumbnailSize.height}, ${jpeg.length} bytes, JPEG quality ${quality});`
        + ` frame_id=${frameId}`
        + `${targetWindowId ? ` window_id=${targetWindowId}` : ''}; coordinates are pixels in this frame`,
      frameId,
      ...(targetWindowId ? { windowId: targetWindowId } : {}),
      frame,
    };
  }

  /** Full-resolution crop of one captured frame. */
  async function captureZoom(command: ComputerCommand): Promise<{
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
    const region = command.region;
    if (!Array.isArray(region) || region.length !== 4 || region.some((value) => !Number.isInteger(value))) {
      throw new Error('zoom requires region [x0,y0,x1,y1] in frame_id image coordinates');
    }
    const frame = await requireValidFrame(command);
    const [fx0, fy0, fx1, fy1] = region;
    if (fx0 < 0 || fy0 < 0 || fx1 > frame.captureWidth || fy1 > frame.captureHeight
      || fx1 - fx0 < 8 || fy1 - fy0 < 8) {
      throw new Error(`zoom region must be at least 8x8 and inside frame ${frame.captureWidth}x${frame.captureHeight}`);
    }
    const x0 = frame.originX + Math.round((fx0 * frame.physicalWidth) / frame.captureWidth);
    const y0 = frame.originY + Math.round((fy0 * frame.physicalHeight) / frame.captureHeight);
    const x1 = frame.originX + Math.round((fx1 * frame.physicalWidth) / frame.captureWidth);
    const y1 = frame.originY + Math.round((fy1 * frame.physicalHeight) / frame.captureHeight);
    const baseOriginX = frame.kind === 'window' ? frame.windowX : frame.displayX;
    const baseOriginY = frame.kind === 'window' ? frame.windowY : frame.displayY;
    const baseWidth = frame.kind === 'window' ? frame.windowWidth : frame.displayWidth;
    const baseHeight = frame.kind === 'window' ? frame.windowHeight : frame.displayHeight;
    if (baseOriginX === undefined || baseOriginY === undefined
        || baseWidth === undefined || baseHeight === undefined) {
      throw new Error(`stale_frame: capture source geometry is missing (${frame.id})`);
    }
    let source: { id: string; thumbnail: NativeImage; display_id?: string } | undefined;
    if (frame.kind === 'window'
      && frame.sourceId.startsWith('native-window:')
      && frame.windowId) {
      const nativeCapture = await captureVisibleNativeWindow(frame.windowId, frame.sessionId);
      if (nativeCapture) {
        source = {
          id: nativeCapture.sourceId,
          thumbnail: nativeCapture.image,
        };
      }
    }
    if (!source) {
      const sources = await withTimeout(
        desktopCapturer.getSources({
          types: [frame.kind],
          thumbnailSize: { width: baseWidth, height: baseHeight },
        }),
        DESKTOP_CAPTURE_TIMEOUT_MS,
        'desktop zoom capture',
      );
      const windowHandleDecimal = frame.windowId
        ? Number.parseInt(frame.windowId.replace(/^hwnd:/i, '').replace(/^0x/i, ''), 16)
        : Number.NaN;
      source = sources.find((candidate) => candidate.id === frame.sourceId)
        || (frame.kind === 'window'
          ? sources.find((candidate) => Number.isFinite(windowHandleDecimal)
              && candidate.id.split(':').some((part) => Number(part) === windowHandleDecimal))
          : sources.find((candidate) => candidate.display_id === frame.displayId));
    }
    if (!source) throw new Error(`stale_frame: exact capture source is unavailable (${frame.id})`);
    const shot = source.thumbnail;
    const shotSize = shot.getSize();
    if (!shotSize.width || !shotSize.height) return null;
    const kx = shotSize.width / baseWidth;
    const ky = shotSize.height / baseHeight;
    const cropX = Math.min(shotSize.width - 1, Math.max(0, Math.round((x0 - baseOriginX) * kx)));
    const cropY = Math.min(shotSize.height - 1, Math.max(0, Math.round((y0 - baseOriginY) * ky)));
    const cropW = Math.min(shotSize.width - cropX, Math.max(1, Math.round((x1 - x0) * kx)));
    const cropH = Math.min(shotSize.height - cropY, Math.max(1, Math.round((y1 - y0) * ky)));
    let image = shot.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
    if (image.getSize().width > maxWidth) image = image.resize({ width: maxWidth });
    const finalSize = image.getSize();
    const jpeg = image.toJPEG(quality);
    if (!jpeg || jpeg.length === 0) return null;
    const zoomFrameId = `frame-${nextFrameId++}`;
    rememberFrame({
      id: zoomFrameId,
      sessionId: sessionIdFor(command),
      kind: frame.kind,
      sourceId: source.id,
      ...(frame.windowId ? { windowId: frame.windowId } : {}),
      ...(frame.displayId ? { displayId: frame.displayId } : {}),
      originX: x0,
      originY: y0,
      physicalWidth: x1 - x0,
      physicalHeight: y1 - y0,
      captureWidth: finalSize.width,
      captureHeight: finalSize.height,
      ...(frame.windowId ? {
        windowX: frame.windowX,
        windowY: frame.windowY,
        windowWidth: frame.windowWidth,
        windowHeight: frame.windowHeight,
        targetWindowX: frame.targetWindowX,
        targetWindowY: frame.targetWindowY,
        targetWindowWidth: frame.targetWindowWidth,
        targetWindowHeight: frame.targetWindowHeight,
      } : {
        displayX: frame.displayX,
        displayY: frame.displayY,
        displayWidth: frame.displayWidth,
        displayHeight: frame.displayHeight,
      }),
    });
    return {
      image: { mimeType: 'image/jpeg', data: jpeg.toString('base64') },
      description: `Zoom of ${frame.id} region (${fx0},${fy0})-(${fx1},${fy1})`
        + ` (${finalSize.width}x${finalSize.height}, ${jpeg.length} bytes, JPEG quality ${quality});`
        + ` frame_id=${zoomFrameId}; coordinates are pixels in this frame`,
    };
  }

  function captureMode(command: ComputerCommand): 'state' | 'som' | 'vision' | 'ax' {
    const mode = command.mode || 'state';
    if (mode !== 'state' && mode !== 'som' && mode !== 'vision' && mode !== 'ax') {
      throw new Error('capture mode must be state, som, vision, or ax');
    }
    return mode;
  }

  function frameElements(
    elements: ComputerElementRecord[],
    frame?: CaptureFrame,
    compact = false,
  ): Array<Record<string, unknown>> {
    const rendered = (
      element: ComputerElementRecord,
      bounds: [number, number, number, number],
      center: [number, number],
      screenBounds?: [number, number, number, number],
    ): Record<string, unknown> => compact ? {
      mark: element.mark,
      ref: element.ref,
      source: element.source,
      role: element.role,
      name: element.name,
      ...(element.value ? { value: element.value } : {}),
      ...(element.state ? { state: element.state } : {}),
      enabled: element.enabled,
      bounds,
      actions: element.actions,
    } : {
      ...element,
      bounds,
      center,
      ...(screenBounds ? { screen_bounds: screenBounds } : {}),
    };
    return elements.flatMap((element) => {
      if (!frame) {
        return [rendered(
          element,
          [element.x, element.y, element.width, element.height],
          [element.center_x, element.center_y],
        )];
      }
      const x = Math.round(((element.x - frame.originX) * frame.captureWidth) / frame.physicalWidth);
      const y = Math.round(((element.y - frame.originY) * frame.captureHeight) / frame.physicalHeight);
      const width = Math.max(1, Math.round((element.width * frame.captureWidth) / frame.physicalWidth));
      const height = Math.max(1, Math.round((element.height * frame.captureHeight) / frame.physicalHeight));
      if (x + width <= 0 || y + height <= 0 || x >= frame.captureWidth || y >= frame.captureHeight) {
        return [];
      }
      const clippedX = Math.max(0, x);
      const clippedY = Math.max(0, y);
      const clippedWidth = Math.max(1, Math.min(frame.captureWidth - clippedX, width - (clippedX - x)));
      const clippedHeight = Math.max(1, Math.min(frame.captureHeight - clippedY, height - (clippedY - y)));
      return [rendered(
        {
          ...element,
          x: clippedX,
          y: clippedY,
          width: clippedWidth,
          height: clippedHeight,
          center_x: clippedX + Math.round(clippedWidth / 2),
          center_y: clippedY + Math.round(clippedHeight / 2),
        },
        [clippedX, clippedY, clippedWidth, clippedHeight],
        [
          clippedX + Math.round(clippedWidth / 2),
          clippedY + Math.round(clippedHeight / 2),
        ],
        [element.x, element.y, element.width, element.height],
      )];
    });
  }

  async function somOverlay(
    image: { mimeType: string; data: string },
    width: number,
    height: number,
    elements: Array<Record<string, unknown>>,
    quality: number,
  ): Promise<{
    image: { mimeType: string; data: string };
    rendered: boolean;
    error?: string;
  }> {
    if (elements.length === 0) return { image, rendered: false };
    const marks = elements.map((element) => {
      const bounds = Array.isArray(element.bounds) ? element.bounds.map(Number) : [];
      if (bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) return '';
      const [x, y, w, h] = bounds;
      const mark = Number(element.mark);
      const color = element.source === 'ocr'
        ? '#72e06a'
        : element.source === 'msaa'
          ? '#ffb020'
          : '#29d3ff';
      const badgeWidth = Math.max(20, String(mark).length * 8 + 10);
      const badgeX = Math.max(0, Math.min(width - badgeWidth, x));
      const badgeY = Math.max(0, y - 20);
      return `<g><rect x="${x}" y="${y}" width="${Math.max(1, w)}" height="${Math.max(1, h)}"`
        + ` fill="none" stroke="${color}" stroke-width="2"/>`
        + `<rect x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="19" rx="4"`
        + ` fill="${color}" stroke="#101419" stroke-width="1"/>`
        + `<text x="${badgeX + badgeWidth / 2}" y="${badgeY + 14}" text-anchor="middle"`
        + ' font-family="Segoe UI,Arial,sans-serif" font-size="12" font-weight="700" fill="#101419">'
        + `${mark}</text></g>`;
    }).join('');
    let overlayWindow: BrowserWindow | null = null;
    try {
      const html = '<!doctype html><html><head><meta charset="utf-8">'
        + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
        + `<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}`
        + `img,svg{position:absolute;inset:0;width:${width}px;height:${height}px}</style></head><body>`
        + `<img src="data:${image.mimeType};base64,${image.data}">`
        + `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${marks}</svg>`
        + '</body></html>';
      overlayWindow = new BrowserWindow({
        show: false,
        frame: false,
        width,
        height,
        useContentSize: true,
        webPreferences: {
          offscreen: true,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      await overlayWindow.loadURL(
        `data:text/html;base64,${Buffer.from(html).toString('base64')}`,
      );
      const rendered = await new Promise<NativeImage>((resolve, reject) => {
        if (!overlayWindow || overlayWindow.isDestroyed()) {
          reject(new Error('SOM overlay renderer is unavailable'));
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error('SOM overlay renderer timed out'));
        }, 5_000);
        void overlayWindow.webContents.capturePage().then((frame) => {
          clearTimeout(timer);
          if (frame.isEmpty()) reject(new Error('SOM overlay renderer returned an empty frame'));
          else resolve(frame);
        }, (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const renderedSize = rendered.getSize();
      const sized = renderedSize.width === width && renderedSize.height === height
        ? rendered
        : rendered.resize({ width, height, quality: 'best' });
      const jpeg = sized.toJPEG(quality);
      if (!jpeg.length) return { image, rendered: false };
      return {
        image: { mimeType: 'image/jpeg', data: jpeg.toString('base64') },
        rendered: true,
      };
    } catch (error) {
      return {
        image,
        rendered: false,
        error: (error as Error).message || String(error),
      };
    } finally {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    }
  }

  function normalizeOcrWords(value: unknown): OcrWordRecord[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const row = raw as Record<string, unknown>;
      const text = String(row.text || '');
      if (!text) return [];
      return [{
        text,
        line: Number(row.line) || 0,
        x: Number(row.x) || 0,
        y: Number(row.y) || 0,
        width: Number(row.width) || 0,
        height: Number(row.height) || 0,
        center_x: Number(row.center_x) || 0,
        center_y: Number(row.center_y) || 0,
      }];
    });
  }

  function hasSemanticAccessibilityTarget(
    elements: ComputerElementRecord[],
    frame?: CaptureFrame,
  ): boolean {
    const containerRoles = new Set([
      'Window', 'Pane', 'Document', 'Group', 'Custom', 'Image', 'Text',
    ]);
    const actionableElements = elements.filter((element) =>
      element.enabled
      && element.width > 1
      && element.height > 1
      && !containerRoles.has(element.role)
      && element.actions.length > 0);
    if (!actionableElements.length) return false;

    const largestElementArea = elements.reduce(
      (largest, element) => Math.max(largest, element.width * element.height),
      0,
    );
    const contentSurfaceRoles = new Set(['Document', 'Custom', 'Image']);
    const dominantContentSurfaces = elements.filter((element) =>
      contentSurfaceRoles.has(element.role)
      && element.width > 1
      && element.height > 1
      && element.width * element.height * 2 >= largestElementArea);
    if (!dominantContentSurfaces.length) {
      if (frame) {
        const menuStripBottom = frame.originY + Math.max(64, frame.physicalHeight * 0.12);
        const confinedToMenuStrip = actionableElements.every((element) =>
          element.y + element.height / 2 <= menuStripBottom);
        if (confinedToMenuStrip) return false;
      }
      return true;
    }

    return actionableElements.some((element) => {
      const centerX = element.x + element.width / 2;
      const centerY = element.y + element.height / 2;
      return dominantContentSurfaces.some((surface) =>
        centerX >= surface.x
        && centerY >= surface.y
        && centerX <= surface.x + surface.width
        && centerY <= surface.y + surface.height);
    });
  }

  function normalizeGroundingText(value: string): string {
    return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  function dedupeOcrWords(
    words: OcrWordRecord[],
    accessibilityElements: Array<Record<string, unknown>>,
  ): OcrWordRecord[] {
    const labelled = accessibilityElements.flatMap((element) => {
      const text = normalizeGroundingText(`${String(element.name || '')} ${String(element.value || '')}`);
      const bounds = Array.isArray(element.bounds) ? element.bounds.map(Number) : [];
      return text && bounds.length === 4 ? [{ text, bounds }] : [];
    });
    return words.filter((word) => {
      const text = normalizeGroundingText(word.text);
      if (text.length < 2 || word.width < 2 || word.height < 2) return false;
      const wordRight = word.x + word.width;
      const wordBottom = word.y + word.height;
      return !labelled.some((candidate) => {
        if (!candidate.text.includes(text)) return false;
        const [x, y, width, height] = candidate.bounds;
        const overlapWidth = Math.max(0, Math.min(wordRight, x + width) - Math.max(word.x, x));
        const overlapHeight = Math.max(0, Math.min(wordBottom, y + height) - Math.max(word.y, y));
        const overlap = overlapWidth * overlapHeight;
        return overlap / Math.max(1, word.width * word.height) >= 0.5;
      });
    });
  }

  async function captureComputer(
    command: ComputerCommand,
    forcedWindowId?: string,
  ): Promise<{
    payload: Record<string, unknown>;
    image?: { mimeType: string; data: string };
  }> {
    const captureStartedAt = performance.now();
    const timings: Record<string, number> = {};
    const mode = captureMode(command);
    if (mode === 'ax' && command.include_ocr) {
      throw new Error('include_ocr requires capture mode state, som, or vision');
    }
    const explicitScreen = mode === 'vision'
      && command.screen !== undefined
      && !forcedWindowId
      && !command.window_id
      && !command.window
      && !command.app;
    if (mode !== 'vision' && command.screen !== undefined
      && !forcedWindowId && !command.window_id && !command.window && !command.app) {
      throw new Error('screen capture supports mode=vision only; use app or window_id for state/som/ax');
    }
    let windowId = forcedWindowId || command.window_id || '';
    if (!windowId && command.window) {
      const bounds = await callPowerShell({
        action: 'window_bounds',
        window: command.window,
        session_id: sessionIdFor(command),
        read_only: true,
      });
      if (!bounds.ok) throw new Error(bounds.error || 'window lookup failed');
      windowId = String(bounds.result?.window_id || '');
    }
    if (!windowId && command.app) windowId = await resolveAppWindowId(command);
    if (!windowId && !explicitScreen) windowId = await resolveForegroundWindowId(command);
    timings.target_resolution_ms = elapsedMs(captureStartedAt);
    const totalElementBudget = screenshotInteger(
      command.max_elements,
      mode === 'state' ? DEFAULT_CAPTURE_MAX_ELEMENTS : 200,
      1,
      1_000,
      'max_elements',
    );

    elementTargetsBySession.delete(sessionIdFor(command));
    let rawElements: ComputerElementRecord[] = [];
    let totalElements = 0;
    let continuation: unknown = null;
    let generation: unknown = null;
    let screenshot: ScreenshotCapture | null = null;
    if (mode !== 'vision' && !windowId) {
      throw new Error(`${mode} capture requires an exact target window`);
    }
    // External pixels can be captured while PowerShell walks UI Automation.
    // App-owned Chromium uses one renderer for both operations, so serialize it
    // to avoid a capturePage/UIA deadlock on newly opened BrowserWindows.
    const runScreenshotTask = async () => {
      if (mode === 'ax') return null;
      const startedAt = performance.now();
      const capture = await captureScreenshot({
        ...command,
        action: 'screenshot',
        window: undefined,
        window_id: windowId || undefined,
        ...(explicitScreen ? {} : { screen: undefined }),
        capture_after: false,
      });
      return { capture, elapsed: elapsedMs(startedAt) };
    };
    const runAccessibilityTask = async () => {
      if (mode === 'vision') return null;
      const startedAt = performance.now();
      const response = await callPowerShell({
        action: 'snapshot',
        window_id: windowId,
        query: command.query ?? null,
        role: command.role ?? null,
        visible_only: command.visible_only ?? null,
        include_noninteractive: command.include_noninteractive ?? null,
        include_structure: command.include_structure ?? null,
        max_elements: totalElementBudget,
        continuation: command.continuation ?? null,
        bounded: true,
        session_id: sessionIdFor(command),
        read_only: true,
      });
      return { response, elapsed: elapsedMs(startedAt) };
    };
    const serializeOwnedCapture = mode !== 'vision'
      && mode !== 'ax'
      && Boolean(windowId && electronWindowForNativeId(windowId));
    const captureResults = serializeOwnedCapture
      ? [await runAccessibilityTask(), await runScreenshotTask()] as const
      : await Promise.all([runAccessibilityTask(), runScreenshotTask()] as const);
    const [accessibilityResult, screenshotResult] = captureResults;
    if (accessibilityResult) {
      const snapshot = accessibilityResult.response;
      if (!snapshot.ok) throw new Error(snapshot.error || 'capture accessibility snapshot failed');
      rawElements = normalizeElementRecords(snapshot.result?.elements);
      totalElements = Number(snapshot.result?.total_elements) || rawElements.length;
      continuation = snapshot.result?.continuation ?? null;
      generation = snapshot.result?.generation ?? null;
      windowId = String(snapshot.result?.window_id || windowId);
      timings.accessibility_ms = accessibilityResult.elapsed;
      const hostTimings = snapshot.result?.timings_ms;
      if (hostTimings && typeof hostTimings === 'object') {
        for (const [phase, duration] of Object.entries(hostTimings)) {
          const value = Number(duration);
          if (Number.isFinite(value)) timings[`accessibility.${phase}`] = value;
        }
      }
    }
    if (screenshotResult) {
      screenshot = screenshotResult.capture;
      timings.screenshot_ms = screenshotResult.elapsed;
    }
    const requestedWindowId = windowId;
    const observationWindowId = screenshot?.frame?.windowId || windowId;

    const elements = frameElements(rawElements, screenshot?.frame, mode !== 'som')
      .slice(0, totalElementBudget);
    const semanticAccessibilityAvailable = hasSemanticAccessibilityTarget(
      rawElements,
      screenshot?.frame,
    );
    const requestedOcrLimit = command.include_ocr
      ? screenshotInteger(
          command.max_ocr_words,
          DEFAULT_OCR_MAX_WORDS,
          1,
          MAX_OCR_WORDS,
          'max_ocr_words',
        )
      : 0;
    const reservedOcrBudget = command.include_ocr
      && screenshot?.image
      && screenshot.frame
      && !semanticAccessibilityAvailable
      ? Math.min(requestedOcrLimit, Math.max(1, Math.floor(totalElementBudget / 2)))
      : 0;
    if (reservedOcrBudget > 0 && elements.length > totalElementBudget - reservedOcrBudget) {
      elements.splice(totalElementBudget - reservedOcrBudget);
    }
    const returnedAccessibilityElements = elements.length;
    let ocrWords: OcrWordRecord[] = [];
    let ocrPayload: Record<string, unknown> | undefined;
    let ocrElements: ComputerElementRecord[] = [];
    const remainingElementBudget = Math.max(0, totalElementBudget - returnedAccessibilityElements);
    const shouldRunOcr = Boolean(
      screenshot?.image
      && screenshot.frame
      && command.include_ocr
      && !semanticAccessibilityAvailable
      && remainingElementBudget > 0,
    );
    if (shouldRunOcr && screenshot?.image && screenshot.frame) {
      const ocrStartedAt = performance.now();
      try {
        const ocr = await callPowerShell({
          action: 'ocr_image',
          image_base64: screenshot.image.data,
          ocr_language: command.ocr_language ?? null,
          max_ocr_words: Math.min(requestedOcrLimit, remainingElementBudget),
          session_id: sessionIdFor(command),
          read_only: true,
        });
        if (!ocr.ok) throw new Error(ocr.error || 'Windows OCR failed');
        ocrWords = dedupeOcrWords(
          normalizeOcrWords(ocr.result?.words),
          elements,
        ).slice(0, remainingElementBudget);
        if (mode === 'som' || mode === 'state') {
          let nextMark = rawElements.reduce(
            (maximumMark, element) => Math.max(maximumMark, element.mark),
            0,
          ) + 1;
          ocrElements = ocrWords.map((word) => {
            const mark = nextMark++;
            return {
              mark,
              ref: `ocr:${screenshot.frameId}:${mark}`,
              source: 'ocr',
              role: 'Text',
              name: word.text,
              value: '',
              state: 'ocr',
              enabled: true,
              x: word.x,
              y: word.y,
              width: Math.max(1, word.width),
              height: Math.max(1, word.height),
              center_x: word.center_x,
              center_y: word.center_y,
              actions: ['click'],
              frame_id: screenshot.frameId,
              window_id: observationWindowId || undefined,
            };
          });
          for (const element of ocrElements) {
            const topLeft = framePoint(screenshot.frame, element.x, element.y);
            const bottomRight = framePoint(
              screenshot.frame,
              Math.min(screenshot.frame.captureWidth - 1, element.x + element.width - 1),
              Math.min(screenshot.frame.captureHeight - 1, element.y + element.height - 1),
            );
            const bounds: [number, number, number, number] = [
              element.x,
              element.y,
              element.width,
              element.height,
            ];
            elements.push(mode === 'state' ? {
              mark: element.mark,
              ref: element.ref,
              source: element.source,
              role: element.role,
              name: element.name,
              state: element.state,
              enabled: element.enabled,
              bounds,
              actions: element.actions,
            } : {
              ...element,
              bounds,
              center: [element.center_x, element.center_y],
              screen_bounds: [
                topLeft.x,
                topLeft.y,
                Math.max(1, bottomRight.x - topLeft.x + 1),
                Math.max(1, bottomRight.y - topLeft.y + 1),
              ],
            });
          }
        }
        const markedWords = mode === 'som' || mode === 'state'
          ? ocrWords.map((word, index) => ({
              ...word,
              mark: ocrElements[index]?.mark,
            }))
          : ocrWords;
        ocrPayload = {
          ok: true,
          mode: 'fallback',
          language: String(ocr.result?.language || ''),
          lines: Array.isArray(ocr.result?.lines) ? ocr.result?.lines : [],
          words: markedWords,
          total_words: Number(ocr.result?.total_words) || 0,
          truncated_words: Number(ocr.result?.truncated_words) || 0,
        };
      } catch (error) {
        ocrPayload = {
          ok: false,
          error: (error as Error).message || String(error),
        };
      }
      timings.ocr_ms = elapsedMs(ocrStartedAt);
    } else if (command.include_ocr) {
      ocrPayload = {
        ok: true,
        mode: 'fallback',
        skipped: true,
        reason: remainingElementBudget <= 0
          ? 'element_budget_exhausted'
          : semanticAccessibilityAvailable
            ? 'semantic_accessibility_available'
            : screenshot?.pixelUnavailable
              ? 'pixel_unavailable'
              : 'screenshot_unavailable',
        lines: [],
        words: [],
        total_words: 0,
        truncated_words: 0,
      };
    }
    if (mode !== 'vision') {
      rememberElementTargets(command, [...rawElements, ...ocrElements]);
    }
    if (observationWindowId) {
      rememberObservedWindowScope(
        command,
        observationWindowId,
        screenshot?.frame?.relatedWindowIds || [observationWindowId],
      );
    }
    const mergedTotalElements = totalElements + ocrElements.length;
    const truncatedAccessibilityElements = Math.max(
      0,
      totalElements - returnedAccessibilityElements,
    );
    const payload: Record<string, unknown> = {
      ok: !screenshot?.pixelUnavailable || returnedAccessibilityElements > 0,
      action: 'capture',
      mode,
      coordinate_space: screenshot?.frame ? 'frame' : 'screen',
      ...(observationWindowId ? { window_id: observationWindowId } : {}),
      ...(requestedWindowId && requestedWindowId !== observationWindowId ? {
        requested_window_id: requestedWindowId,
        capture_target_reason: 'capturable_owner',
      } : {}),
      ...(generation !== null ? { generation } : {}),
      total_elements: mergedTotalElements,
      returned_elements: elements.length,
      ...(ocrElements.length ? {
        total_accessibility_elements: totalElements,
        ocr_elements: ocrElements.length,
      } : {}),
      ...(continuation ? { continuation } : {}),
      ...(truncatedAccessibilityElements
        ? { truncated_elements: truncatedAccessibilityElements }
        : {}),
      ...(mode !== 'vision' ? { elements } : {}),
      ...(ocrPayload ? { ocr: ocrPayload } : {}),
      pixel_status: screenshot?.pixelUnavailable ? 'unavailable' : mode === 'ax' ? 'not_requested' : 'available',
      ...(screenshot?.pixelUnavailable ? {
        pixel_unavailable: screenshot.pixelUnavailable,
        escalation: 'recapture',
      } : {}),
    };
    let image = screenshot?.image;
    if (screenshot?.frame && screenshot.frameId) {
      payload.frame_id = screenshot.frameId;
      payload.width = screenshot.frame.captureWidth;
      payload.height = screenshot.frame.captureHeight;
      if (mode === 'som' && image) {
        const overlayStartedAt = performance.now();
        const quality = screenshotInteger(
          command.quality,
          DEFAULT_SCREENSHOT_QUALITY,
          0,
          100,
          'quality',
        );
        const overlay = await somOverlay(
          image,
          screenshot.frame.captureWidth,
          screenshot.frame.captureHeight,
          elements,
          quality,
        );
        image = overlay.image;
        payload.overlay_rendered = overlay.rendered;
        if (overlay.error) payload.overlay_error = overlay.error;
        timings.overlay_ms = elapsedMs(overlayStartedAt);
      }
    }
    timings.total_ms = elapsedMs(captureStartedAt);
    payload.timings_ms = timings;
    return {
      payload,
      ...(image ? { image } : {}),
    };
  }

  function assertExecutionNotAborted(): void {
    if (executionContext.getStore()?.aborted) {
      throw new Error('computer_session_aborted: command stopped by session cancellation');
    }
  }

  async function readInputRecovery(
    command: ComputerCommand,
    targetWindowId: string | undefined,
    includeRef = true,
  ): Promise<InputRecoveryState> {
    const response = await callPowerShell({
      action: 'input_recovery_state',
      window: command.window ?? null,
      window_id: targetWindowId ?? null,
      ref: includeRef ? command.ref ?? null : null,
      session_id: sessionIdFor(command),
      read_only: true,
    });
    if (!response.ok) throw new Error(response.error || 'foreground input recovery lookup failed');
    const result = response.result || {};
    const recovery: InputRecoveryState = {
      targetWindowId: String(result.target_window_id || ''),
      restoreWindowId: String(result.restore_window_id || result.foreground_window_id || ''),
      cursorX: Number(result.cursor_x),
      cursorY: Number(result.cursor_y),
    };
    if (!recovery.targetWindowId || !Number.isFinite(recovery.cursorX) || !Number.isFinite(recovery.cursorY)) {
      throw new Error('foreground input recovery state is incomplete; no input was sent');
    }
    return recovery;
  }

  async function captureAfterAction(
    command: ComputerCommand,
    windowId: string,
    delayOverrideMs?: number,
    reportedDelayMs?: number,
  ): Promise<{
    metadata: Record<string, unknown>;
    image?: { mimeType: string; data: string };
  }> {
    const delayMs = delayOverrideMs ?? screenshotInteger(
        command.capture_delay_ms,
        DEFAULT_CAPTURE_AFTER_DELAY_MS,
        0,
        MAX_CAPTURE_AFTER_DELAY_MS,
        'capture_delay_ms',
      );
    if (!windowId) {
      return {
        metadata: {
          ok: false,
          error: 'exact target window is unavailable; no screen fallback was captured',
        },
      };
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    assertExecutionNotAborted();
    try {
      const capture = await captureComputer({
        ...command,
        action: 'capture',
        mode: command.capture_after_mode || 'state',
        max_elements: command.capture_after_max_elements || DEFAULT_CAPTURE_MAX_ELEMENTS,
        include_ocr: command.capture_after_include_ocr === true,
        ocr_language: command.capture_after_ocr_language,
        max_ocr_words: command.capture_after_max_ocr_words,
        window: undefined,
        window_id: windowId,
        screen: undefined,
        capture_after: false,
      }, windowId);
      assertExecutionNotAborted();
      return {
        metadata: {
          ...capture.payload,
          ok: true,
          delay_ms: reportedDelayMs ?? delayMs,
          verification: 'not_performed',
        },
        ...(capture.image ? { image: capture.image } : {}),
      };
    } catch (error) {
      assertExecutionNotAborted();
      return {
        metadata: {
          ok: false,
          window_id: windowId,
          error: (error as Error).message || String(error),
        },
      };
    }
  }

  async function runBoundedSequence(command: ComputerCommand): Promise<ComputerCommandResult> {
    const startedAt = performance.now();
    const windowId = String(command.window_id || '');
    const steps = Array.isArray(command.steps) ? command.steps : [];
    if (!windowId) throw new Error('sequence requires exact window_id');
    if (steps.length < 2 || steps.length > 6) throw new Error('sequence requires 2..6 steps');
    const observedScope = observedWindowBySession.get(sessionIdFor(command));
    if (!observedScope?.relatedWindowIds.includes(windowId)) {
      throw new Error(
        `stale_target: sequence targets ${windowId}, but the latest observation is `
          + `${observedScope?.primaryWindowId || 'missing'}`,
      );
    }
    const rows: Array<Record<string, unknown>> = [];
    let stoppedReason = '';
    let finalWindowId = windowId;
    let lastTransition: ComputerWindowTransition | null = null;
    let completedSteps = 0;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const stepAction = String(step.action || '');
      if (index === 0) {
        if (!['invoke', 'click', 'right_click', 'middle_click', 'type', 'key'].includes(stepAction)) {
          throw new Error('sequence first step must be click, type, or key');
        }
      } else if (!['type', 'key', 'wait'].includes(stepAction)) {
        throw new Error('sequence continuation steps must be type, key, or wait');
      }
      const stepCommand: ComputerCommand = {
        ...step,
        action: stepAction,
        window_id: windowId,
        delivery: command.delivery || 'background',
        session_id: sessionIdFor(command),
      };
      suppressedSequenceCaptures.add(stepCommand);
      if (index > 0) trustedSequenceContinuations.add(stepCommand);
      const result = await runCommand(stepCommand);
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(result.text) as Record<string, unknown>;
      } catch {
        payload = { ok: true, action: stepAction, message: result.text };
      }
      completedSteps += 1;
      const transition = payload.window_transition as ComputerWindowTransition | undefined;
      lastTransition = transition || null;
      if (transition?.next_target?.id) finalWindowId = transition.next_target.id;
      rows.push({
        index: index + 1,
        action: stepAction,
        ok: payload.ok !== false,
        effect: payload.effect || 'unverifiable',
        path: payload.path || 'unknown',
        verdict: payload.verdict || null,
        ...(transition ? { window_transition: transition } : {}),
      });
      const verdict = payload.verdict as Record<string, unknown> | undefined;
      if (payload.ok === false || verdict?.decision === 'escalate') {
        stoppedReason = String(payload.code || payload.escalation || 'step_failed');
        break;
      }
      if (transition?.next_target && index < steps.length - 1) {
        stoppedReason = 'target_transition';
        break;
      }
    }
    const completed = completedSteps === steps.length && !stoppedReason;
    const capture = await captureAfterAction(command, finalWindowId, 0, 0);
    const payload: Record<string, unknown> = {
      ok: completed,
      action: 'sequence',
      window_id: windowId,
      completed,
      completed_steps: completedSteps,
      total_steps: steps.length,
      steps: rows,
      ...(stoppedReason ? { stopped_reason: stoppedReason } : {}),
      ...(lastTransition ? { window_transition: lastTransition } : {}),
      goal_verified: false,
      verdict: completed
        ? { decision: 'verify_fresh_state' }
        : {
            decision: 'escalate',
            recommended: stoppedReason === 'target_transition' ? 'switch_target' : 'inspect_failed_step',
          },
      capture_after: {
        ...capture.metadata,
        target_reason: finalWindowId === windowId ? 'original_target' : 'sequence_successor',
        ...(finalWindowId !== windowId ? { previous_window_id: windowId } : {}),
      },
      timings_ms: { total_ms: elapsedMs(startedAt) },
    };
    return {
      text: JSON.stringify(payload),
      ...(capture.image ? { image: capture.image } : {}),
    };
  }

  async function runCommand(command: ComputerCommand): Promise<ComputerCommandResult> {
    const commandStartedAt = performance.now();
    const actionTimings: Record<string, number> = {};
    const trustedSequenceContinuation = trustedSequenceContinuations.has(command);
    const action = String(command.action || '').trim();
    if (!action) throw new Error('computer command requires action');
    if (process.platform !== 'win32') {
      throw new Error('computer use is currently supported on Windows only');
    }
    if (action === 'session_release') return await releaseComputerSession(command);
    if (action === 'diagnose') return await diagnoseComputer(command);
    if (action === 'sequence') return await runBoundedSequence(command);
    const readActions = new Set([
      'list_windows', 'list_apps', 'snapshot', 'find', 'capture', 'clipboard_read', 'wait',
      'window_bounds', 'screenshot', 'zoom',
    ]);
    const isMutation = !readActions.has(action);
    const shouldCaptureAfter = isMutation
      && !suppressedSequenceCaptures.has(command)
      && (AUTO_CAPTURE_ACTIONS.has(action) || command.capture_after === true);
    if (isMutation && command.read_only) {
      throw new Error(`read_only run: '${action}' is a mutation`);
    }
    if (!isMutation && command.capture_after) {
      throw new Error(`capture_after is only valid for mutation actions, not '${action}'`);
    }
    if (shouldCaptureAfter) {
      screenshotInteger(
        command.capture_delay_ms,
        DEFAULT_CAPTURE_AFTER_DELAY_MS,
        0,
        MAX_CAPTURE_AFTER_DELAY_MS,
        'capture_delay_ms',
      );
      if (command.capture_after_mode
        && !['state', 'som', 'vision', 'ax'].includes(command.capture_after_mode)) {
        throw new Error('capture_after_mode must be state, som, vision, or ax');
      }
      screenshotInteger(
        command.capture_after_max_elements,
        DEFAULT_CAPTURE_MAX_ELEMENTS,
        1,
        1_000,
        'capture_after_max_elements',
      );
      if (command.capture_after_include_ocr && command.capture_after_mode === 'ax') {
        throw new Error('capture_after_include_ocr requires capture_after_mode state, som, or vision');
      }
      if (command.capture_after_include_ocr) {
        screenshotInteger(
          command.capture_after_max_ocr_words,
          DEFAULT_OCR_MAX_WORDS,
          1,
          MAX_OCR_WORDS,
          'capture_after_max_ocr_words',
        );
      }
    }
    if (shouldCaptureAfter !== command.capture_after) {
      command = { ...command, capture_after: shouldCaptureAfter };
    }
    if (command.app?.trim() && !['launch', 'list_apps', 'capture'].includes(action)) {
      command = {
        ...command,
        window: undefined,
        window_id: await resolveAppWindowId(command),
      };
    }
    command = resolveElementAliases(command);
    assertSafeComputerInput(command);
    if (action === 'list_apps') return await listComputerApps(command);
    if (action === 'capture') {
      const capture = await captureComputer(command);
      return {
        text: JSON.stringify(capture.payload),
        ...(capture.image ? { image: capture.image } : {}),
      };
    }
    if (action === 'screenshot') {
      const screenshot = await captureScreenshot(command);
      if (screenshot.pixelUnavailable) {
        return {
          text: JSON.stringify({
            ok: false,
            action: 'screenshot',
            code: 'pixel_unavailable',
            pixel_status: 'unavailable',
            pixel_unavailable: screenshot.pixelUnavailable,
            escalation: 'recapture',
          }),
        };
      }
      if (!screenshot.image || !screenshot.frame || !screenshot.frameId) {
        throw new Error('screenshot capture returned incomplete state');
      }
      if (screenshot.frame.windowId) {
        rememberObservedWindowScope(
          command,
          screenshot.frame.windowId,
          screenshot.frame.relatedWindowIds || [screenshot.frame.windowId],
        );
      }
      return { text: screenshot.description, image: screenshot.image };
    }
    if (action === 'zoom') {
      const zoom = await captureZoom(command);
      if (!zoom) throw new Error('zoom capture failed');
      return { text: zoom.description, image: zoom.image };
    }
    let physicalX = command.x;
    let physicalY = command.y;
    let physicalToX = command.to_x;
    let physicalToY = command.to_y;
    let targetWindowId = command.window_id;
    let allowedWindowIds: string[] = [];
    let observedScope: ObservedWindowScope | undefined;
    const pixelActions = new Set(['click', 'double_click', 'right_click', 'middle_click', 'triple_click', 'mouse_move']);
    if ((pixelActions.has(action)
        || (action === 'type' && command.x !== undefined && command.y !== undefined))
      && !command.ref) {
      if (command.x === undefined || command.y === undefined) {
        throw new Error(`${action} requires ref or frame-bound x/y coordinates`);
      }
      const frame = await requireValidFrame(command);
      const point = framePoint(frame, command.x, command.y);
      physicalX = point.x;
      physicalY = point.y;
      targetWindowId = frame.windowId || targetWindowId;
      allowedWindowIds = frame.relatedWindowIds || (targetWindowId ? [targetWindowId] : []);
    }
    if (action === 'drag' && !command.ref) {
      if (command.x === undefined || command.y === undefined
        || command.to_x === undefined || command.to_y === undefined) {
        throw new Error('drag requires ref/to or frame-bound x/y/to_x/to_y coordinates');
      }
      const frame = await requireValidFrame(command);
      const from = framePoint(frame, command.x, command.y);
      const to = framePoint(frame, command.to_x, command.to_y);
      physicalX = from.x;
      physicalY = from.y;
      physicalToX = to.x;
      physicalToY = to.y;
      targetWindowId = frame.windowId || targetWindowId;
      if (!targetWindowId) throw new Error('coordinate drag requires a window capture frame');
      allowedWindowIds = frame.relatedWindowIds || [targetWindowId];
    }
    if (action === 'scroll' && !command.ref
      && (command.x !== undefined || command.y !== undefined)) {
      if (command.x === undefined || command.y === undefined) {
        throw new Error('coordinate scroll requires frame-bound x and y');
      }
      const frame = await requireValidFrame(command);
      const point = framePoint(frame, command.x, command.y);
      physicalX = point.x;
      physicalY = point.y;
      targetWindowId = frame.windowId || targetWindowId;
      if (!targetWindowId) throw new Error('coordinate scroll requires a window capture frame');
      allowedWindowIds = frame.relatedWindowIds || [targetWindowId];
    }
    if (OBSERVATION_BOUND_INPUT_ACTIONS.has(action)) {
      observedScope = observedWindowBySession.get(sessionIdFor(command));
      if (!observedScope && !(trustedSequenceContinuation && targetWindowId)) {
        throw new Error(`${action} requires a fresh capture/snapshot/find of the exact target window first`);
      }
      if (observedScope
        && targetWindowId
        && !observedScope.relatedWindowIds.includes(targetWindowId)) {
        throw new Error(
          `stale_target: ${action} targets ${targetWindowId}, but the latest observation is `
            + observedScope.primaryWindowId,
        );
      }
      targetWindowId = targetWindowId || observedScope?.primaryWindowId;
    }
    const logicalTargetWindowId = observedScope?.primaryWindowId || targetWindowId;
    if (isMutation) claimComputerTargets(command, [logicalTargetWindowId, targetWindowId]);
    let inputRecovery: InputRecoveryState | undefined;
    if (action === 'focus_window' || command.delivery === 'foreground') {
      inputRecovery = await readInputRecovery(command, targetWindowId);
      const activeExecution = executionContext.getStore();
      if (activeExecution?.sessionId === sessionIdFor(command)) {
        activeExecution.recovery = inputRecovery;
      }
      assertExecutionNotAborted();
    }
    const beforeWindowsStartedAt = performance.now();
    const windowsBefore = isMutation ? await readComputerWindows(command) : null;
    if (isMutation) actionTimings.before_windows_ms = elapsedMs(beforeWindowsStartedAt);
    const targetWindowBefore = windowsBefore?.find((window) => window.id === targetWindowId);
    let response: PowerShellResponse;
    const deliveryStartedAt = performance.now();
    try {
      const electronTextTarget = action === 'type'
        && command.delivery !== 'foreground'
        && !command.ref
        ? electronWindowForNativeId(targetWindowId)
        : null;
      if (electronTextTarget && !electronTextTarget.webContents.isDestroyed()) {
        const text = String(command.text ?? '');
        if (physicalX !== undefined && physicalY !== undefined) {
          const focused = await callPowerShell({
            action: 'click',
            window_id: targetWindowId ?? null,
            x: physicalX,
            y: physicalY,
            allowed_window_ids: allowedWindowIds,
            delivery: 'background',
            session_id: sessionIdFor(command),
          });
          if (!focused.ok) {
            throw new Error(focused.error || 'element-targeted type could not focus the point');
          }
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        await electronTextTarget.webContents.insertText(text);
        response = {
          id: 0,
          ok: true,
          result: {
            action: 'type',
            text: `typed ${text.length} literal characters into app-owned Electron renderer`,
            path: physicalX !== undefined && physicalY !== undefined
              ? 'electron_point_focus_insert_text'
              : 'electron_insert_text',
            effect: 'unverifiable',
            verified: false,
            delivery_accepted: true,
            goal_verified: false,
            delivery: 'background',
            window_id: targetWindowId,
            pid: electronTextTarget.webContents.getOSProcessId(),
          },
        };
      } else {
        const powerShellRequest = {
          action,
          window: command.window ?? null,
          window_id: targetWindowId ?? null,
          ref: command.ref ?? null,
          to: command.to ?? null,
          text: command.text ?? null,
          keys: command.keys ?? null,
          dy: command.dy ?? null,
          amount: command.amount ?? null,
          direction: command.direction ?? null,
          app: command.app ?? null,
          x: physicalX ?? null,
          y: physicalY ?? null,
          to_x: physicalToX ?? null,
          to_y: physicalToY ?? null,
          allowed_window_ids: allowedWindowIds,
          width: command.width ?? null,
          height: command.height ?? null,
          state: command.state ?? null,
          modifiers: command.modifiers ?? null,
          duration: command.duration ?? null,
          delivery: command.delivery ?? 'background',
          read_only: command.read_only ?? false,
          query: command.query ?? null,
          role: command.role ?? null,
          visible_only: command.visible_only ?? null,
          include_noninteractive: command.include_noninteractive ?? null,
          max_elements: command.max_elements ?? null,
          continuation: command.continuation ?? null,
          session_id: sessionIdFor(command),
        };
        const integrity = command.delivery === 'foreground'
          ? await readWindowIntegrity(targetWindowId, sessionIdFor(command))
          : { known: false, higher: false, ownName: 'Unknown', targetName: 'Unknown' };
        if (command.delivery === 'foreground' && !integrity.known) {
          throw new Error(
            'target_integrity_unknown: foreground input was not sent because the target integrity could not be verified',
          );
        }
        const usePrivilegedWorker = integrity.known && integrity.higher;
        response = usePrivilegedWorker
          ? await callPowerShellElevated(powerShellRequest)
          : await callPowerShell(powerShellRequest);
        if (usePrivilegedWorker && response.result) {
          response.result.path = `uac_elevated_${String(response.result.path || 'foreground_input')}`;
          response.result.privilege = {
            source_integrity: integrity.ownName,
            target_integrity: integrity.targetName,
            worker: 'one_shot',
          };
        }
      }
    } finally {
      if (isMutation) {
        framesBySession.delete(sessionIdFor(command));
        elementTargetsBySession.delete(sessionIdFor(command));
        if (OBSERVATION_BOUND_INPUT_ACTIONS.has(action)) {
          observedWindowBySession.delete(sessionIdFor(command));
        }
      }
    }
    actionTimings.delivery_ms = elapsedMs(deliveryStartedAt);
    assertExecutionNotAborted();
    if (!response.ok) throw new Error(response.error || 'computer command failed');
    const result = response.result || {};
    let inputRecoveryVerification: Record<string, unknown> | undefined;
    if (inputRecovery) {
      let current: InputRecoveryState | undefined;
      let reasserted = false;
      let readbackError = '';
      try {
        current = await readInputRecovery(command, targetWindowId, false);
      } catch (error) {
        readbackError = (error as Error).message || String(error);
      }
      try {
        if (!current
          || current.restoreWindowId !== inputRecovery.restoreWindowId
          || current.cursorX !== inputRecovery.cursorX
          || current.cursorY !== inputRecovery.cursorY) {
          const recoveryStartedAt = performance.now();
          const restored = await callPowerShell({
            action: 'restore_input_state',
            restore_window_id: inputRecovery.restoreWindowId,
            cursor_x: inputRecovery.cursorX,
            cursor_y: inputRecovery.cursorY,
            session_id: sessionIdFor(command),
          });
          actionTimings.input_recovery_ms = elapsedMs(recoveryStartedAt);
          if (!restored.ok) throw new Error(restored.error || 'input recovery reassertion failed');
          current = {
            targetWindowId: inputRecovery.targetWindowId,
            restoreWindowId: String(restored.result?.foreground_window_id || ''),
            cursorX: Number(restored.result?.cursor_x),
            cursorY: Number(restored.result?.cursor_y),
          };
          reasserted = true;
        }
        const focusRestored = current.restoreWindowId === inputRecovery.restoreWindowId;
        const cursorRestored = current.cursorX === inputRecovery.cursorX
          && current.cursorY === inputRecovery.cursorY;
        inputRecoveryVerification = {
          ok: focusRestored && cursorRestored,
          focus_restored: focusRestored,
          cursor_restored: cursorRestored,
          expected_focus_window_id: inputRecovery.restoreWindowId,
          actual_focus_window_id: current.restoreWindowId,
          expected_cursor: [inputRecovery.cursorX, inputRecovery.cursorY],
          actual_cursor: [current.cursorX, current.cursorY],
          reasserted,
          ...(readbackError ? { readback_error: readbackError } : {}),
        };
      } catch (error) {
        inputRecoveryVerification = {
          ok: false,
          focus_restored: false,
          cursor_restored: false,
          error: (error as Error).message || String(error),
          ...(readbackError ? { readback_error: readbackError } : {}),
        };
      }
    }
    if (action === 'snapshot' || action === 'find') {
      rememberElementTargets(command, normalizeElementRecords(result.elements));
      const observedWindowId = String(result.window_id || command.window_id || '');
      if (observedWindowId) {
        rememberObservedWindowScope(command, observedWindowId);
      }
    }
    let windowTransition: ComputerWindowTransition | null = null;
    let settleDelayMs = 0;
    if (isMutation) {
      const settleStartedAt = performance.now();
      settleDelayMs = screenshotInteger(
        command.capture_after ? command.capture_delay_ms : undefined,
        DEFAULT_CAPTURE_AFTER_DELAY_MS,
        0,
        MAX_CAPTURE_AFTER_DELAY_MS,
        'capture_delay_ms',
      );
      let windowScanMs = 0;
      const transitionFor = (windowsAfter: ComputerWindowRecord[] | null) =>
        windowsBefore && windowsAfter
          ? computeComputerWindowTransition(
              windowsBefore,
              windowsAfter,
              String(logicalTargetWindowId || result.window_id || ''),
              Number(result.pid) || 0,
              action === 'launch' ? String(result.app_hint || command.app || '') : '',
            )
          : null;
      if (action === 'launch') {
        const deadline = settleStartedAt + Math.max(settleDelayMs, LAUNCH_SUCCESSOR_TIMEOUT_MS);
        const minimumLaunchSettleMs = Math.max(settleDelayMs, 500);
        let launchSuccessorReady = false;
        do {
          const remainingMs = Math.max(0, deadline - performance.now());
          if (remainingMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(LAUNCH_POLL_INTERVAL_MS, remainingMs)));
          }
          assertExecutionNotAborted();
          const transitionStartedAt = performance.now();
          const includeAppMetadata =
            performance.now() - settleStartedAt >= minimumLaunchSettleMs;
          const windowsAfter = await readComputerWindows(command, includeAppMetadata);
          windowScanMs += elapsedMs(transitionStartedAt);
          windowTransition = transitionFor(windowsAfter);
          launchSuccessorReady = Boolean(windowTransition?.next_target)
            && performance.now() - settleStartedAt >= minimumLaunchSettleMs;
        } while (!launchSuccessorReady && performance.now() < deadline);
        settleDelayMs = Math.round(performance.now() - settleStartedAt);
      } else {
        if (settleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
        assertExecutionNotAborted();
        const transitionStartedAt = performance.now();
        const windowsAfter = await readComputerWindows(command);
        windowScanMs = elapsedMs(transitionStartedAt);
        windowTransition = transitionFor(windowsAfter);
      }
      actionTimings.settle_ms = Math.max(0, elapsedMs(settleStartedAt) - windowScanMs);
      actionTimings.after_windows_ms = Number(windowScanMs.toFixed(2));
    }
    if (isMutation && windowTransition?.next_target?.id) {
      claimComputerTargets(command, [windowTransition.next_target.id]);
    }
    if (action === 'focus_window' && inputRecovery && result.verified === true && !result.code) {
      sessionRecoveryBySession.set(sessionIdFor(command), inputRecovery);
    }
    if (result.action) {
      const transitionVerified = transitionConfirmsSemanticAction(
        action,
        result,
        windowTransition,
        String(logicalTargetWindowId || result.window_id || ''),
        String(command.app || ''),
      );
      const effect = transitionVerified
        ? 'confirmed'
        : typeof result.effect === 'string' ? result.effect : 'unverifiable';
      const verified = result.verified === true || transitionVerified;
      const code = typeof result.code === 'string' && result.code ? result.code : undefined;
      const delivery = String(result.delivery || command.delivery || 'background');
      const recommendation = recommendedRecovery(
        action,
        effect,
        code,
        delivery,
        windowTransition,
        targetWindowBefore,
      );
      const escalation = inputRecoveryVerification?.ok === false
        ? 'input_recovery'
        : recommendation;
      const verdict: Record<string, unknown> = result.goal_verified === true || verified
        ? { decision: 'done' }
        : effect === 'suspected_noop' || code
          ? { decision: 'escalate' }
          : { decision: 'verify_fresh_state' };
      if (escalation) verdict.recommended = escalation;
      if (inputRecoveryVerification?.ok === false) verdict.decision = 'escalate';
      const payload: Record<string, unknown> = {
        ok: !code,
        action: result.action,
        message: String(result.text || ''),
        effect,
        verified,
        delivery_accepted: result.delivery_accepted === true,
        goal_verified: result.goal_verified === true || verified,
        path: result.path || 'unknown',
        delivery,
        ...(transitionVerified ? { verification_source: 'window_transition' } : {}),
        ...(typeof result.state_changed === 'boolean' ? { state_changed: result.state_changed } : {}),
        ...(logicalTargetWindowId || result.window_id
          ? { window_id: String(logicalTargetWindowId || result.window_id) }
          : {}),
        ...(result.window_id
          && logicalTargetWindowId
          && result.window_id !== logicalTargetWindowId
          ? { input_surface_window_id: result.window_id }
          : {}),
        ...(Number.isInteger(Number(result.pid)) ? { pid: Number(result.pid) } : {}),
        ...(result.app_hint ? { app_hint: String(result.app_hint) } : {}),
        ...(code ? { code } : {}),
        ...(windowTransition ? { window_transition: windowTransition } : {}),
        ...(inputRecoveryVerification ? { input_recovery: inputRecoveryVerification } : {}),
        ...(escalation ? { escalation } : {}),
        verdict,
      };
      let image: { mimeType: string; data: string } | undefined;
      if (command.capture_after) {
        const originalWindowId = String(logicalTargetWindowId || result.window_id || '');
        const targetClosed = action === 'close_window'
          && result.verified === true
          && windowTransition?.closed_windows.some((window) => window.id === originalWindowId);
        if (targetClosed) {
          payload.capture_after = {
            ok: true,
            action: 'capture',
            skipped: true,
            window_id: originalWindowId,
            target_reason: 'target_closed',
          };
        } else {
          const captureWindowId = windowTransition?.next_target?.id || originalWindowId;
          const postCaptureStartedAt = performance.now();
          const capture = await captureAfterAction(
            command,
            captureWindowId,
            0,
            settleDelayMs,
          );
          actionTimings.post_capture_ms = elapsedMs(postCaptureStartedAt);
          payload.capture_after = {
            ...capture.metadata,
            target_reason: capture.metadata.capture_target_reason
              || windowTransition?.next_target_reason
              || 'original_target',
            ...(originalWindowId && captureWindowId !== originalWindowId
              ? { previous_window_id: originalWindowId }
              : {}),
          };
          if (capture.metadata.pixel_status === 'unavailable') {
            verdict.decision = 'escalate';
            verdict.recommended = 'recapture';
            payload.escalation = 'recapture';
          }
          image = capture.image;
        }
      }
      actionTimings.total_ms = elapsedMs(commandStartedAt);
      payload.timings_ms = actionTimings;
      return {
        text: JSON.stringify(payload),
        ...(image ? { image } : {}),
      };
    }
    const text = String(result.text || 'OK');
    if (command.capture_after) {
      const originalWindowId = String(targetWindowId || '');
      const captureWindowId = windowTransition?.next_target?.id || originalWindowId;
      const postCaptureStartedAt = performance.now();
      const capture = await captureAfterAction(command, captureWindowId, 0, settleDelayMs);
      actionTimings.post_capture_ms = elapsedMs(postCaptureStartedAt);
      const recommendation = recommendedRecovery(
        action,
        'unverifiable',
        undefined,
        command.delivery || 'background',
        windowTransition,
        targetWindowBefore,
      );
      const escalation = capture.metadata.pixel_status === 'unavailable'
        ? 'recapture'
        : recommendation;
      return {
        text: JSON.stringify({
          ok: true,
          action,
          message: text,
          goal_verified: false,
          ...(windowTransition ? { window_transition: windowTransition } : {}),
          verdict: {
            decision: 'verify_fresh_state',
            ...(escalation ? { recommended: escalation } : {}),
          },
          ...(escalation ? { escalation } : {}),
          timings_ms: {
            ...actionTimings,
            total_ms: elapsedMs(commandStartedAt),
          },
          capture_after: {
            ...capture.metadata,
            target_reason: windowTransition?.next_target_reason || 'original_target',
            ...(originalWindowId && captureWindowId !== originalWindowId
              ? { previous_window_id: originalWindowId }
              : {}),
          },
        }),
        ...(capture.image ? { image: capture.image } : {}),
      };
    }
    if (isMutation) {
      const recommendation = recommendedRecovery(
        action,
        'unverifiable',
        undefined,
        command.delivery || 'background',
        windowTransition,
        targetWindowBefore,
      );
      return {
        text: JSON.stringify({
          ok: true,
          action,
          message: text,
          goal_verified: false,
          ...(windowTransition ? { window_transition: windowTransition } : {}),
          verdict: {
            decision: 'verify_fresh_state',
            ...(recommendation ? { recommended: recommendation } : {}),
          },
          ...(recommendation ? { escalation: recommendation } : {}),
          timings_ms: {
            ...actionTimings,
            total_ms: elapsedMs(commandStartedAt),
          },
        }),
      };
    }
    return { text };
  }

  function requiresForegroundLane(command: ComputerCommand): boolean {
    const action = String(command.action || '');
    return command.delivery === 'foreground'
      || action === 'focus_window'
      || action === 'launch'
      || action === 'session_release';
  }

  function executeSerialized(command: ComputerCommand): Promise<ComputerCommandResult> {
    const sessionId = sessionIdFor(command);
    touchTargetClaims(sessionId);
    const queuedEpoch = sessionAbortEpochs.get(sessionId) || 0;
    const previous = commandChainsBySession.get(sessionId) || Promise.resolve();
    const run = previous.then(async () => {
      if ((sessionAbortEpochs.get(sessionId) || 0) !== queuedEpoch) {
        throw new Error('computer_session_aborted: queued command was cancelled before execution');
      }
      const releaseHumanApprovalGuard = command.action === 'session_release'
        ? () => {}
        : beginComputerOperation();
      const execution = { sessionId, aborted: false };
      activeExecutionsBySession.set(sessionId, execution);
      try {
        const operation = () => executionContext.run(execution, () => runCommand(command));
        return requiresForegroundLane(command)
          ? await runForegroundExclusive(operation)
          : await operation();
      } finally {
        if (activeExecutionsBySession.get(sessionId) === execution) {
          activeExecutionsBySession.delete(sessionId);
        }
        releaseHumanApprovalGuard();
      }
    });
    const tail = run.catch(() => undefined);
    commandChainsBySession.set(sessionId, tail);
    void tail.finally(() => {
      if (commandChainsBySession.get(sessionId) === tail) {
        commandChainsBySession.delete(sessionId);
      }
    });
    return run;
  }

  const CHROME_SETUP_SESSION_ID = '__mixdog_browser_chrome_setup__';

  function parseComputerPayload(result: ComputerCommandResult): Record<string, unknown> {
    const parsed = JSON.parse(result.text) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Computer Use returned an invalid Chrome setup result.');
    }
    return parsed as Record<string, unknown>;
  }

  function payloadElements(payload: Record<string, unknown>): ComputerElementRecord[] {
    const captureAfter = payload.capture_after;
    const source = captureAfter && typeof captureAfter === 'object'
      ? captureAfter as Record<string, unknown>
      : payload;
    return normalizeElementRecords(source.elements);
  }

  async function proveChromeRemoteDebuggingTarget(
    target: ChromeRemoteDebuggingTarget,
  ): Promise<ComputerWindowRecord> {
    const windows = await readComputerWindows({
      action: 'list_windows',
      session_id: CHROME_SETUP_SESSION_ID,
      read_only: true,
    }, true);
    const exact = windows?.find((window) =>
      window.id === target.windowId
      && window.pid === target.pid
      && /^chrome$/i.test(window.app)
      && /^Chrome_WidgetWin_/i.test(window.className));
    if (!exact) {
      throw new Error('The approved Chrome window changed before Browser Use could connect.');
    }
    return exact;
  }

  async function proveChromeRemoteDebuggingSurface(
    target: ChromeRemoteDebuggingTarget,
    surfaceWindowId: string,
  ): Promise<ComputerWindowRecord> {
    const windows = await readComputerWindows({
      action: 'list_windows',
      session_id: CHROME_SETUP_SESSION_ID,
      read_only: true,
    }, true);
    const exact = windows?.find((window) =>
      window.id === surfaceWindowId
      && window.pid === target.pid
      && /^chrome$/i.test(window.app)
      && /^Chrome_WidgetWin_/i.test(window.className)
      && (window.id === target.windowId || window.ownerId === target.windowId));
    if (!exact) {
      throw new Error('The approved Chrome surface changed before Browser Use could connect.');
    }
    return exact;
  }

  async function inspectChromeRemoteDebuggingTarget(): Promise<ChromeRemoteDebuggingTarget> {
    const windows = await readComputerWindows({
      action: 'list_windows',
      session_id: CHROME_SETUP_SESSION_ID,
      read_only: true,
    }, true);
    const candidates = (windows || []).filter((window) =>
      /^chrome$/i.test(window.app)
      && /^Chrome_WidgetWin_/i.test(window.className)
      && window.pid > 0);
    const visible = candidates.filter((window) =>
      !window.minimized && window.width > 0 && window.height > 0);
    const target = visible.find((window) => window.focused)
      || visible[0]
      || candidates.find((window) => window.focused)
      || candidates[0];
    if (!target) {
      throw new Error('Open Chrome before connecting a logged-in tab.');
    }
    return { windowId: target.id, pid: target.pid };
  }

  async function captureChromeSetup(
    target: ChromeRemoteDebuggingTarget,
    surfaceWindowId = target.windowId,
  ): Promise<{
    payload: Record<string, unknown>;
    elements: ComputerElementRecord[];
  }> {
    await proveChromeRemoteDebuggingSurface(target, surfaceWindowId);
    const payload = parseComputerPayload(await executeSerialized({
      action: 'capture',
      window_id: surfaceWindowId,
      mode: 'ax',
      visible_only: true,
      include_noninteractive: true,
      include_structure: true,
      max_elements: 1_000,
      session_id: CHROME_SETUP_SESSION_ID,
      read_only: true,
    }));
    return { payload, elements: payloadElements(payload) };
  }

  async function ensureChromeSetupPage(
    target: ChromeRemoteDebuggingTarget,
  ): Promise<{
    control: ReturnType<typeof chromeSetupControl>;
    openedSetupPage: boolean;
  }> {
    const initial = await captureChromeSetup(target);
    const existing = chromeSetupControl(initial.elements);
    if (existing) return { control: existing, openedSetupPage: false };
    const opened = parseComputerPayload(await executeSerialized({
      action: 'key',
      window_id: target.windowId,
      keys: '^t',
      delivery: 'foreground',
      include_noninteractive: true,
      include_structure: true,
      capture_after: true,
      capture_after_mode: 'ax',
      capture_after_max_elements: 1_000,
      session_id: CHROME_SETUP_SESSION_ID,
    }));
    const openedAddress = chromeNativeAddressField(payloadElements(opened));
    const addressed = parseComputerPayload(await executeSerialized({
      action: 'set_value',
      window_id: target.windowId,
      ref: openedAddress.ref,
      text: CHROME_REMOTE_DEBUGGING_URL,
      delivery: 'background',
      include_noninteractive: true,
      include_structure: true,
      capture_after: true,
      capture_after_mode: 'ax',
      capture_after_max_elements: 1_000,
      session_id: CHROME_SETUP_SESSION_ID,
    }));
    const exactAddress = chromeNativeAddressField(payloadElements(addressed));
    if (exactAddress.value.toLowerCase() !== CHROME_REMOTE_DEBUGGING_URL.toLowerCase()) {
      throw new Error('Chrome native address field did not retain the exact setup URL.');
    }
    const navigated = parseComputerPayload(await executeSerialized({
      action: 'key',
      window_id: target.windowId,
      ref: exactAddress.ref,
      keys: '{ENTER}',
      delivery: 'foreground',
      include_noninteractive: true,
      include_structure: true,
      capture_after: true,
      capture_delay_ms: 1_200,
      capture_after_mode: 'ax',
      capture_after_max_elements: 1_000,
      session_id: CHROME_SETUP_SESSION_ID,
    }));
    const control = chromeSetupControl(payloadElements(navigated));
    if (!control) {
      throw new Error('Chrome remote-debugging setup did not become ready.');
    }
    return { control, openedSetupPage: true };
  }

  async function setChromeRemoteDebugging(
    target: ChromeRemoteDebuggingTarget,
    desiredEnabled: boolean,
  ): Promise<{
    openedSetupPage: boolean;
    changed: boolean;
  }> {
    const setupPage = await ensureChromeSetupPage(target);
    if (!setupPage.control) {
      throw new Error('Chrome remote-debugging setup control is unavailable.');
    }
    if (setupPage.control.enabled === desiredEnabled) {
      return { openedSetupPage: setupPage.openedSetupPage, changed: false };
    }
    const toggled = parseComputerPayload(await executeSerialized({
      action: 'toggle',
      window_id: target.windowId,
      ref: setupPage.control.ref,
      delivery: 'background',
      include_noninteractive: true,
      include_structure: true,
      capture_after: true,
      capture_after_mode: 'ax',
      capture_after_max_elements: 1_000,
      session_id: CHROME_SETUP_SESSION_ID,
    }));
    const verified = chromeSetupControl(payloadElements(toggled));
    if (!verified || verified.enabled !== desiredEnabled) {
      throw new Error('Chrome remote-debugging setup control did not retain the requested state.');
    }
    return { openedSetupPage: setupPage.openedSetupPage, changed: true };
  }

  async function closeChromeSetupPage(
    target: ChromeRemoteDebuggingTarget,
    openedSetupPage: boolean,
  ): Promise<void> {
    if (!openedSetupPage) return;
    const capture = await captureChromeSetup(target);
    if (!chromeSetupControl(capture.elements)) return;
    await executeSerialized({
      action: 'key',
      window_id: target.windowId,
      keys: '^w',
      delivery: 'foreground',
      session_id: CHROME_SETUP_SESSION_ID,
    });
  }

  async function prepareChromeRemoteDebugging(
    target: ChromeRemoteDebuggingTarget,
  ): Promise<ChromeRemoteDebuggingSetup> {
    const result = await setChromeRemoteDebugging(target, true);
    return {
      ...target,
      openedSetupPage: result.openedSetupPage,
      enabledByMixdog: result.changed,
    };
  }

  async function acceptChromeRemoteDebuggingConsent(
    setup: ChromeRemoteDebuggingSetup,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const deadline = Date.now() + 4_000;
    while (!signal?.aborted && Date.now() < deadline) {
      await proveChromeRemoteDebuggingTarget(setup);
      const windows = await readComputerWindows({
        action: 'list_windows',
        session_id: CHROME_SETUP_SESSION_ID,
        read_only: true,
      }, true);
      const ownedDialogs = (windows || []).filter((window) =>
        window.pid === setup.pid
        && window.ownerId === setup.windowId
        && /^chrome$/i.test(window.app)
        && /^Chrome_WidgetWin_/i.test(window.className)
        && !window.minimized
        && window.width > 0
        && window.height > 0);
      if (ownedDialogs.length > 1) {
        throw new Error('Chrome exposed multiple owned windows while remote-debugging consent was pending.');
      }
      const prompt = ownedDialogs[0];
      if (!prompt) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        continue;
      }
      const capture = await captureChromeSetup(setup, prompt.id);
      const allowRef = chromeOwnedConsentAllowRef(capture.elements);
      if (allowRef) {
        const invokeCommand: ComputerCommand = {
          action: 'invoke',
          window_id: prompt.id,
          ref: allowRef,
          delivery: 'background',
          session_id: CHROME_SETUP_SESSION_ID,
        };
        suppressedSequenceCaptures.add(invokeCommand);
        await executeSerialized(invokeCommand);
        const dismissalDeadline = Date.now() + 2_000;
        while (Date.now() < dismissalDeadline) {
          const remaining = await readComputerWindows({
            action: 'list_windows',
            session_id: CHROME_SETUP_SESSION_ID,
            read_only: true,
          }, true);
          if (!remaining?.some((window) => window.id === prompt.id && window.pid === setup.pid)) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error('Chrome remote-debugging consent remained after its exact allow action.');
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  }

  async function finalizeChromeRemoteDebuggingSetup(
    setup: ChromeRemoteDebuggingSetup,
  ): Promise<void> {
    try {
      await closeChromeSetupPage(setup, setup.openedSetupPage);
    } finally {
      await executeSerialized({
        action: 'session_release',
        session_id: CHROME_SETUP_SESSION_ID,
      });
    }
  }

  async function releaseChromeRemoteDebugging(
    setup: ChromeRemoteDebuggingSetup,
  ): Promise<void> {
    let openedSetupPage = false;
    try {
      if (setup.enabledByMixdog) {
        const result = await setChromeRemoteDebugging(setup, false);
        openedSetupPage = result.openedSetupPage;
      }
      await closeChromeSetupPage(setup, openedSetupPage);
    } finally {
      await executeSerialized({
        action: 'session_release',
        session_id: CHROME_SETUP_SESSION_ID,
      });
    }
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

  function writeDiscovery(port: number, activeToken: string): void {
    const directory = mixdogDataDirectory();
    mkdirSync(directory, { recursive: true });
    discoveryPath = join(directory, DISCOVERY_FILE);
    writeFileSync(discoveryPath, `${JSON.stringify({
      version: DISCOVERY_VERSION,
      port,
      token: activeToken,
      pid: process.pid,
      startedAt: Date.now(),
    })}\n`);
    try {
      chmodSync(discoveryPath, 0o600);
    } catch { /* Windows ACLs: the per-user data dir is already private */ }
  }

  function heartbeatDiscovery(port: number, activeToken: string): void {
    if (!discoveryPath) return;
    try {
      const now = new Date();
      utimesSync(discoveryPath, now, now);
    } catch {
      try {
        writeDiscovery(port, activeToken);
      } catch { /* data dir gone mid-shutdown */ }
    }
  }

  function removeDiscovery(activeToken: string): void {
    if (!discoveryPath) return;
    try {
      const current = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { token?: string };
      if (current?.token === activeToken) unlinkSync(discoveryPath);
    } catch { /* replaced or already gone */ }
    discoveryPath = null;
  }

  async function stopBridge(): Promise<void> {
    bridgeGeneration += 1;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    const activeToken = token;
    removeDiscovery(activeToken);
    const activeServer = server;
    server = null;
    if (!activeServer) return;
    await new Promise<void>((resolve) => {
      activeServer.close(() => resolve());
      activeServer.closeAllConnections?.();
      setTimeout(resolve, 250).unref?.();
    });
  }

  function startBridge(): void {
    if (disposed || !bridgeWanted || server) return;
    const generation = ++bridgeGeneration;
    const activeToken = randomBytes(24).toString('base64url');
    token = activeToken;
    const created = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST' || request.url !== '/command') {
          respond(response, 404, { ok: false, error: 'not found' });
          return;
        }
        if (String(request.headers.authorization || '') !== `Bearer ${activeToken}`) {
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
          const value = command.action === 'session_abort'
            ? await abortComputerSession(command)
            : await executeSerialized(command);
          respond(response, 200, { ok: true, value });
        } catch (error) {
          respond(response, 200, { ok: false, error: (error as Error).message || String(error) });
        }
      })().catch(() => {
        try { response.destroy(); } catch { /* already gone */ }
      });
    });
    server = created;
    created.listen(0, '127.0.0.1', () => {
      const address = created.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (!port) return;
      // Publish only after the native backend is warm. Disabling Computer Use
      // closes this listener and revokes its token without affecting Browser
      // Use's narrowly scoped internal UIA route.
      void callPowerShell({
        action: 'wait',
        duration: 0,
        session_id: '__computer_host_warmup__',
        read_only: true,
      }).then(() => {
        if (disposed || !bridgeWanted || server !== created || bridgeGeneration !== generation) return;
        try {
          writeDiscovery(port, activeToken);
          heartbeat = setInterval(
            () => heartbeatDiscovery(port, activeToken),
            HEARTBEAT_MS,
          );
          heartbeat.unref?.();
        } catch (error) {
          console.error('computer bridge discovery write failed:', error);
        }
      }).catch((error) => {
        console.error('computer resident backend warm-up failed:', error);
      });
    });
  }

  if (bridgeWanted) startBridge();

  return {
    setBridgeEnabled(enabled: boolean): void {
      if (disposed || bridgeWanted === enabled) return;
      bridgeWanted = enabled;
      if (enabled) startBridge();
      else void stopBridge().catch(() => {});
    },
    inspectChromeRemoteDebuggingTarget,
    prepareChromeRemoteDebugging,
    acceptChromeRemoteDebuggingConsent,
    finalizeChromeRemoteDebuggingSetup,
    releaseChromeRemoteDebugging,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      bridgeWanted = false;
      await stopBridge();
      for (const child of powerShellBySession.values()) {
        if (!child.killed) {
          try { child.kill(); } catch { /* already gone */ }
        }
      }
      powerShellBySession.clear();
      if (hostScriptPath) {
        try { unlinkSync(hostScriptPath); } catch { /* already gone */ }
      }
      hostScriptPath = null;
    },
  };
}