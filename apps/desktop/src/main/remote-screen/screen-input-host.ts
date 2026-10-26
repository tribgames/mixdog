/**
 * The resident Windows helper process of a screen session: desktop input
 * through Computer Use's own checked SendInput transport (InputTransport.cs,
 * `MixNativeInput`), and a watcher that reports which desktop takes input and
 * whether an elevation prompt or the sign-in screen is up.
 *
 * Line protocol, ASCII, one command per line on stdin:
 *   m <id> <x> <y>                       absolute move, desktop pixels
 *   b <id> <l|r|m> <0|1> [<x> <y>]       button up/down, optionally at a point
 *   w <id> <x> <y> <dx> <dy>             wheel at a point, wheel units (+ = down/right)
 *   k <id> <vk> <scan> <ext 0|1> <0|1>   key up/down
 *   t <id> <base64 utf-8>                literal text
 *   c <id>                               cursor position → ok <id> <x> <y>
 *   q                                    release everything this process holds, exit
 * stdout: the first `desktop` line, then `ready <windows session id>`, then
 * `desktop <name|-> <consent 0|1> <logonui 0|1>` on change,
 * `ok <id> ...` / `err <id> <code>` per command. End of stdin (the app died)
 * releases like `q`, so a crash never leaves a key or button down.
 *
 * Only the app that spawned it can command it: the protocol runs over its own
 * stdin/stdout pipes, and it opens no named pipe, socket or window.
 */
import type { ChildProcessWithoutNullStreams, spawn as spawnType } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_REMOTE_SCREEN_TEXT } from '../../shared/remote-webrtc';
import { MIXDOG_INPUT_TRANSPORT_CSHARP } from '../computer/backend/native-source';
import { COMMAND_TIMEOUT_MS } from '../computer/backend/worker-requests';
import type { ScreenDesktopIdentity } from './screen-input-router';
import { createComputerLineDecoder } from '../../../../../src/runtime/computer-bridge/limits.mjs';

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 4_000;
const MAX_LINE_BYTES = 64 * 1024;
const WATCH_INTERVAL_MS = 400;

