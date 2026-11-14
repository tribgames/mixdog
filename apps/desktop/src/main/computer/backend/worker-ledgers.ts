/**
 * The inactive-window ledgers of the pool's workers. WS_EX_NOACTIVATE bits a
 * worker added to other windows are journaled in a per-worker ledger so they
 * can be cleared however the worker ends.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { computerNativeBinary, computerNativeEnvironment } from './native-host';
import { createInactiveLedgerRegistry } from './inactive-ledger-registry';

/** `inputMarker` is the pool's: its helpers never hold input (the desktop's
 *  Windows helper is read_only), so the recovery's release lifts nothing. */
export function createWorkerLedgers(
  dataDirectory: () => string,
  inputMarker?: string,
  spawnProcess: typeof spawn = spawn
) {
  const registry = createInactiveLedgerRegistry();
  const ledgerByWorker = new Map<ChildProcessWithoutNullStreams, string>();

  function newPath(): string {
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true });
    return join(directory, `computer-inactive-${randomBytes(12).toString('hex')}.ledger`);
  }

  /** The worker is gone: clear what it left behind, then forget the ledger. */
  function recover(path: string): void {
    registry.exited(path);
    if (!existsSync(path)) {
      registry.forget(path);
      return;
    }
    let recovery: ChildProcessWithoutNullStreams | ReturnType<typeof spawn>;
    try {
      // mixdog-computer's --abort-cleanup undoes the ledgers it is named (MIXDOG_ABORT_LEDGERS).
      recovery = spawnProcess(computerNativeBinary(), ['--abort-cleanup'], {
        windowsHide: true,
        stdio: 'ignore',
        env: computerNativeEnvironment(inputMarker, { MIXDOG_ABORT_LEDGERS: path }),
      });
    } catch {
      return; // the ledger stays pending for the abort cleanup
    }
    recovery.once('error', () => {
      /* the ledger stays pending for the abort cleanup */
    });
    recovery.once('exit', (code) => {
      if (code === 0) registry.forget(path);
    });
  }

  return {
    registry,
    newPath,
    recover,
    /** The resident worker that journals into `path`. */
    assign(child: ChildProcessWithoutNullStreams, path: string): void {
      ledgerByWorker.set(child, path);
    },
    /** A resident worker exited: recover the ledger it journaled into, if any. */
    workerExited(child: ChildProcessWithoutNullStreams): void {
      const path = ledgerByWorker.get(child);
      if (path) {
        ledgerByWorker.delete(child);
        recover(path);
      }
    },
  };
}

export type WorkerLedgers = ReturnType<typeof createWorkerLedgers>;
