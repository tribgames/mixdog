/**
 * What the backend's answer means: a batched sequence step unpacks its own
 * before/after evidence, list_windows hides the app's internal windows, a
 * foreground delivery whose input recovery cannot be confirmed hands the
 * desktop back to the user, semantic reads refresh the element targets, and a
 * mutation's window transition decides which window the reply observes.
 */
import { filterComputerUseInternalWindows, filterComputerUseWindowListText } from '../overlay/internal-windows';
import { CHROME_SETUP_SESSION_ID } from '../shared/common';
import type { ComputerCommandResult, PowerShellResponse } from '../shared/types';
import type { ComputerWindowRecord, ComputerWindowTransition } from '../shared/window-transition';
import { buildActionReply } from './action-reply';
import type { CommandRouterHost } from './command-router';
import { type ComputerExecutionPolicy, visibleWindowRecords } from './execution-policy';
import type { InputRecoveryState, SessionDesktopAnchor } from './execution-state';
import type { InputRunContext, PreparedInputRun } from './input-run-prepare';
import { readSequenceStep } from './sequence-dispatch';
import { nativeAnswerStandsAgainstUserInput, userInputRefusalPayload } from './user-input-refusal';

/**
 * The restore point once the user lets the agent go on after touching the
 * desktop: the window they switched to and their pointer there, or, when they
 * stayed on the session's own windows, the original restore point with only
 * its input baseline moved past their touch.
 */
function rebasedDesktopAnchor(anchor: SessionDesktopAnchor, current: InputRecoveryState): InputRecoveryState {
  const foreground = current.foregroundWindowId;
  const onSessionWindow =
    !foreground ||
    foreground === anchor.targetWindowId ||
    foreground === anchor.heldWindowId ||
    current.foregroundWithinTarget === true ||
    current.foregroundChildProcess === true;
  if (!onSessionWindow) return { ...current, restoreWindowId: foreground, restoreOwnerWindowId: '' };
  return {
    ...anchor.recovery,
    inputObserverReady: current.inputObserverReady,
    inputMonitorId: current.inputMonitorId,
    inputUserSequence: current.inputUserSequence,
  };
}

/**
 * The restore point of a session whose first foreground input finds another
 * agent session's window in front: what the user had when that session began,
 * never the other agent's window. Any other window in front is where the user
 * left the desktop. Input sequences cannot decide this: each session's worker
 * numbers the input it observes on its own.
 */
function borrowedDesktopRecovery(
  anchors: Map<string, SessionDesktopAnchor>,
  current: InputRecoveryState
): InputRecoveryState {
  const foreground = current.foregroundWindowId;
  if (!foreground) return current;
  for (const other of anchors.values()) {
    const otherWindows = [other.targetWindowId, other.heldWindowId, ...(other.handedWindowIds ?? [])];
    if (!other.userOwned && otherWindows.includes(foreground)) {
      return {
        ...current,
        restoreWindowId: other.recovery.restoreWindowId,
        restoreOwnerWindowId: other.recovery.restoreOwnerWindowId,
        cursorX: other.recovery.cursorX,
        cursorY: other.recovery.cursorY,
      };
    }
  }
  return current;
}

export type InputRunSettleHost = Pick<
  CommandRouterHost,
  | 'sessionIdFor'
  | 'executionContext'
  | 'sessionRecoveryBySession'
  | 'sessionDesktopAnchor'
  | 'claimComputerTargets'
  | 'readComputerWindows'
  | 'verifyInputRecovery'
  | 'settleWindowTransition'
  | 'captureAfterAction'
  | 'rememberElementTargets'
  | 'normalizeElementRecords'
  | 'rememberObservedWindowScope'
  | 'takeOverComputer'
  | 'recordDiagnostic'
  | 'windowArrivals'
>;

export interface InputRunSettleInput {
  run: InputRunContext;
  prepared: PreparedInputRun;
  response: PowerShellResponse;
  semanticTargetIdentity?: string;
  commandStartedAt: number;
}

type NativeResult = NonNullable<PowerShellResponse['result']>;
type RecoveryVerification = NonNullable<Awaited<ReturnType<InputRunSettleHost['verifyInputRecovery']>>>;
/** The transition a batched native step already observed for itself. */
type NativeStepTransition = { transition: ComputerWindowTransition; settleDelayMs: number } | undefined;

