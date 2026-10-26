/**
 * One resident worker process: how it is launched on each platform, and how
 * its streams and lifecycle events are routed back to the pool.
 */
import type { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

import { HOST_ASSEMBLY_CACHE_DIRECTORY, type createHostScriptPublisher } from './host-script';
import { RESPONSE_MARKER } from './program';
import { computerNativeBinary, computerNativeEnvironment } from './native-host';
import type { WorkerLedgers } from './worker-ledgers';
import { createComputerLineDecoder } from '../../../../../../src/runtime/computer-bridge/limits.mjs';

const POINTER_LINE_PREFIX = '@@MIXDOG_POINTER@@';

/** Windows runs the PowerShell host program; macOS and Linux run the
 *  native backend, which speaks the same line protocol. */
export function launchHostProcess(options: {
  dataDirectory: () => string;
  hostScript: ReturnType<typeof createHostScriptPublisher>;
  ledgers: WorkerLedgers;
  inputMarker: string;
  nativeEnvironment: () => Record<string, string> | undefined;
  spawnProcess: typeof spawn;
}): ChildProcessWithoutNullStreams {
  const { dataDirectory, hostScript, ledgers, inputMarker, spawnProcess } = options;
  if (process.platform !== 'win32') {
    return spawnProcess(computerNativeBinary(), [], {
      env: computerNativeEnvironment(inputMarker, options.nativeEnvironment()),
    });
  }
  // The program runs from a temp .ps1 via -File, NOT piped through -Command -:
  // with -Command - PowerShell consumes stdin as the command text, colliding
  // with the per-command JSON we also write to stdin. -File leaves stdin
  // dedicated to runtime commands.
  const scriptPath = hostScript.ensure();
  const ledgerPath = ledgers.newPath();
  const child = spawnProcess(
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
      },
    }
  );
  ledgers.assign(child, ledgerPath);
  return child;
}

/** Routes a worker's output lines and lifecycle events. Every failure ends in
 *  `retire` with the error that names it; `unstarted` and `exited` run first. */
export function watchHostWorker(
  child: ChildProcessWithoutNullStreams,
  events: {
    pointerProgress(payload: string): void;
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
