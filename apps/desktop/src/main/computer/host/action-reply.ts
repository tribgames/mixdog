/** Interpret delivery evidence and attach its observation without rerunning input. */
import { elapsedMs } from '../shared/common';
import {
  captureAfterImageIsRedundant,
  recommendedRecovery,
  transitionConfirmsSemanticAction,
} from '../observation/analysis';
import type { ComputerCommand, ComputerCommandResult, PowerShellResponse } from '../shared/types';
import type { ComputerWindowTransition } from '../shared/window-transition';
import type { CommandRouterHost } from './command-router';
import { computerCursorFeedback } from '../shared/cursor-feedback';
import { classifyComputerSequenceObservation } from '../input/sequence';

/** Action delivery and the requested observation are separate obligations. */
function applyObservationOutcome(payload: Record<string, unknown>, metadata: Record<string, unknown>): void {
  const { unavailable, pixelUnavailable } = classifyComputerSequenceObservation(metadata);
  if (!unavailable) {
    if (pixelUnavailable) {
      const verdict = payload.verdict as Record<string, unknown>;
      if (verdict.decision !== 'done') verdict.recommended = 'use_semantic_target';
    }
    return;
  }
  payload.ok = false;
  payload.code ||= 'observation_unavailable';
  payload.goal_verified = false;
  payload.escalation = 'recapture';
  payload.verdict = { decision: 'escalate', recommended: 'recapture' };
}

type CaptureAfterAction = CommandRouterHost['captureAfterAction'];

interface ActionReplyContext {
  command: ComputerCommand;
  action: string;
  result: NonNullable<PowerShellResponse['result']>;
  isMutation: boolean;
  targetWindowId?: string;
  logicalTargetWindowId?: string;
  windowTransition: ComputerWindowTransition | null;
  inputRecoveryVerification?: Record<string, unknown>;
  semanticTargetIdentity?: string;
  settleDelayMs: number;
  commandStartedAt: number;
  actionTimings: Record<string, number>;
}

export async function buildActionReply(
  captureAfterAction: CaptureAfterAction,
  context: ActionReplyContext
): Promise<ComputerCommandResult> {
  const { command, result, isMutation, targetWindowId, windowTransition } = context;
  if (result.action) return semanticActionReply(captureAfterAction, context);
  const text = String(result.text || 'OK');
  if (command.capture_after) {
    const { capture, previousWindow } = await capturePostAction(
      captureAfterAction,
      context,
      String(targetWindowId || '')
    );
    const payload: Record<string, unknown> = {
      ...unverifiedPayload(context, text),
      capture_after: {
        ...capture.metadata,
        target_reason:
          capture.metadata.capture_target_reason || windowTransition?.next_target_reason || 'original_target',
        ...previousWindow,
      },
    };
    applyObservationOutcome(payload, capture.metadata);
    return {
      text: JSON.stringify(payload),
      ...(capture.image ? { image: capture.image } : {}),
    };
  }
  if (isMutation) return { text: JSON.stringify(unverifiedPayload(context, text)) };
  return { text };
}

/** The post-action observation of the transition's successor, else the original
 *  window; `previousWindow` names the original when the capture moved away. */
async function capturePostAction(
  captureAfterAction: CaptureAfterAction,
  context: ActionReplyContext,
  originalWindowId: string
) {
  const { command, windowTransition, settleDelayMs, actionTimings } = context;
  const captureWindowId = windowTransition?.next_target?.id || originalWindowId;
  const postCaptureStartedAt = performance.now();
  const capture = await captureAfterAction(command, captureWindowId, 0, settleDelayMs);
  actionTimings.post_capture_ms = elapsedMs(postCaptureStartedAt);
  const previousWindow =
    originalWindowId && captureWindowId !== originalWindowId ? { previous_window_id: originalWindowId } : {};
  return { capture, previousWindow };
}

// A reply the host could not verify: the caller re-observes before acting on it.
function unverifiedPayload(context: ActionReplyContext, text: string): Record<string, unknown> {
  const { command, action, windowTransition, actionTimings, commandStartedAt } = context;
  const recommendation = recommendedRecovery(
    'unverifiable',
    undefined,
    command.delivery || 'background',
    windowTransition
  );
  return {
    ok: true,
    action,
    message: text,
    goal_verified: false,
    ...(windowTransition ? { window_transition: windowTransition } : {}),
    verdict: { decision: 'verify_fresh_state', ...(recommendation ? { recommended: recommendation } : {}) },
    ...(recommendation ? { escalation: recommendation } : {}),
    timings_ms: { ...actionTimings, total_ms: elapsedMs(commandStartedAt) },
  };
}

