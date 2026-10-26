/**
 * The pool's side of the one-shot elevated path: the session jobs that block
 * new input while an elevated stop is unconfirmed, the capacity slots an
 * elevated run occupies, and the ledger it leaves behind.
 */
import type { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

import { runElevatedRequest } from './elevated-launcher';
import { createSessionJobs } from './session-jobs';
import type { ProcessIdentity } from './inactive-ledger-registry';
import { assertComputerWorkerCapacity } from './worker-capacity';
import type { WorkerLedgers } from './worker-ledgers';
import type { PowerShellResponse } from '../shared/types';

/** Capacity slots one elevated run holds until its stop is confirmed. */
const ELEVATED_RUN_SLOTS = 3;

/**
 * A finished elevated run recovers its ledger only when the worker is known to
 * have stopped; otherwise the ledger is held with the launcher's identity until
 * that process is verified gone.
 */
export function settleElevatedLedger(
  stopped: boolean,
  path: string,
  recover: (path: string) => void,
  hold: (path: string) => void
): void {
  if (stopped) recover(path);
  else hold(path);
}

export function createElevatedRequests(options: {
  dataDirectory: () => string;
  hostScriptPath: () => string | null;
  /** Publishes the session's resident worker before the elevated run. */
  ensureWorker: (sessionId: string) => void;
  liveWorkerCount: () => number;
  maxWorkers: number;
  ledgers: WorkerLedgers;
  inputMarker: string;
  spawnProcess: typeof spawn;
  nextId: () => number;
}) {
  const { dataDirectory, ledgers, maxWorkers } = options;
  const jobs = createSessionJobs();
  let slots = 0;

  async function call(request: Record<string, unknown>): Promise<PowerShellResponse> {
    const sessionId = String(request.session_id || 'default');
    options.ensureWorker(sessionId);
    const hostScriptPath = options.hostScriptPath();
    if (!hostScriptPath) throw new Error('privileged_worker_unavailable: computer host script is missing');
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true });
    assertComputerWorkerCapacity(options.liveWorkerCount() + slots + 2, maxWorkers);
    const inactiveLedger = ledgers.newPath();
    let launcher: ProcessIdentity | undefined;
    let stopped = false;
    const settle = () =>
      settleElevatedLedger(stopped, inactiveLedger, ledgers.recover, (path) => ledgers.registry.hold(path, launcher));
    return runElevatedRequest({
      request,
      id: options.nextId(),
      directory,
      hostScriptPath,
      inputMarker: options.inputMarker,
      inactiveLedger,
      spawnProcess: options.spawnProcess,
      onWorkerIdentity: (identity) => {
        launcher = identity;
      },
      begin: (cancel) => {
        const job = jobs.begin(sessionId, cancel);
        slots += ELEVATED_RUN_SLOTS;
        return {
          finish(confirmed) {
            stopped = confirmed;
            job.finish(confirmed);
            if (confirmed) slots -= ELEVATED_RUN_SLOTS;
          },
        };
      },
    }).finally(settle);
  }

  return {
    call,
    /** Capacity slots held by elevated runs not yet confirmed stopped. */
    slots: () => slots,
    assertClear: jobs.assertClear,
    cancel: jobs.cancel,
    sessionIds: jobs.sessionIds,
    /** User-acknowledged recovery only: releases unconfirmed elevated sessions
     *  and their slots, unless an elevated job is still pending. */
    async releaseUnconfirmed(): Promise<boolean> {
      // Only a verified-gone launcher releases its job; one still alive (or
      // unverifiable) keeps its ledger held and the sessions unconfirmed.
      if (!(await ledgers.registry.promoteGone())) return false;
      slots -= jobs.releaseUnconfirmed() * ELEVATED_RUN_SLOTS;
      return true;
    },
  };
}
