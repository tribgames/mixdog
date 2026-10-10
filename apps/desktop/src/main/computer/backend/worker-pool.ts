/**
 * The resident PowerShell workers: publishing the host script, caching its
 * compiled types per build, keeping one worker warm, routing requests, and the
 * one-shot elevated path for targets a normal worker cannot reach. The pool
 * owns worker state; the host tells it whether the bridge is still wanted.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createHostScriptPublisher, HOST_ASSEMBLY_CACHE_DIRECTORY } from './host-script';
import { INACTIVE_LEDGER_RECOVERY_PROGRAM, RESPONSE_MARKER } from './program';
import { runElevatedRequest } from './elevated-launcher';
import { computerNativeBinary, computerNativeEnvironment } from './native-host';
import { createSessionJobs } from './session-jobs';
import { recordCursorDiagnostic } from '../overlay/cursor-diagnostics';
import { assertComputerWorkerCapacity, MAX_COMPUTER_WORKERS } from './worker-capacity';
import type { PowerShellResponse } from '../shared/types';
import { captureCleanup } from '../shared/capture-attempts';
import { computerActionHas } from '../../../../../../src/runtime/computer-bridge/actions.mjs';
import {
  createComputerLineDecoder,
  MAX_COMPUTER_INTERNAL_REQUEST_BYTES,
} from '../../../../../../src/runtime/computer-bridge/limits.mjs';

/** Per-command ceiling for the PowerShell host round trip. */
const COMMAND_TIMEOUT_MS = 45_000;

/** Actions whose worker streams pointer progress back while they run. */
const POINTER_FEEDBACK_ACTIONS = [
  'click',
  'invoke',
  'set_value',
  'toggle',
  'double_click',
  'right_click',
  'middle_click',
  'triple_click',
  'mouse_down',
  'mouse_up',
  'mouse_move',
  'drag',
  'scroll',
  'key',
  'key_down',
  'key_up',
  'type',
];

/** Progress phases a pointer event may claim; anything else is not a phase
 *  this build emits and is counted as invalid rather than reported. */
const POINTER_PROGRESS_PHASES = ['move', 'prepare', 'press', 'release', 'drag', 'scroll', 'type'];

/** One in-flight worker request, from dispatch to its reply, timeout or the
 *  retirement of the worker that owns it. */
