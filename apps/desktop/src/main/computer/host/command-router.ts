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
import { electronWindowForNativeId } from '../observation/window-handles';
import { persistFrameImage } from '../../frame-files';
import {
  assertSafeComputerInput,
  assertSafeComputerSessionId,
  assertSafeComputerTargetTokens,
} from '../input/guards';
import { normalizeComputerKeySequence } from '../input/keyboard';
import { assertExactWindowCommandTarget } from '../input/targeting';
import type { createWindowTargeting } from '../input/targeting';
import {
  buildRecaptureRequiredPayload,
  isFreshRecaptureObservation,
  recaptureRequirementCode,
} from '../observation/recapture';
import {
  assertCaptureAfterOptions,
  captureAfterImageIsRedundant,
  recommendedRecovery,
  transitionConfirmsSemanticAction,
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
import { captureAfterSuppressed, isTrustedSequenceContinuation } from './sequence-runner';

const MENU_ACTION_TIMEOUT_MS = 3_000;
const POINTER_ACTIONS = [
  'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'mouse_move', 'drag', 'scroll', 'type',
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
  Pick<SessionLifecycle, 'claimComputerTargets' | 'releaseComputerSession'>,
  Pick<Inspection, 'diagnoseComputer' | 'verifyWindowState'>,
  Pick<WindowTargeting, 'resolveAppWindowId' | 'resolveRecaptureWindowTarget' | 'listComputerApps'>,
  Pick<CaptureEngine, 'captureScreenshot' | 'captureZoom' | 'captureComputer' | 'captureAfterAction'>,
  WindowReads,
  InputResolution {
  isObserveOnly(): boolean;
  runBoundedSequence(command: ComputerCommand): Promise<ComputerCommandResult>;
}

export function createCommandRouter(host: CommandRouterHost) {
  const {
    callPowerShell,
    callPowerShellElevated,
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
    readWindowIntegrity,
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
    const {
      physicalX,
      physicalY,
      physicalToX,
      physicalToY,
      cursorX,
      cursorY,
      cursorToX,
      cursorToY,
      targetWindowId,
      allowedWindowIds,
      observedScope,
    } = await resolveInputTarget(command, action, trustedSequenceContinuation);
    const logicalTargetWindowId = observedScope?.primaryWindowId || targetWindowId;
    if (isMutation) await claimComputerTargets(command, [logicalTargetWindowId, targetWindowId]);
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
    const cursorEffect = action === 'double_click'
      ? 'double_click'
      : action === 'drag'
        ? 'drag'
        : action === 'scroll'
          ? 'scroll'
          : action === 'type'
            ? 'type'
            : action === 'mouse_move'
              ? 'move'
              : 'click';
    if (POINTER_ACTIONS.includes(action) && cursorX !== undefined && cursorY !== undefined) {
      computerUseCoordinator.showCursor({
        sessionId: sessionIdFor(command),
        x: cursorX,
        y: cursorY,
        ...(cursorToX !== undefined && cursorToY !== undefined
          ? { toX: cursorToX, toY: cursorToY }
          : {}),
        action,
        effect: cursorEffect,
        ...(['up', 'down', 'left', 'right'].includes(String(command.direction || ''))
          ? { direction: command.direction as 'up' | 'down' | 'left' | 'right' }
          : {}),
        mode: command.delivery === 'foreground' ? 'foreground' : 'background',
      });
    }
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
          keys: action === 'key'
            ? normalizeComputerKeySequence(String(command.keys || ''))
            : command.keys ?? null,
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
          known_injection_tick: command.known_injection_tick ?? null,
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
          : await callPowerShell(
              powerShellRequest,
              action === 'invoke_menu' ? MENU_ACTION_TIMEOUT_MS : undefined,
            );
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
    if (action === 'list_windows' && Array.isArray(result.windows)) {
      const windows = filterComputerUseInternalWindows(result.windows);
      result.windows = windows;
      result.text = filterComputerUseWindowListText(result.text, windows);
    }
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
      await claimComputerTargets(command, [windowTransition.next_target.id]);
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

  return { runCommand, recaptureRequiredReply };
}

export type CommandRouter = ReturnType<typeof createCommandRouter>;