/** Input recovery could not be confirmed. The user's own input refuses only
 *  this action; anything else hands the desktop back to the user. The reply
 *  says why, with the native evidence the verdict rests on. */
function inputRecoveryFailureReply(
  host: InputRunSettleHost,
  run: InputRunContext,
  targetWindowId: string | undefined,
  result: NativeResult,
  verification: RecoveryVerification
): ComputerCommandResult {
  const { command, action, actionTimings } = run;
  const reason =
    verification.user_control === true
      ? 'user_input_active'
      : String(verification.code || 'input_recovery_unconfirmed');
  const userInput = reason === 'user_input_active';
  const active = host.executionContext.getStore();
  if (active && !userInput) active.failureCode = reason;
  host.recordDiagnostic?.(host.sessionIdFor(command), {
    action,
    stage: 'input_recovery',
    ok: false,
    code: reason,
    native_result: result,
    window_id: targetWindowId,
    input_recovery: verification,
    timings_ms: actionTimings,
  });
  const evidence = {
    input_recovery: verification,
    native_result: {
      code: result.code,
      path: result.path,
      effect: result.effect,
      delivery_accepted: result.delivery_accepted,
      cursor_feedback: result.cursor_feedback,
    },
  };
  if (userInput) {
    // The readback follows a dispatch, so the input may have landed.
    return { text: JSON.stringify(userInputRefusalPayload(action, targetWindowId, true, evidence)) };
  }
  host.takeOverComputer(reason);
  return {
    text: JSON.stringify({
      ok: false,
      action,
      window_id: targetWindowId,
      code: reason,
      effect: 'unverifiable',
      verified: false,
      ...evidence,
      verdict: { decision: 'escalate', recommended: 'wait_for_user' },
      capture_skipped: 'user_control_active',
    }),
  };
}

async function resolveWindowTransition(
  host: InputRunSettleHost,
  run: InputRunContext,
  logicalTargetWindowId: string | undefined,
  nativeStep: NativeStepTransition,
  result: NativeResult,
  windowsBefore: ComputerWindowRecord[] | null
): Promise<{ transition: ComputerWindowTransition | null; settleDelayMs: number }> {
  if (nativeStep) return { transition: nativeStep.transition, settleDelayMs: nativeStep.settleDelayMs };
  if (!run.isMutation) return { transition: null, settleDelayMs: 0 };
  const { command, action, actionTimings } = run;
  const settled = await host.settleWindowTransition({
    command,
    action,
    windowsBefore,
    targetWindowId: String(logicalTargetWindowId || result.window_id || ''),
    pid: Number(result.pid) || 0,
    appHint: action === 'launch' ? String(result.app_hint || command.app || '') : '',
    timings: actionTimings,
  });
  return { transition: settled.transition, settleDelayMs: settled.settleDelayMs };
}

