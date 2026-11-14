/**
 * One resident worker process: how it is launched on each platform, and how
 * its streams and lifecycle events are routed back to the pool.
 */
import type { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

import { HOST_ASSEMBLY_CACHE_DIRECTORY, type createHostScriptPublisher } from './host-script';
import { FOREGROUND_LOCK_LINE_PREFIX } from './foreground-lock-host';
import { RESPONSE_MARKER } from './program';
import { computerNativeBinary, computerNativeEnvironment } from './native-host';
import type { WorkerLedgers } from './worker-ledgers';
import { createComputerLineDecoder } from '../../../shared/core-src/runtime/computer-bridge/limits.mjs';

const POINTER_LINE_PREFIX = '@@MIXDOG_POINTER@@';

/** Which program a Windows worker runs: the native `mixdog-computer` helper
 *  (the default) or the PowerShell host program, kept as the rollback path. */
export type WindowsWorker = 'helper' | 'powershell';

/** The rollback switch: MIXDOG_COMPUTER_WINDOWS_WORKER=powershell selects the
 *  PowerShell host; anything else is the helper. No setting carries it. */
export function windowsWorkerFromEnvironment(env: NodeJS.ProcessEnv = process.env): WindowsWorker {
  return env.MIXDOG_COMPUTER_WINDOWS_WORKER?.trim().toLowerCase() === 'powershell' ? 'powershell' : 'helper';
}

/** Every platform runs the native `mixdog-computer` backend, which speaks the
 *  host's line protocol. On Windows it also journals the windows it holds
 *  inactive into its own ledger and leases the foreground lock from the bridge
 *  host (MixForegroundLockHost, MixWin32InactiveLedger in the PowerShell host).
 *  With `windowsWorker: 'powershell'` a Windows worker is that PowerShell host
 *  program instead, run from the published script. */
export function launchHostProcess(options: {
  dataDirectory: () => string;
  hostScript: ReturnType<typeof createHostScriptPublisher>;
  windowsWorker: WindowsWorker;
  ledgers: WorkerLedgers;
  inputMarker: string;
  nativeEnvironment: () => Record<string, string> | undefined;
  spawnProcess: typeof spawn;
  /** The bridge host leases the foreground lock to a worker that asks. */
  hostForegroundLock: boolean;
}): ChildProcessWithoutNullStreams {
  const { dataDirectory, hostScript, ledgers, inputMarker, spawnProcess } = options;
  const windows = process.platform === 'win32';
  const ledgerPath = windows ? ledgers.newPath() : null;
  if (ledgerPath && options.windowsWorker === 'powershell') {
    // The program runs from a temp .ps1 via -File, NOT piped through -Command -:
    // with -Command - PowerShell consumes stdin as the command text, colliding
    // with the per-command JSON we also write to stdin. -File leaves stdin
    // dedicated to runtime commands.
    const scriptPath = hostScript.ensure();
    const powershell = spawnProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        windowsHide: true,
        env: {
          ...process.env,
          MIXDOG_COMPUTER_HOST_CACHE: join(dataDirectory(), HOST_ASSEMBLY_CACHE_DIRECTORY),
          MIXDOG_COMPUTER_HOST_BUILD: hostScript.build(),
          MIXDOG_COMPUTER_INPUT_MARKER: inputMarker,
          MIXDOG_COMPUTER_INACTIVE_LEDGER: ledgerPath,
          MIXDOG_COMPUTER_HOST_FOREGROUND_LOCK: options.hostForegroundLock ? '1' : '',
        },
      }
    );
    ledgers.assign(powershell, ledgerPath);
    return powershell;
  }
  const child = spawnProcess(computerNativeBinary(), [], {
    windowsHide: true,
    env: computerNativeEnvironment(inputMarker, {
      ...options.nativeEnvironment(),
      ...(ledgerPath ? { MIXDOG_COMPUTER_INACTIVE_LEDGER: ledgerPath } : {}),
      ...(windows && options.hostForegroundLock ? { MIXDOG_COMPUTER_HOST_FOREGROUND_LOCK: '1' } : {}),
    }),
  });
  if (ledgerPath) ledgers.assign(child, ledgerPath);
  return child;
}

/** Routes a worker's output lines and lifecycle events. Every failure ends in
 *  `retire` with the error that names it; `unstarted` and `exited` run first. */
export function watchHostWorker(
  child: ChildProcessWithoutNullStreams,
  events: {
    pointerProgress(payload: string): void;
    /** A request for the bridge host's foreground lock (foreground-lock-host.ts). */
    foregroundLock(payload: string): void;
    reply(json: string): void;
    retire(error: Error): void;
    unstarted(): void;
    exited(): void;
  }
): void {
  const receive = createComputerLineDecoder((line) => {
    if (line.startsWith(POINTER_LINE_PREFIX)) {
      events.pointerProgress(line.slice(POINTER_LINE_PREFIX.length));
      return;
    }
    if (line.startsWith(FOREGROUND_LOCK_LINE_PREFIX)) {
      events.foregroundLock(line.slice(FOREGROUND_LOCK_LINE_PREFIX.length));
      return;
    }
    const marker = line.indexOf(RESPONSE_MARKER);
    if (marker >= 0) events.reply(line.slice(marker + RESPONSE_MARKER.length));
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    try {
      receive(chunk);
    } catch (error) {
      events.retire(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.stderr.on('data', () => {
    /* diagnostics ignored; errors ride responses */
  });
  child.stdin.once('error', (error) => {
    events.retire(new Error(`computer host input channel failed: ${error.message}`));
  });
  child.once('error', (error) => {
    if (!child.pid) events.unstarted();
    events.retire(new Error(`computer host failed to start: ${error.message}`));
  });
  child.once('exit', () => {
    events.exited();
    events.retire(new Error('computer host exited'));
  });
}