const SCREEN_HOST_CSHARP = `
public static class MixdogScreenHost
{
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);

    static readonly object output = new object();
    static IntPtr marker;

    static void Write(string line)
    {
        lock (output) { Console.Out.Write(line + "\\n"); Console.Out.Flush(); }
    }

    public static void Serve(string markerText)
    {
        uint value;
        if (!UInt32.TryParse(markerText, out value) || value == 0 || value > Int32.MaxValue)
            throw new InvalidOperationException("input_marker_unavailable");
        marker = new IntPtr((int)value);
        // Physical pixels everywhere: the virtual-screen metrics below and the
        // cursor read-back must agree with the capture's native pixels.
        if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
        MixNativeInput.InitializeOwnership(marker);
        // The first desktop state and this process's Windows session go out
        // before ready, so every press can be tagged with where it lands.
        try { lastState = State(); Write("desktop " + lastState); } catch { }
        Write("ready " + Process.GetCurrentProcess().SessionId.ToString(CultureInfo.InvariantCulture));
        Thread watcher = new Thread(Watch);
        watcher.IsBackground = true;
        watcher.Start();
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line == "q") break;
            Handle(line);
        }
        try { MixNativeInput.ReleaseOwned(marker); Write("released"); }
        catch (Exception error) { Write("err 0 " + Code(error)); }
    }

    static string Code(Exception error)
    {
        string message = error.Message ?? "";
        int colon = message.IndexOf(':');
        string code = colon > 0 ? message.Substring(0, colon) : "input_failed";
        foreach (char ch in code) if (!(ch == '_' || (ch >= 'a' && ch <= 'z'))) return "input_failed";
        return code;
    }

    static int Int(string text)
    {
        int value;
        if (!Int32.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out value))
            throw new FormatException("protocol_error: bad number");
        return value;
    }

    static MixNativeInput.INPUT Move(int x, int y)
    {
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        if (width < 2 || height < 2) throw new InvalidOperationException("display_unavailable: no virtual screen");
        if (x < left || y < top || x >= left + width || y >= top + height)
            throw new InvalidOperationException("out_of_bounds: point is outside the desktop");
        // MOVE | VIRTUALDESK | ABSOLUTE, normalized over the whole virtual screen.
        MixNativeInput.INPUT input = MixNativeInput.Mouse(0xC001, marker);
        input.U.mi.dx = (int)Math.Round((x - left) * 65535.0 / (width - 1));
        input.U.mi.dy = (int)Math.Round((y - top) * 65535.0 / (height - 1));
        return input;
    }

    static MixNativeInput.INPUT Mouse(uint flags, int data)
    {
        MixNativeInput.INPUT input = MixNativeInput.Mouse(flags, marker);
        input.U.mi.mouseData = unchecked((uint)data);
        return input;
    }

    static uint ButtonFlag(string name, bool down)
    {
        if (name == "l") return down ? 0x02u : 0x04u;
        if (name == "r") return down ? 0x08u : 0x10u;
        if (name == "m") return down ? 0x20u : 0x40u;
        throw new FormatException("protocol_error: bad button");
    }

    static void Handle(string line)
    {
        string[] f = line.Split(' ');
        string id = f.Length > 1 ? f[1] : "0";
        try
        {
            var inputs = new List<MixNativeInput.INPUT>();
            switch (f[0])
            {
                case "m":
                    inputs.Add(Move(Int(f[2]), Int(f[3])));
                    break;
                case "b":
                    if (f.Length >= 6) inputs.Add(Move(Int(f[4]), Int(f[5])));
                    inputs.Add(Mouse(ButtonFlag(f[2], f[3] == "1"), 0));
                    break;
                case "w":
                    inputs.Add(Move(Int(f[2]), Int(f[3])));
                    int dx = Int(f[4]), dy = Int(f[5]);
                    if (dy != 0) inputs.Add(Mouse(0x0800, -dy));
                    if (dx != 0) inputs.Add(Mouse(0x1000, dx));
                    break;
                case "k":
                {
                    int vk = Int(f[2]), scan = Int(f[3]);
                    if (vk < 0 || vk > 254 || scan < 0 || scan > 255 || (vk == 0 && scan == 0))
                        throw new FormatException("protocol_error: bad key");
                    // A virtual key goes as such (the scan code rides along for
                    // apps that read it); a scan-only key goes as a scan code.
                    uint flags = (f[4] == "1" ? 0x1u : 0u) | (f[5] == "1" ? 0u : 0x2u) | (vk == 0 ? 0x8u : 0u);
                    inputs.Add(MixNativeInput.Key((ushort)vk, (ushort)scan, flags, marker));
                    break;
                }
                case "t":
                    Text(Encoding.UTF8.GetString(Convert.FromBase64String(f[2])));
                    break;
                case "c":
                {
                    POINT point;
                    if (!GetCursorPos(out point)) throw new InvalidOperationException("cursor_unavailable: no cursor");
                    Write("ok " + id + " " + point.x.ToString(CultureInfo.InvariantCulture) + " " + point.y.ToString(CultureInfo.InvariantCulture));
                    return;
                }
                default:
                    throw new FormatException("protocol_error: unknown command");
            }
            if (inputs.Count > 0) MixNativeInput.Deliver(inputs.ToArray());
            Write("ok " + id);
        }
        catch (Exception error)
        {
            Write("err " + id + " " + Code(error));
        }
    }

    static void Text(string text)
    {
        if (text.Length > ${MAX_REMOTE_SCREEN_TEXT}) throw new FormatException("protocol_error: text too long");
        foreach (char ch in text)
        {
            if (ch == '\\r') continue;
            // Line breaks and tabs go as their keys: a Unicode packet for a
            // control character is dropped or misread by many apps.
            MixNativeInput.INPUT[] glyph = ch == '\\n'
                ? new MixNativeInput.INPUT[] {
                    MixNativeInput.Key(0x0D, 0x1C, 0, marker), MixNativeInput.Key(0x0D, 0x1C, 0x2, marker) }
                : ch == '\\t'
                ? new MixNativeInput.INPUT[] {
                    MixNativeInput.Key(0x09, 0x0F, 0, marker), MixNativeInput.Key(0x09, 0x0F, 0x2, marker) }
                : new MixNativeInput.INPUT[] {
                    MixNativeInput.Key(0, (ushort)ch, 0x4, marker), MixNativeInput.Key(0, (ushort)ch, 0x4 | 0x2, marker) };
            MixNativeInput.Deliver(glyph);
            // Chromium and WinUI drop a tight Unicode burst; pacing keeps order.
            Thread.Sleep(4);
        }
    }

    static string DesktopName()
    {
        // Without access (the secure desktop) the input desktop cannot be opened.
        IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
        if (desktop == IntPtr.Zero) return "-";
        try
        {
            var name = new StringBuilder(256);
            int needed;
            if (!GetUserObjectInformationW(desktop, 2, name, name.Capacity * 2, out needed)) return "-";
            string text = name.ToString();
            var clean = new StringBuilder();
            foreach (char ch in text) if (ch > ' ' && ch < 127) clean.Append(ch);
            return clean.Length == 0 ? "-" : clean.ToString();
        }
        finally { CloseDesktop(desktop); }
    }

    static string ProcessFlags()
    {
        int session = Process.GetCurrentProcess().SessionId;
        bool consent = false, logon = false;
        foreach (Process process in Process.GetProcesses())
        {
            try
            {
                if (process.SessionId != session) continue;
                string name = process.ProcessName;
                if (String.Equals(name, "consent", StringComparison.OrdinalIgnoreCase)) consent = true;
                else if (String.Equals(name, "LogonUI", StringComparison.OrdinalIgnoreCase)) logon = true;
            }
            catch { }
            finally { process.Dispose(); }
        }
        return (consent ? "1" : "0") + " " + (logon ? "1" : "0");
    }

    static string lastState;

    static string State() { return DesktopName() + " " + ProcessFlags(); }

    static void Watch()
    {
        for (;;)
        {
            try
            {
                string state = State();
                if (state != lastState) { lastState = state; Write("desktop " + state); }
            }
            catch { }
            Thread.Sleep(${WATCH_INTERVAL_MS});
        }
    }
}
`;