function semanticVerdict(context: ActionReplyContext) {
  const { command, action, result, windowTransition, logicalTargetWindowId, inputRecoveryVerification } = context;
  const transitionVerified = transitionConfirmsSemanticAction(
    action,
    result,
    windowTransition,
    String(logicalTargetWindowId || result.window_id || ''),
    String(command.app || '')
  );
  let effect = 'unverifiable';
  if (transitionVerified) effect = 'confirmed';
  else if (typeof result.effect === 'string') effect = result.effect;
  const verified = result.verified === true || transitionVerified;
  let code: string | undefined;
  if (typeof result.code === 'string' && result.code) code = result.code;
  else if (inputRecoveryVerification?.ok === false) code = 'input_recovery_unconfirmed';
  const delivery = String(result.delivery || command.delivery || 'background');
  const recommendation = recommendedRecovery(effect, code, delivery, windowTransition);
  const escalation = inputRecoveryVerification?.ok === false ? 'input_recovery' : recommendation;
  let decision = 'verify_fresh_state';
  if (result.goal_verified === true || verified) decision = 'done';
  else if (effect === 'suspected_noop' || code) decision = 'escalate';
  const verdict: Record<string, unknown> = { decision };
  if (escalation) verdict.recommended = escalation;
  if (inputRecoveryVerification?.ok === false) verdict.decision = 'escalate';
  return { transitionVerified, effect, verified, code, delivery, escalation, verdict };
}

// capture_after for a semantic action: skipped when the target closed or a
// launch has no proven successor window, else the post-action observation.
// Returns the image to attach, if any; the payload gains `capture_after`.
async function captureAfterSemanticAction(
  captureAfterAction: CaptureAfterAction,
  context: ActionReplyContext,
  payload: Record<string, unknown>,
  code: string | undefined
): Promise<{ mimeType: string; data: string } | undefined> {
  const { command, action, result, windowTransition, logicalTargetWindowId, semanticTargetIdentity } = context;
  const originalWindowId = String(logicalTargetWindowId || result.window_id || '');
  const targetClosed =
    action === 'close_window' &&
    result.verified === true &&
    windowTransition?.closed_windows.some((window) => window.id === originalWindowId);
  const launchTargetUnresolved =
    action === 'launch' &&
    result.delivery_accepted === true &&
    !code &&
    !originalWindowId &&
    !windowTransition?.next_target;
  if (launchTargetUnresolved) {
    // Shell brokers can launch a different process (for example a packaged
    // app hosted by ApplicationFrameHost). No proven successor is not a
    // failed launch, and it never authorizes capturing the foreground app.
    payload.capture_after = {
      ok: true,
      action: 'capture',
      skipped: true,
      target_reason: 'launch_target_unresolved',
    };
    payload.verdict = { decision: 'verify_fresh_state', recommended: 'list_windows' };
    payload.message = `${payload.message}; the shell accepted the launch, but its window is unresolved. List windows and capture the exact target; do not launch again.`;
    return undefined;
  }
  if (targetClosed) {
    payload.capture_after = {
      ok: true,
      action: 'capture',
      skipped: true,
      window_id: originalWindowId,
      target_reason: 'target_closed',
    };
    return undefined;
  }
  const { capture, previousWindow } = await capturePostAction(captureAfterAction, context, originalWindowId);
  payload.capture_after = {
    ...capture.metadata,
    target_reason: capture.metadata.capture_target_reason || windowTransition?.next_target_reason || 'original_target',
    ...previousWindow,
  };
  applyObservationOutcome(payload, capture.metadata);
  if (capture.image && captureAfterImageIsRedundant(command, capture.metadata, semanticTargetIdentity)) {
    (payload.capture_after as Record<string, unknown>).image_omitted = 'semantic_change_reported';
    return undefined;
  }
  return capture.image;
}

async function semanticActionReply(
  captureAfterAction: CaptureAfterAction,
  context: ActionReplyContext
): Promise<ComputerCommandResult> {
  const { command, result, logicalTargetWindowId, windowTransition, inputRecoveryVerification } = context;
  const { commandStartedAt, actionTimings } = context;
  const { transitionVerified, effect, verified, code, delivery, escalation, verdict } = semanticVerdict(context);
  const cursorFeedback = computerCursorFeedback(result.cursor_feedback);
  const payload: Record<string, unknown> = {
    ok: !code,
    action: result.action,
    message: String(result.text || ''),
    effect,
    verified,
    delivery_accepted: typeof result.delivery_accepted === 'boolean' ? result.delivery_accepted : null,
    goal_verified: result.goal_verified === true || verified,
    ...(result.input_may_have_executed === true ? { input_may_have_executed: true } : {}),
    path: result.path || 'unknown',
    delivery,
    ...(cursorFeedback ? { cursor_feedback: cursorFeedback } : {}),
    ...(transitionVerified ? { verification_source: 'window_transition' } : {}),
    ...(typeof result.state_changed === 'boolean' ? { state_changed: result.state_changed } : {}),
    ...(logicalTargetWindowId || result.window_id
      ? { window_id: String(logicalTargetWindowId || result.window_id) }
      : {}),
    ...(result.window_id && logicalTargetWindowId && result.window_id !== logicalTargetWindowId
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
  const image = command.capture_after
    ? await captureAfterSemanticAction(captureAfterAction, context, payload, code)
    : undefined;
  actionTimings.total_ms = elapsedMs(commandStartedAt);
  payload.timings_ms = actionTimings;
  return { text: JSON.stringify(payload), ...(image ? { image } : {}) };
}
