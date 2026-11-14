/**
 * The resident Windows helper process of a screen session: `mixdog-computer
 * --screen-input` (native/mixdog-computer/src/screen_input.rs), which injects
 * desktop input through Computer Use's own checked SendInput transport and
 * ownership receipt, and watches which desktop takes input and whether an
 * elevation prompt or the sign-in screen is up. No PowerShell or C# source is
 * involved.
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

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { computerNativeBinary, computerNativeEnvironment } from '../computer/backend/native-host';
import { COMMAND_TIMEOUT_MS } from '../computer/backend/worker-requests';
import type { ScreenDesktopIdentity } from './screen-input-router';
import { createComputerLineDecoder } from '../../shared/core-src/runtime/computer-bridge/limits.mjs';

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 4_000;
const ABORT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 64 * 1024;

/** The helper's mode for the remote screen's input. */
export const SCREEN_INPUT_MODE = '--screen-input';

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
  /** Resolves once the process serves. */
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
   * session drops those releases and logs their count. A killed helper is
   * followed by mixdog-computer --abort-cleanup with its marker; the returned
   * promise settles once every such cleanup has (bounded, never rejects).
   */
  kill(): Promise<void>;
}

interface ScreenInputHostOptions {
  spawn: typeof spawnType;
  /** The mixdog-computer executable; default MIXDOG_COMPUTER_BIN (`computerNativeBinary`). */
  binary?: () => string;
  /** dwExtraInfo of every injected event: distinct from Computer Use's, so
   *  its takeover guard reads phone input as a person's. */
  marker?: number;
  /** Acknowledgment deadline per command. Default: Computer Use's per-command
   *  ceiling (`COMMAND_TIMEOUT_MS`). */
  commandTimeoutMs?: number;
  /** The app-data folder the retired PowerShell host kept its scripts and DLL cache in;
   *  swept once at the first start (nothing uses them any more). */
  legacyDirectory?: string;
  /** Bound for one abort cleanup. Default 5 s. */
  abortCleanupTimeoutMs?: number;
}

/** Removes what the retired PowerShell host left: its per-process scripts and compiled-assembly cache. */
export function sweepLegacyScreenHostFiles(directory: string): void {
  try {
    for (const name of readdirSync(directory)) {
      if (/^remote-screen-host-\d+-[0-9a-f]+\.ps1$/u.test(name)) rmSync(join(directory, name), { force: true });
    }
  } catch {
    /* absent or held: nothing to sweep */
  }
  try {
    rmSync(join(directory, 'remote-screen-cache'), { recursive: true, force: true });
  } catch {
    /* held by something else */
  }
}

