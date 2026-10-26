/**
 * Client of Mixdog's GNOME Shell extension (io.mixdog.Windows on org.gnome.Shell):
 * pixels for GNOME Wayland, where Electron's desktopCapturer can only go through
 * the ScreenCast portal and would show its "Share Screen" prompt on every
 * capture, and the Ctrl+Alt+Esc emergency Stop, which Electron cannot register
 * as a global shortcut on Wayland. Nothing here ever prompts.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path/posix';

import { detectDesktop, detectSession } from '../../../../../../src/runtime/computer-bridge/linux-readiness.mjs';

const DESTINATION = 'org.gnome.Shell';
const OBJECT_PATH = '/io/mixdog/Windows';
const INTERFACE = 'io.mixdog.Windows';
const STOP_SIGNAL = `${INTERFACE}.StopRequested`;
/** gdbus `--timeout` for one call to the Shell extension; the process gets 5 s more. */
const CALL_TIMEOUT_SECONDS = 10;
/** Backoff between restarts of the stop-signal monitor, capped at the last step. */
const RESTART_DELAYS_MS = [1000, 3000, 10000, 30000];

/** Pixels the extension can take: the whole stage, one area of it, or one window by its shell id. */
export type GnomeShotTarget =
  | { kind: 'stage' }
  | { kind: 'area'; x: number; y: number; width: number; height: number }
  | { kind: 'window'; id: bigint };

export interface GnomeShotDeps {
  /** Resolves stdout; rejects when the command fails. */
  run(args: string[]): Promise<string>;
  runtimeDir: string | undefined;
  newId(): string;
  read(path: string): Buffer;
  remove(path: string): void;
}

const realShotDeps: GnomeShotDeps = {
  run: (args) =>
    new Promise((resolve, reject) => {
      execFile(
        'gdbus',
        args,
        { timeout: (CALL_TIMEOUT_SECONDS + 5) * 1000, windowsHide: true },
        (error, stdout, stderr) =>
          error
            ? reject(
                new Error(
                  String(stderr || error.message)
                    .trim()
                    .split('\n')[0]
                )
              )
            : resolve(String(stdout))
      );
    }),
  get runtimeDir() {
    return process.env.XDG_RUNTIME_DIR;
  },
  newId: randomUUID,
  read: (path) => readFileSync(path),
  remove: (path) => rmSync(path, { force: true }),
};

/** GNOME Wayland is the one session whose pixels and Stop chord go through the extension. */
export function usesGnomeHelper(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'linux') return false;
  const session = detectSession(env);
  return session === 'wayland' && detectDesktop(env, session) === 'gnome';
}

const GNOME_SHELL_SOURCE_PREFIX = 'gnome-shell:';

export type GnomeShellSource = { kind: 'screen'; displayId: string } | { kind: 'window'; handle: bigint };

export function gnomeShellSourceId(source: GnomeShellSource): string {
  return source.kind === 'screen'
    ? `${GNOME_SHELL_SOURCE_PREFIX}screen:${source.displayId}`
    : `${GNOME_SHELL_SOURCE_PREFIX}window:${source.handle}`;
}

export function parseGnomeShellSourceId(sourceId: string): GnomeShellSource | null {
  const match = /^gnome-shell:(screen|window):(.*)$/.exec(sourceId);
  if (!match) return null;
  if (match[1] === 'screen') return { kind: 'screen', displayId: match[2] };
  return /^\d+$/.test(match[2]) ? { kind: 'window', handle: BigInt(match[2]) } : null;
}

/** The shell's window id behind a native `hwnd:0x…` id (the platform handle itself on Linux). */
export function gnomeWindowHandle(windowId: string): bigint | null {
  const raw = windowId.replace(/^hwnd:/i, '').replace(/^0x/i, '');
  return /^[0-9a-f]+$/i.test(raw) ? BigInt(`0x${raw}`) : null;
}

