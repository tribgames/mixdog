/**
 * Command dispatch for the Computer Use host. One command comes in, its
 * guards run in a fixed order (observation-only gate, safety, exact target,
 * fresh observation), then it is routed to a read, a capture, a bounded
 * sequence, or the resident backend, and the reply carries the verdict and
 * post-action observation the runtime acts on.
 */
import { elapsedMs } from '../shared/common';
import type {
  ComputerCommand,
  ComputerCommandResult,
  PowerShellResponse,
} from '../shared/types';
import type { ComputerWindowTransition } from '../shared/window-transition';
import { persistFrameImage } from '../../frame-files';
import {
  assertSafeComputerInput,
  assertSafeComputerSessionId,
  assertSafeComputerTargetTokens,
} from '../input/guards';
import { assertExactWindowCommandTarget } from '../input/targeting';
import type { createWindowTargeting } from '../input/targeting';
import {
  buildRecaptureRequiredPayload,
  isFreshRecaptureObservation,
  recaptureRequirementCode,
} from '../observation/recapture';
import {
  assertCaptureAfterOptions,
} from '../observation/analysis';
import type { createCaptureEngine } from '../observation/capture';
import type { createInspection } from '../observation/inspect';
import type { createWorkerPool } from '../backend/worker-pool';
import type { createSessionState } from '../session/state';
import { CHROME_SETUP_SESSION_ID } from '../session/chrome-setup';
import { computerUseCoordinator } from '../session/coordinator';
import {
  filterComputerUseInternalWindows,
  filterComputerUseWindowListText,
} from '../overlay/internal-windows';
import {
  AUTO_CAPTURE_ACTIONS,
  OBSERVE_ONLY_ALLOWED_ACTIONS,
  READ_ACTIONS,
} from './action-sets';
import type { ExecutionState, InputRecoveryState } from './execution-state';
import type { InputResolution } from './input-resolution';
import type { SessionLifecycle } from './session-lifecycle';
import type { WindowReads } from './window-reads';
import { captureAfterSuppressed, isSequenceStep, isTrustedSequenceContinuation } from './sequence-runner';
import { canBatchSequenceInput, readSequenceStep } from './sequence-dispatch';
import { createComputerExecutionPolicy, type ComputerExecutionPolicy } from './execution-policy';
import { createInputDispatch } from './input-dispatch';
import { buildActionReply } from './action-reply';
import { prepareCursorFeedback } from '../overlay/cursor-readiness';

const POINTER_ACTIONS = [
  'invoke', 'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'mouse_move', 'drag', 'scroll', 'type', 'key',
];

type WorkerPool = ReturnType<typeof createWorkerPool>;
type SessionState = ReturnType<typeof createSessionState>;
type CaptureEngine = ReturnType<typeof createCaptureEngine>;
type Inspection = ReturnType<typeof createInspection>;
type WindowTargeting = ReturnType<typeof createWindowTargeting>;

export interface CommandRouterHost extends
  Pick<WorkerPool, 'callPowerShell' | 'callPowerShellElevated'>,
  Pick<SessionState,
    | 'sessionIdFor'
    | 'framesBySession'
    | 'elementTargetsBySession'
    | 'observedWindowBySession'
    | 'lastCaptureBySession'
    | 'rememberObservedWindowScope'
    | 'freshObservedWindowScope'
    | 'invalidateActionTargets'
    | 'normalizeElementRecords'
    | 'rememberElementTargets'
    | 'resolveElementAliases'>,
  Pick<ExecutionState, 'executionContext' | 'sessionRecoveryBySession' | 'assertExecutionNotAborted'>,
  Pick<SessionLifecycle, 'claimComputerTargets' | 'releaseComputerSession' | 'takeOverComputer'>,
  Pick<Inspection, 'diagnoseComputer' | 'verifyWindowState'>,
  Pick<WindowTargeting, 'resolveAppWindowId' | 'resolveRecaptureWindowTarget' | 'listComputerApps'>,
  Pick<CaptureEngine, 'captureScreenshot' | 'captureZoom' | 'captureComputer' | 'captureAfterAction'>,
  WindowReads,
  InputResolution {
  isObserveOnly(): boolean;
  recordDiagnostic?: (sessionId: string, record: Record<string, unknown>) => void;
  policy?: ComputerExecutionPolicy;
  runBoundedSequence(command: ComputerCommand): Promise<ComputerCommandResult>;
}

