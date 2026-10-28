/**
 * The resident PowerShell workers: publishing the host script, caching its
 * compiled types per build, keeping one worker warm, routing requests, and the
 * one-shot elevated path for targets a normal worker cannot reach. The pool
 * owns worker state; the host tells it whether the bridge is still wanted.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { createHostScriptPublisher } from './host-script';
import { createElevatedRequests } from './elevated-requests';
import { launchHostProcess, watchHostWorker } from './host-worker-process';
import { createResidentWorkers } from './resident-workers';
import { createWorkerLedgers } from './worker-ledgers';
import { COMMAND_TIMEOUT_MS, createWorkerRequests, type PendingWorkerRequest } from './worker-requests';
import { recordCursorDiagnostic } from '../overlay/cursor-diagnostics';
import { assertComputerWorkerCapacity, MAX_COMPUTER_WORKERS } from './worker-capacity';
import { WINDOW_ARRIVALS_SESSION_ID } from '../shared/common';
import type { PowerShellResponse } from '../shared/types';
import { computerActionHas } from '../../../../../../src/runtime/computer-bridge/actions.mjs';
import { MAX_COMPUTER_INTERNAL_REQUEST_BYTES } from '../../../../../../src/runtime/computer-bridge/limits.mjs';

export { settleElevatedLedger } from './elevated-requests';

/** Worker slots the optional window-arrivals reader always leaves to sessions. */
const READER_HEADROOM = 1;

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
        (process.platform === 'darwin' ||
          (target?.x != null && target?.y != null) ||
          String(target?.text ?? '').includes('\n'))),
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

export function createWorkerPool(host: WorkerPoolHost) {
  const { dataDirectory, onSessionRetired } = host;

  const hostScript = createHostScriptPublisher(dataDirectory);
  let nextId = 1;
  const requests = createWorkerRequests(onSessionRetired);
  const { powerShellBySession, workerLastUsedAt } = requests;
  const residents = createResidentWorkers();
  const maxWorkers = host.maxWorkers ?? MAX_COMPUTER_WORKERS;
  const spawnProcess = host.spawnProcess || spawn;
  assertComputerWorkerCapacity(0, maxWorkers);
  const inputMarker = String(randomBytes(4).readUInt32LE() & 0x7fffffff || 1);
  const ledgers = createWorkerLedgers(dataDirectory);
  const elevated = createElevatedRequests({
    dataDirectory,
    hostScriptPath: hostScript.path,
    ensureWorker: ensurePowerShell,
    // An elevated run keeps `live + slots + 2` below the cap, so it needs three
    // free slots; the reader gives way.
    liveWorkerCount: () => {
      makeRoom(3);
      return residents.liveCount();
    },
    maxWorkers,
    ledgers,
    inputMarker,
    spawnProcess,
    nextId: () => nextId++,
  });

  function spawnHostWorker(): ChildProcessWithoutNullStreams {
    elevated.assertClear();
    assertComputerWorkerCapacity(residents.liveCount() + elevated.slots(), maxWorkers);
    const child = launchHostProcess({
      dataDirectory,
      hostScript,
      ledgers,
      inputMarker,
      nativeEnvironment: () => host.nativeEnvironment?.(),
      spawnProcess,
    });
    residents.add(child);
    watchHostWorker(child, {
      pointerProgress: (payload) =>
        reportPointerProgress(payload, (id) => requests.requestOf(id, child), host.onPointerProgress),
      reply: (json) => requests.handleReply(json, child),
      retire: (error) => requests.retire(child, error),
      unstarted: () => residents.delete(child),
      exited: () => {
        residents.delete(child);
        ledgers.workerExited(child);
      },
    });
    return child;
  }

  function ensurePowerShell(sessionId: string): ChildProcessWithoutNullStreams {
    elevated.assertClear();
    const existing = powerShellBySession.get(sessionId);
    if (sessionId === WINDOW_ARRIVALS_SESSION_ID) assertReaderHeadroom(existing);
    if (existing && !existing.killed) {
      workerLastUsedAt.set(sessionId, Date.now());
      return existing;
    }
    makeRoom(1);
    const child = spawnHostWorker();
    powerShellBySession.set(sessionId, child);
    workerLastUsedAt.set(sessionId, Date.now());
    return child;
  }

  /** The window-arrivals reader is optional: it runs only while it leaves
   *  `READER_HEADROOM` slots free for sessions, counting itself. */
  function assertReaderHeadroom(existing: ChildProcessWithoutNullStreams | undefined): void {
    const others = residents.liveCount() - (existing && !existing.killed ? 1 : 0);
    if (others + elevated.slots() + 1 + READER_HEADROOM > maxWorkers) {
      throw new Error('computer_reader_deferred: worker slots are kept for sessions');
    }
  }

  /** A session that needs a slot the reader holds takes it: the reader is
   *  killed and stops counting at once instead of when its exit arrives. */
  function makeRoom(needed: number): void {
    const reader = powerShellBySession.get(WINDOW_ARRIVALS_SESSION_ID);
    if (!reader || residents.liveCount() + elevated.slots() + needed <= maxWorkers) return;
    residents.yieldSlot(reader);
    requests.retire(reader, new Error('computer_reader_yielded: a session needed the worker slot'));
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
    if (requests.inFlight() >= 32 || Buffer.byteLength(line) > MAX_COMPUTER_INTERNAL_REQUEST_BYTES) {
      return Promise.reject(
        new Error('computer_capacity_exhausted: worker request budget exceeded; input was not dispatched')
      );
    }
    const child = ensurePowerShell(sessionId);
    return requests.dispatch(
      child,
      id,
      line,
      {
        sessionId,
        pointerFeedback,
        windowId: classified.windowId,
        mode: classified.mode,
        input: classified.input,
        backgroundPressRelease: classified.backgroundPressRelease,
      },
      timeoutMs
    );
  }

  return {
    inputMarker,
    powerShellBySession,
    workerLastUsedAt,
    residentWorkerPids: residents.pids,
    waitForResidentWorkersExit: residents.waitForExit,
    removeHostScript: hostScript.remove,
    ensureHostScript: hostScript.ensure,
    ensurePowerShell,
    retirePowerShell: requests.retire,
    hasUnconfirmedBackgroundInput: requests.hasUnconfirmedBackgroundInput,
    /** User-acknowledged recovery only: forgets background input whose
     *  target-local release could not be proven. */
    clearUnconfirmedBackgroundInput: requests.clearUnconfirmedBackgroundInput,
    releaseUnconfirmedElevated: elevated.releaseUnconfirmed,
    /** Ledgers of workers confirmed gone, safe for any cleanup to recover. */
    pendingInactiveLedgers: (): string[] => ledgers.registry.recoverable(),
    inactiveLedgersRecovered(paths: string[]): void {
      for (const path of paths) ledgers.registry.forget(path);
    },
    callPowerShell,
    callPowerShellElevated: elevated.call,
    cancelElevatedSession: elevated.cancel,
    elevatedSessionIds: elevated.sessionIds,
  };
}