function screenshotArgs(target: GnomeShotTarget, path: string): string[] {
  const { x, y, width, height } = target.kind === 'area' ? target : { x: 0, y: 0, width: 0, height: 0 };
  const id = target.kind === 'window' ? target.id : 0n;
  return [
    'call',
    '--session',
    '--timeout',
    String(CALL_TIMEOUT_SECONDS),
    '--dest',
    DESTINATION,
    '--object-path',
    OBJECT_PATH,
    '--method',
    `${INTERFACE}.Screenshot`,
    // "--" so a negative coordinate (a monitor left of the primary) is a value, not an option.
    '--',
    `'${target.kind}'`,
    String(id),
    String(Math.round(x)),
    String(Math.round(y)),
    String(Math.round(width)),
    String(Math.round(height)),
    `'${path}'`,
  ];
}

/**
 * The PNG bytes of `target`, taken inside the shell process. The file lives
 * under XDG_RUNTIME_DIR (user-private) just long enough to be read back.
 */
export async function gnomeShellScreenshot(
  target: GnomeShotTarget,
  deps: GnomeShotDeps = realShotDeps
): Promise<Buffer> {
  if (!deps.runtimeDir) throw new Error('XDG_RUNTIME_DIR is not set');
  const path = join(deps.runtimeDir, `mixdog-shot-${deps.newId()}.png`);
  try {
    await deps.run(screenshotArgs(target, path));
    return deps.read(path);
  } finally {
    deps.remove(path);
  }
}

/** What the shell extension draws as the "Computer in use" pill. */
export interface GnomeIndicatorSpec {
  visible: boolean;
  title?: string;
  /** The Stop hint beside the title. */
  hint?: string;
  accent?: string;
  paused?: boolean;
  attention?: boolean;
}

/** A GVariant text-format string literal (what gdbus parses its arguments as). */
export function gvariantString(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Shows, updates or hides the pill; the extension drops it again unless it is refreshed. */
export async function gnomeSetIndicator(
  spec: GnomeIndicatorSpec,
  run: (args: string[]) => Promise<string> = realShotDeps.run
): Promise<void> {
  await run([
    'call',
    '--session',
    '--timeout',
    '5',
    '--dest',
    DESTINATION,
    '--object-path',
    OBJECT_PATH,
    '--method',
    `${INTERFACE}.SetIndicator`,
    '--',
    gvariantString(JSON.stringify(spec)),
  ]);
}

/** True for a line of `gdbus monitor` output that reports the Stop signal. */
export function isStopSignalLine(line: string): boolean {
  return line.includes(STOP_SIGNAL);
}

export interface StopWatchDeps {
  spawnMonitor(): {
    stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
    on(event: 'exit' | 'error', listener: () => void): unknown;
    kill(): unknown;
  };
  setTimer(callback: () => void, ms: number): { unref?(): unknown } | number;
  clearTimer(timer: unknown): void;
}

const realWatchDeps: StopWatchDeps = {
  spawnMonitor: () =>
    spawn('gdbus', ['monitor', '--session', '--dest', DESTINATION, '--object-path', OBJECT_PATH], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

/**
 * Calls `onStop` whenever the extension reports the Ctrl+Alt+Esc chord. The
 * monitor is restarted (with a growing delay) when the shell goes away, so a
 * shell restart or a late-loaded extension is picked up. Returns the stopper.
 */
export function watchGnomeStopSignal(onStop: () => void, deps: StopWatchDeps = realWatchDeps): () => void {
  let stopped = false;
  let child: ReturnType<StopWatchDeps['spawnMonitor']> | null = null;
  let timer: ReturnType<StopWatchDeps['setTimer']> | null = null;
  let failures = 0;

  const start = (): void => {
    timer = null;
    if (stopped) return;
    let pending = '';
    let delivered = false;
    const restart = (): void => {
      if (stopped || timer !== null) return;
      // A monitor that ran and spoke is healthy again; one that dies at once backs off.
      if (delivered) failures = 0;
      timer = deps.setTimer(start, RESTART_DELAYS_MS[Math.min(failures, RESTART_DELAYS_MS.length - 1)]);
      failures += 1;
    };
    try {
      child = deps.spawnMonitor();
    } catch {
      restart();
      return;
    }
    child.stdout.on('data', (chunk) => {
      delivered = true;
      pending += String(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (isStopSignalLine(line)) onStop();
    });
    child.on('exit', restart);
    child.on('error', restart);
  };

  start();
  return () => {
    stopped = true;
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    try {
      child?.kill();
    } catch {}
    child = null;
  };
}
