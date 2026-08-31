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
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type Server } from 'node:http';
import {
  DEFAULT_CAPTURE_AFTER_DELAY_MS,
  MAX_CAPTURE_AFTER_DELAY_MS,
  elapsedMs,
  mixdogDataDirectory,
} from './computer-host-shared';
import { electronWindowForNativeId } from './computer-host-window-handles';
import { persistFrameImage } from './frame-files';
import { appendComputerRunRecord, computerRunRecord } from './computer-host-run-log';
import { createBridgeDiscovery } from './computer-host-discovery';
import { createWorkerPool } from './computer-host-worker-pool';
import { createCaptureEngine } from './computer-host-capture';
import { createSessionState } from './computer-host-session-state';
import { createInspection } from './computer-host-inspect';
import {
  assertExactWindowCommandTarget,
  createWindowTargeting,
} from './computer-host-targeting';
import {
  createChromeRemoteDebuggingSetup,
  CHROME_SETUP_SESSION_ID,
  type ChromeRemoteDebuggingSetup,
  type ChromeRemoteDebuggingTarget,
} from './computer-host-chrome-setup';
export type { ChromeRemoteDebuggingSetup, ChromeRemoteDebuggingTarget };
import type {
  ComputerCommand,
  ComputerCommandResult,
  PowerShellResponse,
  ObservedWindowScope,
} from './computer-host-types';
import { assertSafeComputerInput } from './computer-host-input-guards';
import {
  assertCaptureAfterOptions,
  captureAfterImageIsRedundant,
  recommendedRecovery,
  transitionConfirmsSemanticAction,
  framePoint,
  screenshotInteger,
} from './computer-host-observation';
import { ABORT_CLEANUP_PROGRAM } from './computer-host-program';
import {
  computeComputerWindowTransition,
  normalizeComputerWindowRecords,
  type ComputerWindowRecord,
  type ComputerWindowTransition,
} from './computer-window-transition';
import { beginComputerOperation } from './human-only-approval';

const HEARTBEAT_MS = 60_000;
const ABORT_CLEANUP_TIMEOUT_MS = 5_000;
const LAUNCH_SUCCESSOR_TIMEOUT_MS = 4_000;
const LAUNCH_POLL_INTERVAL_MS = 100;
/** The session the bridge warms up under, before any caller exists. */
const HOST_WARMUP_SESSION_ID = '__computer_host_warmup__';
const suppressedSequenceCaptures = new WeakSet<object>();
const trustedSequenceContinuations = new WeakSet<object>();

const OBSERVATION_BOUND_INPUT_ACTIONS = new Set([
  'invoke', 'set_value', 'toggle',
  'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'mouse_move', 'drag', 'type', 'key', 'scroll',
]);
const AUTO_CAPTURE_ACTIONS = new Set([
  ...OBSERVATION_BOUND_INPUT_ACTIONS,
  'focus_window', 'move_window', 'window_state', 'close_window', 'launch', 'invoke_menu',
]);

interface InputRecoveryState {
  targetWindowId: string;
  restoreWindowId: string;
  /** Owner of the restore window, recorded while it still exists. */
  restoreOwnerWindowId: string;
  cursorX: number;
  cursorY: number;
}

// Observation-only mode keeps every state read available and refuses anything
// that could change the desktop, before the command reaches a dispatch path.
const OBSERVE_ONLY_ALLOWED_ACTIONS = new Set([
  'list_windows', 'list_apps', 'diagnose', 'capture', 'zoom', 'clipboard_read', 'wait',
  'verify', 'window_predicates',
  'snapshot', 'find', 'screenshot', 'window_bounds', 'window_snapshot', 'related_windows',
  'window_capture', 'window_integrity', 'input_recovery_state', 'ocr_image', 'ocr_status',
  'session_release', 'session_abort',
]);