export function createCommandRouter(host: CommandRouterHost) {
  const policy = host.policy || createComputerExecutionPolicy();
  const dispatchInput = createInputDispatch(host, policy);
  const {
    sessionIdFor,
    framesBySession,
    elementTargetsBySession,
    observedWindowBySession,
    lastCaptureBySession,
    rememberObservedWindowScope,
    freshObservedWindowScope,
    invalidateActionTargets,
    normalizeElementRecords,
    rememberElementTargets,
    resolveElementAliases,
    executionContext,
    sessionRecoveryBySession,
    assertExecutionNotAborted,
    claimComputerTargets,
    releaseComputerSession,
    diagnoseComputer,
    verifyWindowState,
    resolveAppWindowId,
    resolveRecaptureWindowTarget,
    listComputerApps,
    captureScreenshot,
    captureZoom,
    captureComputer,
    captureAfterAction,
    readComputerWindows,
    readInputRecovery,
    resolveInputTarget,
    verifyInputRecovery,
    settleWindowTransition,
    isObserveOnly,
    runBoundedSequence,
  } = host;

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

  async function recaptureRequiredReply(
    command: ComputerCommand,
    error: unknown,
  ): Promise<ComputerCommandResult | null> {
    if (!recaptureRequirementCode(error)) return null;
    invalidateActionTargets(command);
    const recaptureTarget = await resolveRecaptureWindowTarget(
      command,
      freshObservedWindowScope(command)?.primaryWindowId || '',
    );
    const windowId = recaptureTarget.windowId;
    const capture = windowId
      ? await captureAfterAction(command, windowId, 0, 0)
      : {
          metadata: {
            ok: false,
            action: 'capture',
            error: recaptureTarget.error || 'exact target window is unavailable for recapture',
          },
        };
    const recaptureSucceeded = isFreshRecaptureObservation(capture.metadata, windowId);
    if (!recaptureSucceeded) invalidateActionTargets(command);
    const payload = buildRecaptureRequiredPayload(
      String(command.action || 'computer'),
      error,
      capture.metadata,
      windowId,
    );
    if (!payload) return null;
    return {
      text: JSON.stringify(payload),
      ...(recaptureSucceeded && 'image' in capture && capture.image
        ? { image: capture.image }
        : {}),
    };
  }

  function pixelUnavailableReply(
    action: string,
    pixelUnavailable: unknown,
  ): ComputerCommandResult {
    return {
      text: JSON.stringify({
        ok: false,
        action,
        code: 'pixel_unavailable',
        pixel_status: 'unavailable',
        pixel_unavailable: pixelUnavailable,
        escalation: 'recapture',
      }),
    };
  }

  async function runCommand(command: ComputerCommand): Promise<ComputerCommandResult> {
    const commandStartedAt = performance.now();
    const actionTimings: Record<string, number> = {};
    const trustedSequenceContinuation = isTrustedSequenceContinuation(command);
    const sequenceStep = isSequenceStep(command);
    const action = String(command.action || '').trim();
    if (!action) throw new Error('computer command requires action');
    if (process.platform !== 'win32') {
      throw new Error('computer use is currently supported on Windows only');
    }
    assertSafeComputerSessionId(command);
    // Checked before every early return, so a bounded sequence cannot slip past
    // it. The app's own Browser Use setup flow keeps its internal session.
    if (isObserveOnly()
      && !OBSERVE_ONLY_ALLOWED_ACTIONS.has(action)
      && sessionIdFor(command) !== CHROME_SETUP_SESSION_ID) {
      throw new Error(`observation_only: Computer Use is observing only, so '${action}' input is blocked. Turn off "Observation only" in Settings to allow input.`);
    }
    if (action === 'sequence' && command.read_only) {
      throw new Error("read_only run: 'sequence' is a mutation");
    }
    if (action === 'execution_end') {
      computerUseCoordinator.endExecution(sessionIdFor(command));
      return { text: 'computer execution ended' };
    }
    if (action === 'session_release') return await releaseComputerSession(command);
    assertSafeComputerInput(command);
    if (sessionIdFor(command) !== CHROME_SETUP_SESSION_ID) {
      policy.assertAction(command);
      if (policy.restricted && command.window_id) {
        policy.assertWindow(command, await readComputerWindows(command));
        assertExecutionNotAborted();
      }
    }
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
    const isMutation = !READ_ACTIONS.has(action);
    const shouldCaptureAfter = isMutation
      && !captureAfterSuppressed(command)
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
    assertSafeComputerTargetTokens(command);
    const semanticTargetIdentity = command.ref
      ? lastCaptureBySession.get(sessionIdFor(command))?.refIdentities.get(command.ref)
      : undefined;
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
        return pixelUnavailableReply('screenshot', screenshot.pixelUnavailable);
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
        return pixelUnavailableReply('zoom', zoom.pixelUnavailable);
      }
      if (!zoom.image || !zoom.frameId) throw new Error('zoom capture returned incomplete state');
      return frameReply(command, zoom.description, zoom.image, zoom.frameId);
    }
    const inputTarget = await resolveInputTarget(command, action, trustedSequenceContinuation);
    let {
      cursorX,
      cursorY,
      cursorToX,
      cursorToY,
      targetWindowId,
      observedScope,
    } = inputTarget;
    const logicalTargetWindowId = observedScope?.primaryWindowId || targetWindowId;
    const batchSequenceStep = sequenceStep && canBatchSequenceInput(command, targetWindowId);
    if (policy.restricted && targetWindowId && sessionIdFor(command) !== CHROME_SETUP_SESSION_ID) {
      policy.assertWindow({ ...command, window_id: targetWindowId }, await readComputerWindows(command));
      assertExecutionNotAborted();
    }
    if (isMutation) await claimComputerTargets(command, [logicalTargetWindowId, targetWindowId]);
    if (command.delivery === 'foreground' && POINTER_ACTIONS.includes(action)) {
      const feedback = await prepareCursorFeedback(sessionIdFor(command));
      host.recordDiagnostic?.(sessionIdFor(command), {
        action, stage: 'cursor_preparation', code: feedback, ok: feedback === 'ready',
      });
      assertExecutionNotAborted();
    }
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
    let windowsBefore = isMutation && !batchSequenceStep ? await readComputerWindows(command) : null;
    if (isMutation && !batchSequenceStep) actionTimings.before_windows_ms = elapsedMs(beforeWindowsStartedAt);
    const cursorEffect = action === 'double_click'
      ? 'double_click'
      : action === 'drag'
        ? 'drag'
        : action === 'scroll'
          ? 'scroll'
          : action === 'type' || action === 'key'
            ? 'type'
            : action === 'mouse_move'
              ? 'move'
              : 'click';
    if ((action === 'key' || action === 'type') && cursorX === undefined) {
      const previousCursor = computerUseCoordinator.snapshot().cursors.find(cursor => cursor.sessionId === sessionIdFor(command));
      cursorX = previousCursor?.x;
      cursorY = previousCursor?.y;
    }
    const cursorInput = POINTER_ACTIONS.includes(action) && cursorX !== undefined && cursorY !== undefined ? {
        sessionId: sessionIdFor(command),
        x: cursorX,
        y: cursorY,
        ...(cursorToX !== undefined && cursorToY !== undefined
          ? { toX: cursorToX, toY: cursorToY }
          : {}),
        action,
        effect: cursorEffect as 'click' | 'double_click' | 'drag' | 'scroll' | 'type' | 'move',
        ...(['up', 'down', 'left', 'right'].includes(String(command.direction || ''))
          ? { direction: command.direction as 'up' | 'down' | 'left' | 'right' }
          : {}),
        mode: command.delivery === 'foreground' ? 'foreground' as const : 'background' as const,
      } : undefined;
    let response: PowerShellResponse;
    const deliveryStartedAt = performance.now();
    try {
      response = await dispatchInput(command, action, inputTarget, batchSequenceStep);
      if (cursorInput && action !== 'drag' && command.delivery !== 'foreground'
        && response.ok && response.result?.delivery_accepted === true) {
        computerUseCoordinator.showCursor(cursorInput);
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
    const nativeStep = batchSequenceStep
      ? readSequenceStep(response.result, String(logicalTargetWindowId || ''), actionTimings.delivery_ms)
      : undefined;
    if (nativeStep) {
      windowsBefore = nativeStep.before;
      Object.assign(actionTimings, nativeStep.timings);
    }
    const result = nativeStep?.result || response.result || {};
    const targetWindowBefore = windowsBefore?.find((window) => window.id === targetWindowId);
    if (action === 'list_windows' && Array.isArray(result.windows)) {
      const windows = filterComputerUseInternalWindows(result.windows);
      result.windows = windows;
      result.text = filterComputerUseWindowListText(result.text, windows);
    }
    const inputRecoveryVerification = inputRecovery
      ? await verifyInputRecovery(command, targetWindowId, inputRecovery, actionTimings, result)
      : undefined;
    if (inputRecoveryVerification?.ok === false) {
      const reason = inputRecoveryVerification.user_control === true ? 'user_input_active'
        : String(inputRecoveryVerification.code || 'input_recovery_unconfirmed');
      const active = host.executionContext.getStore();
      if (active) active.failureCode = reason;
      host.recordDiagnostic?.(sessionIdFor(command), {
        action, stage: 'input_recovery', ok: false, code: reason,
        native_result: result,
        window_id: targetWindowId, input_recovery: inputRecoveryVerification,
        timings_ms: actionTimings,
      });
      host.takeOverComputer(reason);
      return { text: JSON.stringify({
        ok: false, action, window_id: targetWindowId, code: reason,
        effect: 'unverifiable', verified: false,
        input_recovery: inputRecoveryVerification,
        native_result: {
          code: result.code, path: result.path, effect: result.effect,
          delivery_accepted: result.delivery_accepted,
          cursor_feedback: result.cursor_feedback,
        },
        verdict: { decision: 'escalate', recommended: 'user_resume' },
        capture_skipped: 'user_control_active',
      }) };
    }
    if (action === 'snapshot' || action === 'find') {
      rememberElementTargets(command, normalizeElementRecords(result.elements));
      const observedWindowId = String(result.window_id || command.window_id || '');
      if (observedWindowId) {
        rememberObservedWindowScope(command, observedWindowId);
      }
    }
    let windowTransition: ComputerWindowTransition | null = null;
    let settleDelayMs = 0;
    if (nativeStep) {
      windowTransition = nativeStep.transition;
      settleDelayMs = nativeStep.settleDelayMs;
    } else if (isMutation) {
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
      if (policy.restricted && sessionIdFor(command) !== CHROME_SETUP_SESSION_ID) {
        policy.assertWindow(
          { ...command, window_id: windowTransition.next_target.id },
          await readComputerWindows(command),
        );
      }
      await claimComputerTargets(command, [windowTransition.next_target.id]);
    }
    if (action === 'focus_window' && inputRecovery && result.verified === true && !result.code) {
      sessionRecoveryBySession.set(sessionIdFor(command), inputRecovery);
    }
    return await buildActionReply(captureAfterAction, {
      command, action, result, isMutation, targetWindowId, logicalTargetWindowId,
      targetWindowBefore, windowTransition, inputRecoveryVerification, semanticTargetIdentity,
      settleDelayMs, commandStartedAt, actionTimings,
    });
  }

  return { runCommand, recaptureRequiredReply };
}

export type CommandRouter = ReturnType<typeof createCommandRouter>;