export function createScreenInputHost(options: ScreenInputHostOptions): ScreenInputHost {
  const marker = options.marker ?? Math.floor(Math.random() * 0x7ffffffe) + 1;
  let child: ChildProcessWithoutNullStreams | null = null;
  let starting: Promise<void> | null = null;
  let stopping = false;
  let nextId = 1;
  let current: ScreenLocalDesktop | null = null;
  let session: number | null = null;
  let swept = false;
  const exited = new WeakSet<object>();
  const retired = new WeakSet<object>();
  const cleanups = new Set<Promise<void>>();
  const cleanupTimeoutMs = options.abortCleanupTimeoutMs ?? ABORT_CLEANUP_TIMEOUT_MS;
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

  /** mixdog-computer --abort-cleanup with this host's marker: lifts the keys and buttons a
   *  killed helper left down (the ownership receipt outlives it). Bounded; never rejects. */
  const abortCleanup = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false;
      let cleaner: ReturnType<typeof spawnType> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          cleaner?.kill();
        } catch {
          /* already gone */
        }
        finish();
      }, cleanupTimeoutMs);
      timer.unref?.();
      try {
        cleaner = options.spawn((options.binary ?? computerNativeBinary)(), ['--abort-cleanup'], {
          windowsHide: true,
          stdio: 'ignore',
          env: computerNativeEnvironment(String(marker)),
        });
        cleaner.once('error', finish);
        cleaner.once('exit', finish);
      } catch {
        finish();
      }
    });

  /** Kills the helper, and once it is gone runs the abort cleanup for what it held. */
  const retire = (process_: ChildProcessWithoutNullStreams): void => {
    try {
      process_.kill();
    } catch {
      /* already gone */
    }
    // One cleanup per helper: a second kill (the stop deadline after a missed
    // acknowledgment) shares the first one's.
    if (retired.has(process_)) return;
    retired.add(process_);
    const run = new Promise<void>((resolve) => {
      let done = false;
      const go = () => {
        if (done) return;
        done = true;
        clearTimeout(wait);
        void abortCleanup().then(resolve);
      };
      const wait = setTimeout(go, STOP_TIMEOUT_MS);
      wait.unref?.();
      if (exited.has(process_)) go();
      else process_.once('exit', go);
    });
    cleanups.add(run);
    void run.then(() => cleanups.delete(run));
  };

  const start = (): Promise<void> => {
    if (starting) return starting;
    stopping = false;
    if (!swept && options.legacyDirectory) {
      swept = true;
      sweepLegacyScreenHostFiles(options.legacyDirectory);
    }
    const launch = (): Promise<void> => new Promise<void>((resolve, reject) => {
      if (stopping) {
        reject(new ScreenHostError('start_failed'));
        return;
      }
      let binary: string;
      try {
        binary = (options.binary ?? computerNativeBinary)();
      } catch {
        reject(new ScreenHostError('start_failed'));
        return;
      }
      const process_ = options.spawn(binary, [SCREEN_INPUT_MODE], {
        windowsHide: true,
        env: { ...process.env, MIXDOG_SCREEN_INPUT_MARKER: String(marker) },
      }) as ChildProcessWithoutNullStreams;
      child = process_;
      let ready = false;
      // The helper says `released` once it let go of what it held on `q` or end of stdin.
      let released = false;
      const timer = setTimeout(() => {
        if (ready) return;
        reject(new ScreenHostError('start_timeout'));
        retire(process_);
      }, START_TIMEOUT_MS);
      timer.unref?.();
      const receive = createComputerLineDecoder((line: string) => {
        if (line === 'released') {
          released = true;
          return;
        }
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
          retire(process_);
        }
      });
      process_.stderr.on('data', () => {
        /* start and runtime errors surface as a missing `ready` or `err` lines */
      });
      process_.stdin.on('error', () => {
        /* the exit below settles everything */
      });
      process_.once('error', () => {
        clearTimeout(timer);
        if (!ready) reject(new ScreenHostError('start_failed'));
      });
      process_.once('exit', () => {
        exited.add(process_);
        clearTimeout(timer);
        if (child === process_) child = null;
        starting = null;
        current = null;
        session = null;
        failPending('host_exited');
        if (!ready) {
          reject(new ScreenHostError('start_failed'));
          return;
        }
        // Gone without saying it released (a crash, or killed from outside): the
        // abort cleanup lifts what it held, as after a kill.
        if (!released && !retired.has(process_)) retire(process_);
        if (!stopping) for (const listener of exitListeners) listener();
      });
    });
    // A new helper runs under the same marker and receipt: the cleanups of the
    // one before it finish first, so they cannot lift what the new one holds.
    starting = cleanups.size ? Promise.all([...cleanups]).then(launch) : launch();
    starting.catch(() => {
      starting = null;
    });
    return starting;
  };

  const command = (value: ScreenHostCommand): Promise<string[]> => {
    const process_ = child;
    if (!process_ || stopping || !process_.stdin.writable)
      return Promise.reject(new ScreenHostError('host_unavailable'));
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
        retire(process_);
      }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      process_.stdin.write(`${line}\n`);
    });
  };

  const kill = (): Promise<void> => {
    const process_ = child;
    if (process_) {
      failPending('host_killed');
      retire(process_);
    }
    return Promise.all([...cleanups]).then(() => undefined);
  };

  const stop = async (): Promise<void> => {
    const process_ = child;
    stopping = true;
    if (!process_) {
      await Promise.all([...cleanups]);
      return;
    }
    const gone = new Promise<void>((resolve) => process_.once('exit', () => resolve()));
    try {
      process_.stdin.write('q\n');
      process_.stdin.end();
    } catch {
      /* already closed: end of stdin releases the same way */
    }
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      retire(process_);
    }, STOP_TIMEOUT_MS);
    // A helper that never reports its exit does not hold the stop: its cleanup
    // still runs once retire's own wait ends.
    let bounded: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      gone,
      new Promise<void>((resolve) => {
        bounded = setTimeout(resolve, STOP_TIMEOUT_MS * 2);
        bounded.unref?.();
      }),
    ]);
    clearTimeout(bounded);
    clearTimeout(timer);
    if (forced || cleanups.size) await Promise.all([...cleanups]);
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