interface PendingWorkerRequest {
  resolve: (r: PowerShellResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  child: ChildProcessWithoutNullStreams;
  sessionId: string;
  pointerFeedback: boolean;
  windowId?: string;
  mode: 'background' | 'foreground';
  input: boolean;
  backgroundPressRelease: boolean;
}

/** What one request is, as the pool has to treat it: whose session it belongs
 *  to, whether it can leave input held, and whether the host streams pointer
 *  progress for it. Derived from the request alone — a sequence step is read
 *  through its envelope, exactly as the host dispatches it. */
function classifyWorkerRequest(request: Record<string, unknown>): {
  sessionId: string;
  windowId?: string;
  mode: 'background' | 'foreground';
  input: boolean;
  backgroundPressRelease: boolean;
  pointerAction: boolean;
} {
  const step = request.step as Record<string, unknown> | undefined;
  const inputAction = request.action === 'sequence_step' ? step?.action : request.action;
  const target = request.action === 'sequence_step' ? step : request;
  return {
    sessionId: String(request.session_id || 'default'),
    windowId: typeof target?.window_id === 'string' ? target.window_id : undefined,
    mode: request.delivery === 'foreground' ? 'foreground' : 'background',
    input:
      !computerActionHas(String(inputAction), 'nativeRead') &&
      inputAction !== 'release_session' &&
      inputAction !== 'release_cursor_theme',
    backgroundPressRelease:
      computerActionHas(String(inputAction), 'backgroundPressRelease') ||
      (inputAction === 'type' &&
        ((target?.x != null && target?.y != null) || String(target?.text ?? '').includes('\n'))),
    pointerAction: POINTER_FEEDBACK_ACTIONS.includes(String(inputAction)),
  };
}

/** A pointer-progress line, reported only when it matches a request that asked
 *  for feedback and carries a phase and coordinates this build understands.
 *  Every rejection is counted, so a silent cursor has a reason on record. */
function reportPointerProgress(
  payload: string,
  requestOf: (id: unknown) => PendingWorkerRequest | undefined,
  onPointerProgress: WorkerPoolHost['onPointerProgress']
): void {
  recordCursorDiagnostic('received');
  try {
    const event = JSON.parse(payload);
    const entry = requestOf(event.id);
    if (
      entry?.pointerFeedback &&
      Number.isFinite(event.x) &&
      Number.isFinite(event.y) &&
      typeof event.held === 'boolean'
    ) {
      const phase = event.phase ?? (event.held ? 'drag' : 'move');
      if (POINTER_PROGRESS_PHASES.includes(phase)) {
        recordCursorDiagnostic('validated');
        onPointerProgress?.(entry.sessionId, event.x, event.y, event.held, entry.mode, phase, entry.windowId);
      } else recordCursorDiagnostic('invalid_phase');
    } else recordCursorDiagnostic('discarded_event');
  } catch {
    recordCursorDiagnostic('event_handler_failed');
  }
}

export interface WorkerPoolHost {
  /** Where the host script and its assembly cache belong. */
  dataDirectory(): string;
  /** A spare is only worth keeping while the bridge would use it. */
  isBridgeEnabled(): boolean;
  isDisposed(): boolean;
  onSessionRetired?(sessionId: string, child: ChildProcessWithoutNullStreams, interruptedInput: boolean): void;
  maxWorkers?: number;
  onPointerProgress?(
    sessionId: string,
    x: number,
    y: number,
    held: boolean,
    mode: 'background' | 'foreground',
    phase: string,
    windowId?: string
  ): void;
  /** Launch-time facts the native backend needs from the app (macOS/Linux). */
  nativeEnvironment?(): Record<string, string>;
  /** Injectable process transport for isolated lifecycle tests. */
  spawnProcess?: typeof spawn;
}

/**
 * A failed elevated run recovers its ledger only when the worker is known to be
 * stopped; an unconfirmed termination keeps the ledger pending for a later
 * confirmed exit or abort cleanup.
 */
export function settleElevatedLedgerFailure(
  error: unknown,
  path: string,
  recover: (path: string) => void,
  keepPending: (path: string) => void
): void {
  if (String((error as Error)?.message ?? error).includes('privileged_worker_cleanup_unconfirmed')) keepPending(path);
  else recover(path);
}

/**
 * Ledgers awaiting recovery. An `exited` ledger belongs to a worker confirmed
 * gone and may be recovered by any consumer; a ledger held for a session
 * belongs to a possibly-live worker and is listed only to that session's own
 * confirmed-abort cleanup.
 */
export function createInactiveLedgerRegistry() {
  const owners = new Map<string, string | null>();
  return {
    /** The owning worker is confirmed exited. */
    exited(path: string): void {
      owners.set(path, null);
    },
    /** The owning worker's termination is unconfirmed. */
    hold(path: string, sessionId: string): void {
      if (!owners.has(path)) owners.set(path, sessionId);
    },
    forget(path: string): void {
      owners.delete(path);
    },
    /** Recoverable now: exited ledgers, plus those held for `confirmedSessionId`. */
    recoverable(confirmedSessionId?: string): string[] {
      return [...owners]
        .filter(([path, owner]) => (owner === null || owner === confirmedSessionId) && existsSync(path))
        .map(([path]) => path);
    },
  };
}

export function createWorkerPool(host: WorkerPoolHost) {
  const { dataDirectory, onSessionRetired } = host;

  const hostScript = createHostScriptPublisher(dataDirectory);
  let nextId = 1;
  const pending = new Map<number, PendingWorkerRequest>();
  const powerShellBySession = new Map<string, ChildProcessWithoutNullStreams>();
  const workerLastUsedAt = new Map<string, number>();
  const hostWorkers = new Set<ChildProcessWithoutNullStreams>();
  // A killed message sender has no receipt proving that its finally block ran.
  // Keep this uncertainty latched even after the child and observation are gone.
  const unconfirmedBackgroundSessions = new Set<string>();
  const elevatedJobs = createSessionJobs();
  const maxWorkers = host.maxWorkers ?? MAX_COMPUTER_WORKERS;
  const spawnProcess = host.spawnProcess || spawn;
  assertComputerWorkerCapacity(0, maxWorkers);
  let elevatedSlots = 0;
  const inputMarker = String(randomBytes(4).readUInt32LE() & 0x7fffffff || 1);
  // WS_EX_NOACTIVATE bits a worker added to other windows are journaled in a
  // per-worker ledger so they can be cleared however the worker ends.
  const pendingInactiveLedgers = createInactiveLedgerRegistry();
  const ledgerByWorker = new Map<ChildProcessWithoutNullStreams, string>();

  function newInactiveLedgerPath(): string {
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true });
    return join(directory, `computer-inactive-${randomBytes(12).toString('hex')}.ledger`);
  }

  /** The worker is gone: clear what it left behind, then forget the ledger. */
  function recoverInactiveLedger(path: string): void {
    pendingInactiveLedgers.exited(path);
    if (!existsSync(path)) {
      pendingInactiveLedgers.forget(path);
      return;
    }
    const recovery = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', INACTIVE_LEDGER_RECOVERY_PROGRAM],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, MIXDOG_ABORT_LEDGERS: path } }
    );
    recovery.once('error', () => {
      /* the ledger stays pending for the abort cleanup */
    });
    recovery.once('exit', (code) => {
      if (code === 0) pendingInactiveLedgers.forget(path);
    });
  }

  /** An exited worker keeps its slot until its `exit` event arrives, and a
   * confirmed session release can outrun that event. Dead children are pruned
   * before the limit is judged so a finished session never blocks the next. */
  function liveWorkerCount(): number {
    for (const child of hostWorkers) {
      if (child.exitCode !== null || child.signalCode !== null) hostWorkers.delete(child);
    }
    return hostWorkers.size;
  }

  /** Windows runs the PowerShell host program; macOS and Linux run the
   *  native backend, which speaks the same line protocol. */
  function spawnHostProcess(): ChildProcessWithoutNullStreams {
    if (process.platform !== 'win32') {
      return spawnProcess(computerNativeBinary(), [], {
        env: computerNativeEnvironment(inputMarker, host.nativeEnvironment?.()),
      });
    }
    // The program runs from a temp .ps1 via -File, NOT piped through -Command -:
    // with -Command - PowerShell consumes stdin as the command text, colliding
    // with the per-command JSON we also write to stdin. -File leaves stdin
    // dedicated to runtime commands.
    const scriptPath = hostScript.ensure();
    const ledgerPath = newInactiveLedgerPath();
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
    ledgerByWorker.set(child, ledgerPath);
    return child;
  }

  function spawnHostWorker(): ChildProcessWithoutNullStreams {
    elevatedJobs.assertClear();
    assertComputerWorkerCapacity(liveWorkerCount() + elevatedSlots, maxWorkers);
    const child = spawnHostProcess();
    hostWorkers.add(child);
    const receive = createComputerLineDecoder((line) => {
      if (line.startsWith('@@MIXDOG_POINTER@@')) {
        reportPointerProgress(
          line.slice('@@MIXDOG_POINTER@@'.length),
          (id) => {
            const entry = pending.get(id as number);
            // Only this worker's own requests: a reused id from a retired
            // worker names a request this line knows nothing about.
            return entry?.child === child ? entry : undefined;
          },
          host.onPointerProgress
        );
        return;
      }
      const marker = line.indexOf(RESPONSE_MARKER);
      if (marker >= 0) handlePsLine(line.slice(marker + RESPONSE_MARKER.length), child);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      try {
        receive(chunk);
      } catch (error) {
        retirePowerShell(child, error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on('data', () => {
      /* diagnostics ignored; errors ride responses */
    });
    child.stdin.once('error', (error) => {
      retirePowerShell(child, new Error(`computer host input channel failed: ${error.message}`));
    });
    child.once('error', (error) => {
      if (!child.pid) hostWorkers.delete(child);
      retirePowerShell(child, new Error(`computer host failed to start: ${error.message}`));
    });
    child.once('exit', () => {
      hostWorkers.delete(child);
      const ledgerPath = ledgerByWorker.get(child);
      if (ledgerPath) {
        ledgerByWorker.delete(child);
        recoverInactiveLedger(ledgerPath);
      }
      retirePowerShell(child, new Error('computer host exited'));
    });
    return child;
  }

  function ensurePowerShell(sessionId: string): ChildProcessWithoutNullStreams {
    elevatedJobs.assertClear();
    const existing = powerShellBySession.get(sessionId);
    if (existing && !existing.killed) {
      workerLastUsedAt.set(sessionId, Date.now());
      return existing;
    }
    const child = spawnHostWorker();
    powerShellBySession.set(sessionId, child);
    workerLastUsedAt.set(sessionId, Date.now());
    return child;
  }

  function retirePowerShell(child: ChildProcessWithoutNullStreams, error: Error): void {
    const retiredSessionIds: string[] = [];
    let interruptedInput = false;
    for (const [sessionId, activeChild] of powerShellBySession) {
      if (activeChild !== child) continue;
      powerShellBySession.delete(sessionId);
      workerLastUsedAt.delete(sessionId);
      retiredSessionIds.push(sessionId);
    }
    for (const [id, entry] of pending) {
      if (entry.child !== child) continue;
      if (entry.input) {
        interruptedInput = true;
        // An uncertain mutation is not necessarily an unacknowledged key/button
        // release. Semantic actions and WM_CHAR alone cannot leave one held.
        if (entry.mode === 'background' && entry.backgroundPressRelease) {
          unconfirmedBackgroundSessions.add(entry.sessionId);
        }
      }
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
    if (!child.killed && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* exit confirmation belongs to the lifecycle */
      }
    }
    for (const sessionId of retiredSessionIds) {
      try {
        onSessionRetired?.(sessionId, child, interruptedInput);
      } catch {
        /* failed cleanup stays latched */
      }
    }
  }

  function handlePsLine(json: string, child: ChildProcessWithoutNullStreams): void {
    let parsed: PowerShellResponse;
    try {
      parsed = JSON.parse(json) as PowerShellResponse;
    } catch {
      return;
    }
    const entry = pending.get(parsed.id);
    if (!entry || entry.child !== child) return;
    if (entry.input && entry.mode === 'background' && /input_cleanup_unconfirmed/.test(String(parsed.error || ''))) {
      unconfirmedBackgroundSessions.add(entry.sessionId);
    }
    const feedback = (
      parsed as PowerShellResponse & {
        pointer_feedback?: { generated: number; failed: number };
      }
    ).pointer_feedback;
    if (entry.pointerFeedback) {
      recordCursorDiagnostic('tracked_requests');
      if (feedback) {
        recordCursorDiagnostic('source_generated', feedback.generated);
        recordCursorDiagnostic('source_failed', feedback.failed);
      } else recordCursorDiagnostic('source_summary_missing');
    }
    clearTimeout(entry.timer);
    pending.delete(parsed.id);
    const cleanup = captureCleanup(parsed.result?.capture_cleanup);
    if (!entry.input && cleanup && cleanup.status !== 'confirmed') {
      // Unpublish before resolving: a caller may issue its next request before
      // the worker's exit event arrives. Preserve this reply's original cause.
      retirePowerShell(child, new Error('capture_cleanup_unconfirmed: capture worker must retire'));
    }
    entry.resolve(parsed);
  }

  function callPowerShell(
    request: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS
  ): Promise<PowerShellResponse> {
    const classified = classifyWorkerRequest(request);
    const sessionId = classified.sessionId;
    const id = nextId++;
    const pointerFeedback = classified.pointerAction && Boolean(host.onPointerProgress);
    const line = `${JSON.stringify({ ...request, id, pointer_feedback: pointerFeedback })}\n`;
    if (pending.size >= 32 || Buffer.byteLength(line) > MAX_COMPUTER_INTERNAL_REQUEST_BYTES) {
      return Promise.reject(
        new Error('computer_capacity_exhausted: worker request budget exceeded; input was not dispatched')
      );
    }
    const child = ensurePowerShell(sessionId);
    const commandTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(50, Math.min(COMMAND_TIMEOUT_MS, Math.round(timeoutMs)))
      : COMMAND_TIMEOUT_MS;
    return new Promise<PowerShellResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        retirePowerShell(
          child,
          new Error(`computer_command_timeout: command exceeded ${commandTimeoutMs}ms; the input host was restarted`)
        );
      }, commandTimeoutMs);
      pending.set(id, {
        resolve,
        reject,
        timer,
        child,
        sessionId,
        pointerFeedback,
        windowId: classified.windowId,
        mode: classified.mode,
        input: classified.input,
        backgroundPressRelease: classified.backgroundPressRelease,
      });
      try {
        child.stdin.write(line);
      } catch (error) {
        retirePowerShell(child, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async function callPowerShellElevated(request: Record<string, unknown>): Promise<PowerShellResponse> {
    const sessionId = String(request.session_id || 'default');
    ensurePowerShell(sessionId);
    const hostScriptPath = hostScript.path();
    if (!hostScriptPath) throw new Error('privileged_worker_unavailable: computer host script is missing');
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true });
    assertComputerWorkerCapacity(liveWorkerCount() + elevatedSlots + 2, maxWorkers);
    const inactiveLedger = newInactiveLedgerPath();
    return runElevatedRequest({
      request,
      id: nextId++,
      directory,
      hostScriptPath,
      inputMarker,
      inactiveLedger,
      spawnProcess,
      begin: (cancel) => {
        const job = elevatedJobs.begin(sessionId, cancel);
        elevatedSlots += 3;
        return {
          finish(stopped) {
            job.finish(stopped);
            if (stopped) elevatedSlots -= 3;
          },
        };
      },
    }).then(
      (value) => {
        recoverInactiveLedger(inactiveLedger);
        return value;
      },
      (error) => {
        settleElevatedLedgerFailure(error, inactiveLedger, recoverInactiveLedger, (path) =>
          pendingInactiveLedgers.hold(path, sessionId)
        );
        throw error;
      }
    );
  }

  function residentWorkerPids(): number[] {
    return [...hostWorkers]
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => Number(child.pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  /** Resolves true once no resident worker is alive; false at the deadline. */
  function waitForResidentWorkersExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        if (residentWorkerPids().length === 0) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, 100).unref?.();
      };
      check();
    });
  }

  return {
    inputMarker,
    powerShellBySession,
    workerLastUsedAt,
    residentWorkerPids,
    waitForResidentWorkersExit,
    removeHostScript: hostScript.remove,
    ensureHostScript: hostScript.ensure,
    ensurePowerShell,
    retirePowerShell,
    hasUnconfirmedBackgroundInput: (sessionId?: string) =>
      sessionId === undefined ? unconfirmedBackgroundSessions.size > 0 : unconfirmedBackgroundSessions.has(sessionId),
    /** User-acknowledged recovery only: forgets background input whose
     *  target-local release could not be proven. */
    clearUnconfirmedBackgroundInput(): void {
      unconfirmedBackgroundSessions.clear();
    },
    /** User-acknowledged recovery only: releases unconfirmed elevated sessions
     *  and their slots, unless an elevated job is still pending. */
    releaseUnconfirmedElevated(): void {
      elevatedSlots -= elevatedJobs.releaseUnconfirmed() * 3;
    },
    /** Ledgers safe to recover: exited workers', plus those of `confirmedSessionId`'s
     *  elevated worker once that session's own abort has confirmed it stopped. */
    pendingInactiveLedgers: (confirmedSessionId?: string): string[] =>
      pendingInactiveLedgers.recoverable(confirmedSessionId),
    inactiveLedgersRecovered(paths: string[]): void {
      for (const path of paths) pendingInactiveLedgers.forget(path);
    },
    callPowerShell,
    callPowerShellElevated,
    cancelElevatedSession: elevatedJobs.cancel,
    elevatedSessionIds: elevatedJobs.sessionIds,
  };
}