const SCREEN_HOST_SOURCE = [
  'using System;',
  'using System.Collections.Generic;',
  'using System.Diagnostics;',
  'using System.Globalization;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'using System.Threading;',
  MIXDOG_INPUT_TRANSPORT_CSHARP,
  SCREEN_HOST_CSHARP.trim(),
].join('\n');

/** The bootstrap: load the cached assembly of this build, else compile and
 *  publish it, then serve. The here-string holds no `'@` line. */
export function screenInputHostProgram(): string {
  if (/^'@/mu.test(SCREEN_HOST_SOURCE)) throw new Error('screen host source cannot be embedded');
  return `$ErrorActionPreference = 'Stop'
$source = @'
${SCREEN_HOST_SOURCE}
'@
$refs = @('System.dll', 'System.Core.dll')
$assembly = [string]$env:MIXDOG_SCREEN_HOST_ASSEMBLY
$loaded = $false
if ($assembly -and (Test-Path -LiteralPath $assembly)) {
    try { Add-Type -Path $assembly; $loaded = $true } catch { $loaded = $false }
}
if (-not $loaded -and $assembly) {
    try {
        $staging = $assembly + '.' + [string]$PID + '.tmp'
        Add-Type -ReferencedAssemblies $refs -TypeDefinition $source -OutputAssembly $staging
        Move-Item -LiteralPath $staging -Destination $assembly -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $assembly) { Add-Type -Path $assembly; $loaded = $true }
    } catch { $loaded = $false }
}
if (-not $loaded) { Add-Type -ReferencedAssemblies $refs -TypeDefinition $source }
[MixdogScreenHost]::Serve($env:MIXDOG_SCREEN_INPUT_MARKER)
`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type ScreenHostButton = 'left' | 'right' | 'middle';

export type ScreenHostCommand =
  | { op: 'move'; x: number; y: number }
  | { op: 'button'; button: ScreenHostButton; down: boolean; at?: { x: number; y: number } }
  | { op: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { op: 'key'; vk: number; scan: number; extended: boolean; down: boolean }
  | { op: 'text'; text: string }
  | { op: 'cursor' };

const BUTTON_CODES: Record<ScreenHostButton, string> = { left: 'l', right: 'r', middle: 'm' };

const int = (value: number): string => {
  if (!Number.isSafeInteger(value)) throw new TypeError('screen host command needs integers');
  return String(value);
};

export function formatScreenHostCommand(id: number, command: ScreenHostCommand): string {
  switch (command.op) {
    case 'move':
      return `m ${id} ${int(command.x)} ${int(command.y)}`;
    case 'button': {
      const head = `b ${id} ${BUTTON_CODES[command.button]} ${command.down ? 1 : 0}`;
      return command.at ? `${head} ${int(command.at.x)} ${int(command.at.y)}` : head;
    }
    case 'wheel':
      return `w ${id} ${int(command.x)} ${int(command.y)} ${int(command.dx)} ${int(command.dy)}`;
    case 'key':
      return `k ${id} ${int(command.vk)} ${int(command.scan)} ${command.extended ? 1 : 0} ${command.down ? 1 : 0}`;
    case 'text':
      return `t ${id} ${Buffer.from(command.text, 'utf8').toString('base64')}`;
    case 'cursor':
      return `c ${id}`;
  }
}

/** The local desktop as the watcher sees it. `inputDesktop` is null when the
 *  input desktop cannot be opened (the secure desktop). */
export interface ScreenLocalDesktop {
  inputDesktop: string | null;
  consent: boolean;
  logonUi: boolean;
}

export function parseScreenDesktopLine(rest: string): ScreenLocalDesktop | null {
  const match = /^(\S+) ([01]) ([01])$/u.exec(rest);
  if (!match) return null;
  return { inputDesktop: match[1] === '-' ? null : match[1], consent: match[2] === '1', logonUi: match[3] === '1' };
}

/** Where a command through this host lands now: its session and the input
 *  desktop's object name, lower-cased. Null while either is unknown or the
 *  input desktop is unreadable (the secure desktop is up). */
export function screenHostIdentity(host: ScreenInputHost): ScreenDesktopIdentity | null {
  const session = host.session();
  const name = host.desktop()?.inputDesktop;
  return session === null || !name ? null : { session, desktop: name.toLowerCase() };
}

export class ScreenHostError extends Error {
  constructor(readonly code: string) {
    super(`remote screen input ${code}`);
  }
}

export interface ScreenInputHost {
  /** Resolves once the process serves (first start compiles, later starts load the cache). */
  start(): Promise<void>;
  /** Resolves with the `ok` fields; rejects with ScreenHostError. */
  command(command: ScreenHostCommand): Promise<string[]>;
  alive(): boolean;
  desktop(): ScreenLocalDesktop | null;
  /** The Windows session the process runs in (reported at `ready`). */
  session(): number | null;
  onDesktop(listener: (desktop: ScreenLocalDesktop) => void): () => void;
  /** An exit this side did not ask for (a crash, or a kill for a missed
   *  acknowledgment). */
  onExit(listener: () => void): () => void;
  /** Releases what the process holds, then ends it. */
  stop(): Promise<void>;
  /**
   * Ends the process at once, without its release-on-quit. Windows does not
   * lift input a killed process injected: a key or button it pressed stays
   * down until a matching up is injected (or the user presses it again). The
   * session drops those releases and logs their count.
   */
  kill(): void;
}

interface ScreenInputHostOptions {
  /** Where the bootstrap script and the compiled assembly live. */
  directory: string;
  spawn: typeof spawnType;
  /** dwExtraInfo of every injected event: distinct from Computer Use's, so
   *  its takeover guard reads phone input as a person's. */
  marker?: number;
  /** Acknowledgment deadline per command. Default: Computer Use's per-command
   *  ceiling for the same PowerShell host round trip through the same
   *  `MixNativeInput` transport (`COMMAND_TIMEOUT_MS`). */
  commandTimeoutMs?: number;
}

/** The compiled-assembly cache, a subdirectory of the host directory. */
export const SCREEN_HOST_CACHE_DIRECTORY = 'remote-screen-cache';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* held by a live host, or removed concurrently */
  }
}

/**
 * Sweeps what crashed hosts left: a per-process script whose process is gone,
 * an assembly of another build, and a compile staging file whose PowerShell
 * is gone. Files of live processes and of this build are kept.
 */
export function sweepScreenHostFiles(directory: string, build: string, alive: (pid: number) => boolean = processAlive): void {
  const list = (folder: string): string[] => {
    try {
      return readdirSync(folder);
    } catch {
      return [];
    }
  };
  for (const name of list(directory)) {
    const script = /^remote-screen-host-(\d+)-[0-9a-f]+\.ps1$/u.exec(name);
    if (script && !alive(Number(script[1]))) removeQuietly(join(directory, name));
  }
  const cache = join(directory, SCREEN_HOST_CACHE_DIRECTORY);
  for (const name of list(cache)) {
    const assembly = /^remote-screen-host-([0-9a-f]{16})\.dll$/u.exec(name);
    if (assembly && assembly[1] !== build) removeQuietly(join(cache, name));
    const staging = /^remote-screen-host-[0-9a-f]{16}\.dll\.(\d+)\.tmp$/u.exec(name);
    if (staging && !alive(Number(staging[1]))) removeQuietly(join(cache, name));
  }
}

/**
 * Publishes this process's bootstrap script (unique per host, removed when the
 * host exits) and names the per-build assembly. `directory` must be an
 * owner-only app-data folder (the agent host uses the same model): the
 * assembly there is loaded without further checks, so a folder writable by
 * another account would let it plant code into the injector.
 */
function publishProgram(directory: string): { script: string; assembly: string } {
  const program = screenInputHostProgram();
  const build = createHash('sha256').update(program).digest('hex').slice(0, 16);
  mkdirSync(join(directory, SCREEN_HOST_CACHE_DIRECTORY), { recursive: true });
  sweepScreenHostFiles(directory, build);
  const script = join(directory, `remote-screen-host-${process.pid}-${randomBytes(12).toString('hex')}.ps1`);
  writeFileSync(script, program, { mode: 0o600 });
  return { script, assembly: join(directory, SCREEN_HOST_CACHE_DIRECTORY, `remote-screen-host-${build}.dll`) };
}

export function createScreenInputHost(options: ScreenInputHostOptions): ScreenInputHost {
  const marker = options.marker ?? (Math.floor(Math.random() * 0x7ffffffe) + 1);
  let child: ChildProcessWithoutNullStreams | null = null;
  let starting: Promise<void> | null = null;
  let stopping = false;
  let nextId = 1;
  let current: ScreenLocalDesktop | null = null;
  let session: number | null = null;
  const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const pending = new Map<
    number,
    { resolve(fields: string[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  const desktopListeners = new Set<(desktop: ScreenLocalDesktop) => void>();
  const exitListeners = new Set<() => void>();

  const failPending = (code: string) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new ScreenHostError(code));
    }
    pending.clear();
  };

  const start = (): Promise<void> => {
    if (starting) return starting;
    stopping = false;
    starting = new Promise<void>((resolve, reject) => {
      const { script, assembly } = publishProgram(options.directory);
      const process_ = options.spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        {
          windowsHide: true,
          env: {
            ...process.env,
            MIXDOG_SCREEN_INPUT_MARKER: String(marker),
            MIXDOG_SCREEN_HOST_ASSEMBLY: assembly,
          },
        }
      ) as ChildProcessWithoutNullStreams;
      child = process_;
      let ready = false;
      const timer = setTimeout(() => {
        if (ready) return;
        reject(new ScreenHostError('start_timeout'));
        process_.kill();
      }, START_TIMEOUT_MS);
      timer.unref?.();
      const receive = createComputerLineDecoder((line: string) => {
        const readyLine = /^ready(?: (\d+))?$/u.exec(line);
        if (readyLine) {
          session = readyLine[1] === undefined ? null : Number(readyLine[1]);
          ready = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        if (line.startsWith('desktop ')) {
          const desktop = parseScreenDesktopLine(line.slice('desktop '.length));
          if (!desktop) return;
          current = desktop;
          for (const listener of desktopListeners) listener(desktop);
          return;
        }
        const reply = /^(ok|err) (\d+)(?: (.*))?$/u.exec(line);
        if (!reply) return;
        const entry = pending.get(Number(reply[2]));
        if (!entry) return;
        pending.delete(Number(reply[2]));
        clearTimeout(entry.timer);
        if (reply[1] === 'ok') entry.resolve(reply[3] ? reply[3].split(' ') : []);
        else entry.reject(new ScreenHostError(reply[3] || 'input_failed'));
      }, MAX_LINE_BYTES);
      process_.stdout.setEncoding('utf8');
      process_.stdout.on('data', (chunk: string) => {
        try {
          receive(chunk);
        } catch {
          process_.kill();
        }
      });
      process_.stderr.on('data', () => {
        /* compile and runtime errors surface as a missing `ready` or `err` lines */
      });
      process_.stdin.on('error', () => {
        /* the exit below settles everything */
      });
      process_.once('error', () => {
        clearTimeout(timer);
        if (!ready) reject(new ScreenHostError('start_failed'));
      });
      process_.once('exit', () => {
        clearTimeout(timer);
        removeQuietly(script);
        if (child === process_) child = null;
        starting = null;
        current = null;
        session = null;
        failPending('host_exited');
        if (!ready) {
          reject(new ScreenHostError('start_failed'));
          return;
        }
        if (!stopping) for (const listener of exitListeners) listener();
      });
    });
    starting.catch(() => {
      starting = null;
    });
    return starting;
  };

  const command = (value: ScreenHostCommand): Promise<string[]> => {
    const process_ = child;
    if (!process_ || stopping || !process_.stdin.writable) return Promise.reject(new ScreenHostError('host_unavailable'));
    const id = nextId++;
    const line = formatScreenHostCommand(id, value);
    return new Promise<string[]>((resolve, reject) => {
      // A helper that misses an acknowledgment is retired: whatever it does
      // later would be unordered against the releases that follow. Killing it
      // fails every pending command and fires `onExit`.
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new ScreenHostError('host_unresponsive'));
        process_.kill();
      }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      process_.stdin.write(`${line}\n`);
    });
  };

  const kill = (): void => {
    const process_ = child;
    if (!process_) return;
    failPending('host_killed');
    process_.kill();
  };

  const stop = async (): Promise<void> => {
    const process_ = child;
    stopping = true;
    if (!process_) return;
    const exited = new Promise<void>((resolve) => process_.once('exit', () => resolve()));
    try {
      process_.stdin.write('q\n');
      process_.stdin.end();
    } catch {
      /* already closed: end of stdin releases the same way */
    }
    const timer = setTimeout(() => process_.kill(), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  };

  return {
    start,
    command,
    alive: () => child !== null && !stopping,
    desktop: () => current,
    session: () => session,
    onDesktop(listener) {
      desktopListeners.add(listener);
      return () => desktopListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    stop,
    kill,
  };
}