export interface PowerShellComputerHost {
  setBridgeEnabled(enabled: boolean): void;
  /** Observation-only opt-in: reads stay available, input is refused. */
  setObserveOnly(enabled: boolean): void;
  /** Live native worker PIDs, retained until each child actually exits. */
  residentWorkerPids(): number[];
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
  options: { bridgeEnabled?: boolean; observeOnly?: boolean } = {},
): PowerShellComputerHost {
  let token = randomBytes(24).toString('base64url');
  let heartbeat: NodeJS.Timeout | null = null;
  let server: Server | null = null;
  let bridgeStopPromise: Promise<void> | null = null;
  let bridgeWanted = options.bridgeEnabled !== false;
  let observeOnly = options.observeOnly === true;
  let bridgeGeneration = 0;
  let disposed = false;

  // Agent-scoped resident PowerShell workers + their shared pending-request table.
  const {
    powerShellBySession,
    workerLastUsedAt,
    adoptWarmedWorker,
    releaseSpareWorker,
    residentWorkerPids,
    removeHostScript,
    retirePowerShell,
    callPowerShell,
    callPowerShellElevated,
  } = createWorkerPool({
    dataDirectory: mixdogDataDirectory,
    isBridgeEnabled: () => bridgeWanted,
    isDisposed: () => disposed,
  });

  const commandChainsBySession = new Map<string, Promise<unknown>>();
  let foregroundChain: Promise<unknown> = Promise.resolve();
  const {
    framesBySession,
    elementTargetsBySession,
    observedWindowBySession,
    lastCaptureBySession,
    allocateFrameId,
    sessionIdFor,
    rememberFrame,
    rememberObservedWindowScope,
    forgetObservedWindowScope,
    normalizeElementRecords,
    rememberElementTargets,
    resolveElementAliases,
    requireValidFrame,
  } = createSessionState({ callPowerShell });

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
  // A resident worker holds a PowerShell process plus its window claims. A
  // runtime that dies without releasing its session would pin both forever, so
  // idle workers expire on the same clock as the claims they hold.
  const WORKER_IDLE_STALE_MS = TARGET_CLAIM_STALE_MS;

  function expireStaleTargetClaims(now = Date.now()): void {
    for (const [windowId, claim] of targetClaims) {
      if (now - claim.lastUsedAt < TARGET_CLAIM_STALE_MS) continue;
      targetClaims.delete(windowId);
      const sessionTargets = targetsBySession.get(claim.sessionId);
      sessionTargets?.delete(windowId);
      if (sessionTargets?.size === 0) targetsBySession.delete(claim.sessionId);
    }
  }

  function reapIdleSessionWorkers(now = Date.now()): void {
    for (const [sessionId, child] of powerShellBySession) {
      if (activeExecutionsBySession.has(sessionId)) continue;
      if (now - (workerLastUsedAt.get(sessionId) || 0) < WORKER_IDLE_STALE_MS) continue;
      framesBySession.delete(sessionId);
      elementTargetsBySession.delete(sessionId);
      observedWindowBySession.delete(sessionId);
      lastCaptureBySession.delete(sessionId);
      sessionRecoveryBySession.delete(sessionId);
      releaseTargetClaims(sessionId);
      retirePowerShell(child, new Error('computer session worker reclaimed after idle timeout'));
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
      lastCaptureBySession.delete(sessionId);
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
    lastCaptureBySession.delete(sessionId);
    sessionRecoveryBySession.delete(sessionId);
    releaseTargetClaims(sessionId);
    await runForegroundExclusive(() => cleanupAbortedInput(recovery));
    if (!commandChainsBySession.has(sessionId)) sessionAbortEpochs.delete(sessionId);
    return { text: 'computer session aborted; input state and session resources were released' };
  }

  /** Write the host program once and point the workers at a per-build native
   *  assembly cache, so only the first worker of a build pays the C# compile. */

  /** Keep one worker warm so a new session never waits for PowerShell startup
   *  and the host type load on its first command. */

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

  const {
    resolveAppWindowId,
    resolveForegroundWindowId,
    listComputerApps,
  } = createWindowTargeting({ readComputerWindows });

  const { diagnoseComputer, verifyWindowState } = createInspection({
    callPowerShell,
    sessionIdFor,
    assertExecutionNotAborted,
    readComputerWindows,
    isObserveOnly: () => observeOnly,
  });

  const {
    captureScreenshot,
    captureZoom,
    captureComputer,
    captureAfterAction,
  } = createCaptureEngine({
    callPowerShell,
    sessionIdFor,
    assertExecutionNotAborted,
    normalizeElementRecords,
    rememberFrame,
    rememberElementTargets,
    rememberObservedWindowScope,
    forgetObservedWindowScope,
    requireValidFrame,
    resolveAppWindowId,
    resolveForegroundWindowId,
    framesBySession,
    elementTargetsBySession,
    lastCaptureBySession,
    allocateFrameId,
  });

  /** On-demand JPEG through Electron, scoped to the primary screen or one window. */

  /** Full-resolution crop of one captured frame. */

  /** Identity that survives a recapture: refs and marks are frame-scoped, so a
   *  stable element is its role + name, numbered when a name repeats. */

  /** A fresh screenshot proves nothing when a healthy semantic tree came back
   *  identical: the change summary already says the action moved nothing. Empty
   *  trees, OCR, and pixel modes always keep their image. */

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
      restoreOwnerWindowId: String(result.restore_owner_window_id || ''),
      cursorX: Number(result.cursor_x),
      cursorY: Number(result.cursor_y),
    };
    if (!recovery.targetWindowId || !Number.isFinite(recovery.cursorX) || !Number.isFinite(recovery.cursorY)) {
      throw new Error('foreground input recovery state is incomplete; no input was sent');
    }
    return recovery;
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
    const allowedStepFields: Record<string, Set<string>> = {
      invoke: new Set(['action', 'ref', 'modifiers']),
      click: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'modifiers']),
      right_click: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'modifiers']),
      middle_click: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'modifiers']),
      type: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'text']),
      key: new Set(['action', 'ref', 'keys']),
      wait: new Set(['action', 'duration']),
    };
    const stepCommands = steps.map((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw new Error(`sequence step ${index + 1} must be an object`);
      }
      const stepAction = String(step.action || '');
      if (index === 0) {
        if (!['invoke', 'click', 'right_click', 'middle_click', 'type', 'key'].includes(stepAction)) {
          throw new Error('sequence first step must be click, type, or key');
        }
      } else if (!['type', 'key', 'wait'].includes(stepAction)) {
        throw new Error('sequence continuation steps must be type, key, or wait');
      }
      const targetOverrides = ['window_id', 'window', 'app', 'screen', 'session_id', 'delivery']
        .filter((field) => Object.prototype.hasOwnProperty.call(step, field));
      if (targetOverrides.length) {
        throw new Error(
          `sequence step ${index + 1} cannot override root field(s): ${targetOverrides.join(', ')}`,
        );
      }
      const extraFields = Object.keys(step)
        .filter((field) => !allowedStepFields[stepAction]?.has(field));
      if (extraFields.length) {
        throw new Error(
          `sequence step ${index + 1} does not accept field(s): ${extraFields.join(', ')}`,
        );
      }
      if (index > 0
        && ['ref', 'element', 'frame_id', 'x', 'y']
          .some((field) => Object.prototype.hasOwnProperty.call(step, field))) {
        throw new Error(`sequence step ${index + 1} reuses focus and cannot carry a target`);
      }
      if (stepAction === 'type' && typeof step.text !== 'string') {
        throw new Error(`sequence step ${index + 1} requires string text`);
      }
      if (stepAction === 'key' && typeof step.keys !== 'string') {
        throw new Error(`sequence step ${index + 1} requires string keys`);
      }
      if (stepAction === 'wait'
        && (typeof step.duration !== 'number'
          || !Number.isFinite(step.duration)
          || step.duration < 0
          || step.duration > 30)) {
        throw new Error(`sequence step ${index + 1} requires duration from 0 to 30 seconds`);
      }
      const stepCommand: ComputerCommand = {
        ...step,
        action: stepAction,
        window_id: windowId,
        delivery: command.delivery || 'background',
        session_id: sessionIdFor(command),
      };
      assertSafeComputerInput(stepCommand);
      return stepCommand;
    });
    const rows: Array<Record<string, unknown>> = [];
    let stoppedReason = '';
    let finalWindowId = windowId;
    let lastTransition: ComputerWindowTransition | null = null;
    let completedSteps = 0;
    for (let index = 0; index < stepCommands.length; index += 1) {
      const stepCommand = stepCommands[index];
      const stepAction = String(stepCommand.action || '');
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

  /** One predicate against one observed window state. Absence is only proven
   *  when the observation itself succeeded; anything else stays unknown, and
   *  unknown never counts as success. */

  /** Bounded wait for a window condition. It reads predicate state only, so it
   *  never invalidates the refs the caller holds and never returns pixels. */

  /** Honour image_output for the pixel-only replies that carry no capture
   *  payload. A frame that cannot be written stays in the reply. */
  function frameReply(
    command: ComputerCommand,
    description: string,
    image: { mimeType: string; data: string },
    frameId: string,
  ): ComputerCommandResult {
    if (String(command.image_output || 'inline') !== 'file') return { text: description, image };
    const stored = persistFrameImage('computer', sessionIdFor(command), frameId, image);
    if (!stored) return { text: description, image };
    return {
      text: `${description}; frame written to ${stored.path} (${stored.bytes} bytes)`,
    };
  }

  /** Where an input lands and whether it may be sent there: frame-bound
   *  coordinates become physical screen ones, and an observation-bound action
   *  must still target the window scope this session last observed. */
  async function resolveInputTarget(
    command: ComputerCommand,
    action: string,
    trustedSequenceContinuation: boolean,
  ): Promise<{
    physicalX?: number;
    physicalY?: number;
    physicalToX?: number;
    physicalToY?: number;
    targetWindowId?: string;
    allowedWindowIds: string[];
    observedScope?: ObservedWindowScope;
  }> {
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
    return {
      physicalX,
      physicalY,
      physicalToX,
      physicalToY,
      targetWindowId,
      allowedWindowIds,
      observedScope,
    };
  }

  /** Prove the desktop was handed back after foreground input: the window that
   *  held focus holds it again and the cursor sits where the user left it. One
   *  reassertion is allowed, and what actually happened is always reported. */
  async function verifyInputRecovery(
    command: ComputerCommand,
    targetWindowId: string | undefined,
    inputRecovery: InputRecoveryState,
    timings: Record<string, number>,
  ): Promise<Record<string, unknown>> {
    let current: InputRecoveryState | undefined;
    let reasserted = false;
    let restoredTarget = '';
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
          restore_owner_window_id: inputRecovery.restoreOwnerWindowId,
          cursor_x: inputRecovery.cursorX,
          cursor_y: inputRecovery.cursorY,
          session_id: sessionIdFor(command),
        });
        timings.input_recovery_ms = elapsedMs(recoveryStartedAt);
        if (!restored.ok) throw new Error(restored.error || 'input recovery reassertion failed');
        restoredTarget = String(restored.result?.restored_target || '');
        current = {
          targetWindowId: inputRecovery.targetWindowId,
          restoreWindowId: String(restored.result?.foreground_window_id || ''),
          restoreOwnerWindowId: inputRecovery.restoreOwnerWindowId,
          cursorX: Number(restored.result?.cursor_x),
          cursorY: Number(restored.result?.cursor_y),
        };
        reasserted = true;
      }
      // Landing on the owner is the honest outcome when the action closed the
      // window that held focus; any other destination is still a miss.
      const focusRestored = current.restoreWindowId === inputRecovery.restoreWindowId
        || (restoredTarget === 'owner'
          && inputRecovery.restoreOwnerWindowId !== ''
          && current.restoreWindowId === inputRecovery.restoreOwnerWindowId);
      const cursorRestored = current.cursorX === inputRecovery.cursorX
        && current.cursorY === inputRecovery.cursorY;
      return {
        ok: focusRestored && cursorRestored,
        focus_restored: focusRestored,
        cursor_restored: cursorRestored,
        expected_focus_window_id: inputRecovery.restoreWindowId,
        actual_focus_window_id: current.restoreWindowId,
        expected_cursor: [inputRecovery.cursorX, inputRecovery.cursorY],
        actual_cursor: [current.cursorX, current.cursorY],
        reasserted,
        ...(restoredTarget === 'owner' ? { restored_target: 'owner_after_close' } : {}),
        ...(readbackError ? { readback_error: readbackError } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        focus_restored: false,
        cursor_restored: false,
        error: (error as Error).message || String(error),
        ...(readbackError ? { readback_error: readbackError } : {}),
      };
    }
  }

  /** Let the desktop settle after a mutation and report what moved. A launch
   *  polls until its successor window exists or the budget ends; every other
   *  action pays one settle and then reads the window list once. */
  async function settleWindowTransition(input: {
    command: ComputerCommand;
    action: string;
    windowsBefore: ComputerWindowRecord[] | null;
    targetWindowId: string;
    pid: number;
    appHint: string;
    timings: Record<string, number>;
  }): Promise<{ transition: ComputerWindowTransition | null; settleDelayMs: number }> {
    const { command, action, windowsBefore, timings } = input;
    const settleStartedAt = performance.now();
    let settleDelayMs = screenshotInteger(
      command.capture_after ? command.capture_delay_ms : undefined,
      DEFAULT_CAPTURE_AFTER_DELAY_MS,
      0,
      MAX_CAPTURE_AFTER_DELAY_MS,
      'capture_delay_ms',
    );
    let transition: ComputerWindowTransition | null = null;
    let windowScanMs = 0;
    const transitionFor = (windowsAfter: ComputerWindowRecord[] | null) =>
      windowsBefore && windowsAfter
        ? computeComputerWindowTransition(
            windowsBefore,
            windowsAfter,
            input.targetWindowId,
            input.pid,
            input.appHint,
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
        transition = transitionFor(windowsAfter);
        launchSuccessorReady = Boolean(transition?.next_target)
          && performance.now() - settleStartedAt >= minimumLaunchSettleMs;
      } while (!launchSuccessorReady && performance.now() < deadline);
      settleDelayMs = Math.round(performance.now() - settleStartedAt);
    } else {
      // The settle budget is not shortened by watching for the transition to
      // START: a window closing or opening is the beginning of the move, and
      // the successor surface still needs this window to build its tree.
      // Measured: exiting on that signal returned empty parent trees.
      if (settleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
      assertExecutionNotAborted();
      const transitionStartedAt = performance.now();
      const windowsAfter = await readComputerWindows(command);
      windowScanMs = elapsedMs(transitionStartedAt);
      transition = transitionFor(windowsAfter);
    }
    timings.settle_ms = Math.max(0, elapsedMs(settleStartedAt) - windowScanMs);
    timings.after_windows_ms = Number(windowScanMs.toFixed(2));
    return { transition, settleDelayMs };
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
    // Checked before every early return, so a bounded sequence cannot slip past
    // it. The app's own Browser Use setup flow keeps its internal session.
    if (observeOnly
      && !OBSERVE_ONLY_ALLOWED_ACTIONS.has(action)
      && sessionIdFor(command) !== CHROME_SETUP_SESSION_ID) {
      throw new Error(`observation_only: Computer Use is observing only, so '${action}' input is blocked. Turn off "Observation only" in Settings to allow input.`);
    }
    if (action === 'sequence' && command.read_only) {
      throw new Error("read_only run: 'sequence' is a mutation");
    }
    if (action === 'session_release') return await releaseComputerSession(command);
    if (action === 'diagnose') return await diagnoseComputer(command);
    if (command.app?.trim() && !['launch', 'list_apps', 'capture'].includes(action)) {
      command = {
        ...command,
        app: undefined,
        window: undefined,
        window_id: await resolveAppWindowId(command),
      };
    }
    if (action === 'sequence') {
      assertCaptureAfterOptions(command);
      assertExactWindowCommandTarget(command);
      return await runBoundedSequence(command);
    }
    const readActions = new Set([
      'list_windows', 'list_apps', 'snapshot', 'find', 'capture', 'clipboard_read', 'wait',
      'window_bounds', 'screenshot', 'zoom', 'verify', 'window_predicates',
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
    if (shouldCaptureAfter) assertCaptureAfterOptions(command);
    if (shouldCaptureAfter !== command.capture_after) {
      command = { ...command, capture_after: shouldCaptureAfter };
    }
    assertExactWindowCommandTarget(command);
    command = resolveElementAliases(command);
    const semanticTargetIdentity = command.ref
      ? lastCaptureBySession.get(sessionIdFor(command))?.refIdentities.get(command.ref)
      : undefined;
    assertSafeComputerInput(command);
    if (action === 'verify') return await verifyWindowState(command);
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
      return frameReply(command, screenshot.description, screenshot.image, screenshot.frameId);
    }
    if (action === 'zoom') {
      const zoom = await captureZoom(command);
      if (!zoom) throw new Error('zoom capture failed');
      if (zoom.pixelUnavailable) {
        return {
          text: JSON.stringify({
            ok: false,
            action: 'zoom',
            code: 'pixel_unavailable',
            pixel_status: 'unavailable',
            pixel_unavailable: zoom.pixelUnavailable,
            escalation: 'recapture',
          }),
        };
      }
      if (!zoom.image || !zoom.frameId) throw new Error('zoom capture returned incomplete state');
      return frameReply(command, zoom.description, zoom.image, zoom.frameId);
    }
    const {
      physicalX,
      physicalY,
      physicalToX,
      physicalToY,
      targetWindowId,
      allowedWindowIds,
      observedScope,
    } = await resolveInputTarget(command, action, trustedSequenceContinuation);
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
          if (!focused.ok
            || focused.result?.code
            || focused.result?.delivery_accepted !== true) {
            throw new Error(
              focused.error
                || String(focused.result?.text || '')
                || 'element-targeted type could not focus the point',
            );
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
          path: command.path ?? null,
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
        if (AUTO_CAPTURE_ACTIONS.has(action)) {
          observedWindowBySession.delete(sessionIdFor(command));
        }
      }
    }
    actionTimings.delivery_ms = elapsedMs(deliveryStartedAt);
    assertExecutionNotAborted();
    if (!response.ok) throw new Error(response.error || 'computer command failed');
    const result = response.result || {};
    const inputRecoveryVerification = inputRecovery
      ? await verifyInputRecovery(command, targetWindowId, inputRecovery, actionTimings)
      : undefined;
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
      const settled = await settleWindowTransition({
        command,
        action,
        windowsBefore,
        targetWindowId: String(logicalTargetWindowId || result.window_id || ''),
        pid: Number(result.pid) || 0,
        appHint: action === 'launch' ? String(result.app_hint || command.app || '') : '',
        timings: actionTimings,
      });
      windowTransition = settled.transition;
      settleDelayMs = settled.settleDelayMs;
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
          if (capture.image && captureAfterImageIsRedundant(
            command,
            capture.metadata,
            semanticTargetIdentity,
          )) {
            (payload.capture_after as Record<string, unknown>).image_omitted =
              'semantic_change_reported';
          } else {
            image = capture.image;
          }
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
      || action === 'invoke_menu'
      || action === 'move_window'
      || action === 'window_state'
      || action === 'close_window'
      || action === 'clipboard_read'
      || action === 'clipboard_write';
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
      const recordStartedAt = performance.now();
      try {
        const operation = () => executionContext.run(execution, () => runCommand(command));
        const outcome = requiresForegroundLane(command)
          ? await runForegroundExclusive(operation)
          : await operation();
        appendComputerRunRecord(sessionId, computerRunRecord(command, recordStartedAt, outcome));
        return outcome;
      } catch (error) {
        appendComputerRunRecord(sessionId, {
          ...computerRunRecord(command, recordStartedAt),
          ok: false,
          error: String((error as Error)?.message || error).slice(0, 300),
        });
        throw error;
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
        sessionAbortEpochs.delete(sessionId);
      }
    });
    return run;
  }

  const {
    inspectChromeRemoteDebuggingTarget,
    prepareChromeRemoteDebugging,
    acceptChromeRemoteDebuggingConsent,
    finalizeChromeRemoteDebuggingSetup,
    releaseChromeRemoteDebugging,
  } = createChromeRemoteDebuggingSetup({
    executeSerialized,
    readComputerWindows,
    normalizeElementRecords,
    suppressCaptureAfter: (command) => { suppressedSequenceCaptures.add(command); },
  });

  const {
    readRequestBody,
    respond,
    writeDiscovery,
    heartbeatDiscovery,
    removeDiscovery,
  } = createBridgeDiscovery({ dataDirectory: mixdogDataDirectory });

  async function stopBridge(): Promise<void> {
    if (bridgeStopPromise) return await bridgeStopPromise;
    bridgeStopPromise = (async () => {
      bridgeGeneration += 1;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      removeDiscovery(token);
      const activeServer = server;
      server = null;
      if (activeServer) {
        await new Promise<void>((resolve) => {
          activeServer.close(() => resolve());
          activeServer.closeAllConnections?.();
          setTimeout(resolve, 250).unref?.();
        });
      }
      releaseSpareWorker();
      await Promise.allSettled(
        [...powerShellBySession.keys()]
          .filter((sessionId) => sessionId !== CHROME_SETUP_SESSION_ID)
          .map((sessionId) => abortComputerSession({
            action: 'session_abort',
            session_id: sessionId,
          })),
      );
    })();
    try {
      await bridgeStopPromise;
    } finally {
      bridgeStopPromise = null;
      if (bridgeWanted && !disposed) startBridge();
    }
  }

  function startBridge(): void {
    if (disposed || !bridgeWanted || server || bridgeStopPromise) return;
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
        // A dropped connection is the only cancellation signal left when the
        // runtime dies before it can send session_abort. Without this the queued
        // input keeps driving the user's desktop until the command timeout.
        let clientGone = false;
        const abortOnDisconnect = (): void => {
          if (clientGone) return;
          clientGone = true;
          const pendingAction = String(command.action || '');
          if (pendingAction === 'session_abort' || pendingAction === 'session_release') return;
          void abortComputerSession(command).catch(() => { /* host already idle */ });
        };
        request.once('aborted', abortOnDisconnect);
        response.once('close', () => {
          if (!response.writableEnded) abortOnDisconnect();
        });
        try {
          const value = command.action === 'session_abort'
            ? await abortComputerSession(command)
            : await executeSerialized(command);
          if (!clientGone) respond(response, 200, { ok: true, value });
        } catch (error) {
          if (!clientGone) {
            respond(response, 200, { ok: false, error: (error as Error).message || String(error) });
          }
        } finally {
          request.removeListener('aborted', abortOnDisconnect);
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
        session_id: HOST_WARMUP_SESSION_ID,
        read_only: true,
      }).then(() => {
        if (disposed || !bridgeWanted || server !== created || bridgeGeneration !== generation) return;
        // The warm-up worker already paid startup, so it becomes the spare the
        // first real session adopts instead of being reaped and respawned.
        adoptWarmedWorker(HOST_WARMUP_SESSION_ID);
        try {
          writeDiscovery(port, activeToken);
          heartbeat = setInterval(
            () => {
              heartbeatDiscovery(port, activeToken);
              reapIdleSessionWorkers();
            },
            HEARTBEAT_MS,
          );
          heartbeat.unref?.();
        } catch (error) {
          console.error('computer bridge discovery write failed:', error);
        }
      }).catch((error) => {
        if (disposed || !bridgeWanted || server !== created || bridgeGeneration !== generation) return;
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
    setObserveOnly(enabled: boolean): void {
      observeOnly = enabled === true;
    },
    residentWorkerPids,
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
      removeHostScript();
    },
  };
}