export async function settleInputRun(
  host: InputRunSettleHost,
  policy: ComputerExecutionPolicy,
  input: InputRunSettleInput
): Promise<ComputerCommandResult> {
  const { run, prepared, response, semanticTargetIdentity, commandStartedAt } = input;
  const { command, action, isMutation, actionTimings } = run;
  const { targetWindowId, logicalTargetWindowId, batchSequenceStep, inputRecovery } = prepared;
  const nativeStep = batchSequenceStep
    ? readSequenceStep(response.result, String(logicalTargetWindowId || ''), actionTimings.delivery_ms)
    : undefined;
  let windowsBefore = prepared.windowsBefore;
  if (nativeStep) {
    windowsBefore = nativeStep.before;
    Object.assign(actionTimings, nativeStep.timings);
  }
  const result = nativeStep?.result || response.result || {};
  if (action === 'list_windows' && Array.isArray(result.windows)) {
    const windows = filterComputerUseInternalWindows(result.windows);
    result.windows = windows;
    result.text = filterComputerUseWindowListText(result.text, windows);
  }
  // The session's first foreground input records the user's focus and pointer,
  // or takes them over from an agent session that already has the desktop; they
  // come back once, when the last such session's turn ends. Between commands the
  // desktop stays where the agent left it. A user who touches it and lets the
  // agent go on moves that restore point instead of cancelling it.
  const anchorKey = host.sessionIdFor(command);
  let recoveryBaseline = inputRecovery;
  let anchor = host.sessionDesktopAnchor.get(anchorKey);
  if (inputRecovery) {
    if (!anchor) {
      anchor = {
        recovery: borrowedDesktopRecovery(host.sessionDesktopAnchor, inputRecovery),
        targetWindowId: String(targetWindowId || ''),
        userOwned: false,
      };
      host.sessionDesktopAnchor.set(anchorKey, anchor);
      recoveryBaseline = {
        ...inputRecovery,
        restoreWindowId: anchor.recovery.restoreWindowId,
        restoreOwnerWindowId: anchor.recovery.restoreOwnerWindowId,
      };
    } else {
      if (
        anchor.userOwned ||
        anchor.recovery.inputMonitorId !== inputRecovery.inputMonitorId ||
        anchor.recovery.inputUserSequence !== inputRecovery.inputUserSequence
      ) {
        anchor.recovery = rebasedDesktopAnchor(anchor, inputRecovery);
        anchor.userOwned = false;
      }
      anchor.targetWindowId = String(targetWindowId || '');
      recoveryBaseline = {
        ...inputRecovery,
        restoreWindowId: anchor.recovery.restoreWindowId,
        restoreOwnerWindowId: anchor.recovery.restoreOwnerWindowId,
      };
    }
  }
  const inputRecoveryVerification =
    recoveryBaseline && !anchor?.userOwned
      ? await host.verifyInputRecovery(command, targetWindowId, recoveryBaseline, actionTimings, result, true)
      : undefined;
  const userTookControl = inputRecoveryVerification?.user_control === true;
  if (userTookControl && anchor) anchor.userOwned = true;
  if (anchor && typeof inputRecoveryVerification?.actual_focus_window_id === 'string') {
    anchor.heldWindowId = inputRecoveryVerification.actual_focus_window_id;
  }
  // Restoration was skipped because the user owns focus and pointer; when the
  // native result says nothing was sent, it is the reply, marked as such.
  let recoveryReport = inputRecoveryVerification;
  if (inputRecoveryVerification?.ok === false) {
    if (!userTookControl || !nativeAnswerStandsAgainstUserInput(result)) {
      return inputRecoveryFailureReply(host, run, targetWindowId, result, inputRecoveryVerification);
    }
    recoveryReport = { recovery_skipped: true, user_control: true };
  }
  if (action === 'snapshot' || action === 'find') {
    host.rememberElementTargets(command, host.normalizeElementRecords(result.elements));
    const observedWindowId = String(result.window_id || command.window_id || '');
    if (observedWindowId) {
      host.rememberObservedWindowScope(command, observedWindowId);
    }
  }
  const { transition: observedTransition, settleDelayMs } = await resolveWindowTransition(
    host,
    run,
    logicalTargetWindowId,
    nativeStep,
    result,
    windowsBefore
  );
  // A restricted session's reply carries only the window records it may
  // capture; the successor is authorized on its own below.
  const restrictedReply = policy.restricted && host.sessionIdFor(command) !== CHROME_SETUP_SESSION_ID;
  const windowTransition =
    observedTransition && restrictedReply
      ? {
          ...observedTransition,
          opened_windows: visibleWindowRecords(policy, command, observedTransition.opened_windows),
          closed_windows: visibleWindowRecords(policy, command, observedTransition.closed_windows),
          changed_windows: visibleWindowRecords(policy, command, observedTransition.changed_windows),
        }
      : observedTransition;
  // The reply names these, so the session's next command does not again.
  host.windowArrivals?.noteSettled(
    command,
    windowsBefore,
    (windowTransition?.opened_windows || []).map((window) => window.id)
  );
  if (isMutation && windowTransition?.next_target?.id) {
    if (policy.restricted && host.sessionIdFor(command) !== CHROME_SETUP_SESSION_ID) {
      policy.assertWindow(
        { ...command, window_id: windowTransition.next_target.id },
        await host.readComputerWindows(command)
      );
    }
    await host.claimComputerTargets(command, [windowTransition.next_target.id]);
  }
  if (action === 'focus_window' && inputRecovery && result.verified === true && !result.code && !userTookControl) {
    host.sessionRecoveryBySession.set(host.sessionIdFor(command), inputRecovery);
  }
  return await buildActionReply(host.captureAfterAction, {
    command,
    action,
    result,
    isMutation,
    targetWindowId,
    logicalTargetWindowId,
    windowTransition,
    inputRecoveryVerification: recoveryReport,
    semanticTargetIdentity,
    settleDelayMs,
    commandStartedAt,
    actionTimings,
  });
}
