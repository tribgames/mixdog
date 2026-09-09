/** Interpret delivery evidence and attach its observation without rerunning input. */
import { elapsedMs } from '../shared/common';
import { captureAfterImageIsRedundant, recommendedRecovery, transitionConfirmsSemanticAction } from '../observation/analysis';
import type { ComputerCommand, ComputerCommandResult, PowerShellResponse } from '../shared/types';
import type { ComputerWindowRecord, ComputerWindowTransition } from '../shared/window-transition';
import type { CommandRouterHost } from './command-router';
import { computerCursorFeedback } from '../shared/cursor-feedback';

export async function buildActionReply(
  captureAfterAction: CommandRouterHost['captureAfterAction'],
  context: {
    command: ComputerCommand; action: string; result: NonNullable<PowerShellResponse['result']>;
    isMutation: boolean; targetWindowId?: string; logicalTargetWindowId?: string;
    targetWindowBefore?: ComputerWindowRecord; windowTransition: ComputerWindowTransition | null;
    inputRecoveryVerification?: Record<string, unknown>; semanticTargetIdentity?: string;
    settleDelayMs: number; commandStartedAt: number; actionTimings: Record<string, number>;
  },
): Promise<ComputerCommandResult> {
  const { command, action, result, isMutation, targetWindowId, logicalTargetWindowId,
    targetWindowBefore, windowTransition, inputRecoveryVerification, semanticTargetIdentity,
    settleDelayMs, commandStartedAt, actionTimings } = context;
  if (result.action) {
    const transitionVerified = transitionConfirmsSemanticAction(
      action, result, windowTransition, String(logicalTargetWindowId || result.window_id || ''), String(command.app || ''),
    );
    const effect = transitionVerified ? 'confirmed' : typeof result.effect === 'string' ? result.effect : 'unverifiable';
    const verified = result.verified === true || transitionVerified;
    const code = typeof result.code === 'string' && result.code
      ? result.code : inputRecoveryVerification?.ok === false ? 'input_recovery_unconfirmed' : undefined;
    const delivery = String(result.delivery || command.delivery || 'background');
    const recommendation = recommendedRecovery(action, effect, code, delivery, windowTransition, targetWindowBefore);
    const escalation = inputRecoveryVerification?.ok === false ? 'input_recovery' : recommendation;
    const verdict: Record<string, unknown> = result.goal_verified === true || verified
      ? { decision: 'done' } : effect === 'suspected_noop' || code ? { decision: 'escalate' } : { decision: 'verify_fresh_state' };
    if (escalation) verdict.recommended = escalation;
    if (inputRecoveryVerification?.ok === false) verdict.decision = 'escalate';
    const cursorFeedback = computerCursorFeedback(result.cursor_feedback);
    const payload: Record<string, unknown> = {
      ok: !code, action: result.action, message: String(result.text || ''), effect, verified,
      delivery_accepted: typeof result.delivery_accepted === 'boolean' ? result.delivery_accepted : null,
      goal_verified: result.goal_verified === true || verified,
      ...(result.input_may_have_executed === true ? { input_may_have_executed: true } : {}),
      path: result.path || 'unknown', delivery,
      ...(cursorFeedback ? { cursor_feedback: cursorFeedback } : {}),
      ...(transitionVerified ? { verification_source: 'window_transition' } : {}),
      ...(typeof result.state_changed === 'boolean' ? { state_changed: result.state_changed } : {}),
      ...(logicalTargetWindowId || result.window_id ? { window_id: String(logicalTargetWindowId || result.window_id) } : {}),
      ...(result.window_id && logicalTargetWindowId && result.window_id !== logicalTargetWindowId
        ? { input_surface_window_id: result.window_id } : {}),
      ...(Number.isInteger(Number(result.pid)) ? { pid: Number(result.pid) } : {}),
      ...(result.app_hint ? { app_hint: String(result.app_hint) } : {}),
      ...(code ? { code } : {}), ...(windowTransition ? { window_transition: windowTransition } : {}),
      ...(inputRecoveryVerification ? { input_recovery: inputRecoveryVerification } : {}),
      ...(escalation ? { escalation } : {}), verdict,
    };
    let image: { mimeType: string; data: string } | undefined;
    if (command.capture_after) {
      const originalWindowId = String(logicalTargetWindowId || result.window_id || '');
      const targetClosed = action === 'close_window' && result.verified === true
        && windowTransition?.closed_windows.some((window) => window.id === originalWindowId);
      if (targetClosed) {
        payload.capture_after = { ok: true, action: 'capture', skipped: true, window_id: originalWindowId, target_reason: 'target_closed' };
      } else {
        const captureWindowId = windowTransition?.next_target?.id || originalWindowId;
        const postCaptureStartedAt = performance.now();
        const capture = await captureAfterAction(command, captureWindowId, 0, settleDelayMs);
        actionTimings.post_capture_ms = elapsedMs(postCaptureStartedAt);
        payload.capture_after = {
          ...capture.metadata,
          target_reason: capture.metadata.capture_target_reason || windowTransition?.next_target_reason || 'original_target',
          ...(originalWindowId && captureWindowId !== originalWindowId ? { previous_window_id: originalWindowId } : {}),
        };
        if (capture.metadata.pixel_status === 'unavailable') {
          verdict.decision = 'escalate';
          verdict.recommended = 'recapture';
          payload.escalation = 'recapture';
        }
        if (capture.image && captureAfterImageIsRedundant(command, capture.metadata, semanticTargetIdentity)) {
          (payload.capture_after as Record<string, unknown>).image_omitted = 'semantic_change_reported';
        } else {
          image = capture.image;
        }
      }
    }
    actionTimings.total_ms = elapsedMs(commandStartedAt);
    payload.timings_ms = actionTimings;
    return { text: JSON.stringify(payload), ...(image ? { image } : {}) };
  }
  const text = String(result.text || 'OK');
  if (command.capture_after) {
    const originalWindowId = String(targetWindowId || '');
    const captureWindowId = windowTransition?.next_target?.id || originalWindowId;
    const postCaptureStartedAt = performance.now();
    const capture = await captureAfterAction(command, captureWindowId, 0, settleDelayMs);
    actionTimings.post_capture_ms = elapsedMs(postCaptureStartedAt);
    const recommendation = recommendedRecovery(
      action, 'unverifiable', undefined, command.delivery || 'background', windowTransition, targetWindowBefore,
    );
    const escalation = capture.metadata.pixel_status === 'unavailable' ? 'recapture' : recommendation;
    return {
      text: JSON.stringify({
        ok: true, action, message: text, goal_verified: false,
        ...(windowTransition ? { window_transition: windowTransition } : {}),
        verdict: { decision: 'verify_fresh_state', ...(escalation ? { recommended: escalation } : {}) },
        ...(escalation ? { escalation } : {}),
        timings_ms: { ...actionTimings, total_ms: elapsedMs(commandStartedAt) },
        capture_after: {
          ...capture.metadata, target_reason: windowTransition?.next_target_reason || 'original_target',
          ...(originalWindowId && captureWindowId !== originalWindowId ? { previous_window_id: originalWindowId } : {}),
        },
      }),
      ...(capture.image ? { image: capture.image } : {}),
    };
  }
  if (isMutation) {
    const recommendation = recommendedRecovery(
      action, 'unverifiable', undefined, command.delivery || 'background', windowTransition, targetWindowBefore,
    );
    return {
      text: JSON.stringify({
        ok: true, action, message: text, goal_verified: false,
        ...(windowTransition ? { window_transition: windowTransition } : {}),
        verdict: { decision: 'verify_fresh_state', ...(recommendation ? { recommended: recommendation } : {}) },
        ...(recommendation ? { escalation: recommendation } : {}),
        timings_ms: { ...actionTimings, total_ms: elapsedMs(commandStartedAt) },
      }),
    };
  }
  return { text };
}
