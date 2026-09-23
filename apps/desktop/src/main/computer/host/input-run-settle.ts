/**
 * What the backend's answer means: a batched sequence step unpacks its own
 * before/after evidence, list_windows hides the app's internal windows, a
 * foreground delivery whose input recovery cannot be confirmed hands the
 * desktop back to the user, semantic reads refresh the element targets, and a
 * mutation's window transition decides which window the reply observes.
 */
import { filterComputerUseInternalWindows, filterComputerUseWindowListText } from '../overlay/internal-windows';
import { CHROME_SETUP_SESSION_ID } from '../session/chrome-setup';
import { computerUseCoordinator } from '../session/coordinator';
import type { ComputerCommand, ComputerCommandResult, PowerShellResponse } from '../shared/types';
import type { ComputerWindowRecord, ComputerWindowTransition } from '../shared/window-transition';
import { buildActionReply } from './action-reply';
import type { CommandRouterHost } from './command-router';
import type { ComputerExecutionPolicy } from './execution-policy';
import type { InputRunContext, PreparedInputRun } from './input-run-prepare';
import { readSequenceStep } from './sequence-dispatch';

export type InputRunSettleHost = Pick<
  CommandRouterHost,
  | 'sessionIdFor'
  | 'executionContext'
  | 'sessionRecoveryBySession'
  | 'sequenceCursorAnchor'
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

/** Input recovery could not be confirmed: the desktop goes back to the user
 *  and the reply says why, with the native evidence the verdict rests on. */
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
  const active = host.executionContext.getStore();
  if (active) active.failureCode = reason;
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
  host.takeOverComputer(reason);
  return {
    text: JSON.stringify({
      ok: false,
      action,
      window_id: targetWindowId,
      code: reason,
      effect: 'unverifiable',
      verified: false,
      input_recovery: verification,
      native_result: {
        code: result.code,
        path: result.path,
        effect: result.effect,
        delivery_accepted: result.delivery_accepted,
        cursor_feedback: result.cursor_feedback,
      },
      verdict: { decision: 'escalate', recommended: 'user_resume' },
      capture_skipped: 'user_control_active',
    }),
  };
}

/**
 * Name the keys of a chord for the board. Plus separates them, so an empty
 * piece is the plus character itself: that is what `+` and `ctrl++` are made
 * of, and dropping it would leave the board with nothing to light.
 */
function boardKeysOf(sequence: string): string[] {
  const parts = sequence.trim().split('+');
  const names = parts.map((part, index) => part.trim() || (index > 0 ? '+' : ''));
  return [...new Set(names.filter(Boolean))];
}

/**
 * Put a keystroke on the typing board. `key` names the keys it pressed and they
 * can be shown; `type` carries the text itself, which is never echoed, so it
 * reports only that typing is happening. A native reply that does not vouch for
 * the focused field is treated as masked.
 */
function showKeystrokeFeedback(
  sessionId: string,
  action: string,
  command: ComputerCommand,
  result: NativeResult
): void {
  if (action !== 'key' && action !== 'type') return;
  const feedback = result.cursor_feedback as { focus_masked?: boolean } | undefined;
  const masked = feedback?.focus_masked !== false;
  const keys = action === 'key' && !masked ? boardKeysOf(String(command.keys || '')) : ['space'];
  try {
    computerUseCoordinator.showKeystroke({ sessionId, keys, masked: masked || action === 'type' });
  } catch {
    // Feedback never decides an action's outcome.
  }
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
  showKeystrokeFeedback(host.sessionIdFor(command), action, command, result);
  if (action === 'list_windows' && Array.isArray(result.windows)) {
    const windows = filterComputerUseInternalWindows(result.windows);
    result.windows = windows;
    result.text = filterComputerUseWindowListText(result.text, windows);
  }
  // The first step of a sequence owns the pointer position the user left behind.
  // Later steps restore against that same anchor rather than wherever their
  // predecessor stopped, and only the closing step hands the cursor back.
  const holdCursor = command.input_continues === true;
  const anchorKey = host.sessionIdFor(command);
  let recoveryBaseline = inputRecovery;
  if (inputRecovery) {
    const anchored = host.sequenceCursorAnchor.get(anchorKey);
    if (anchored) recoveryBaseline = { ...inputRecovery, cursorX: anchored.cursorX, cursorY: anchored.cursorY };
    else if (holdCursor) host.sequenceCursorAnchor.set(anchorKey, inputRecovery);
    if (!holdCursor) host.sequenceCursorAnchor.delete(anchorKey);
  }
  const inputRecoveryVerification = recoveryBaseline
    ? await host.verifyInputRecovery(command, targetWindowId, recoveryBaseline, actionTimings, result, holdCursor)
    : undefined;
  if (inputRecoveryVerification?.ok === false) {
    return inputRecoveryFailureReply(host, run, targetWindowId, result, inputRecoveryVerification);
  }
  if (action === 'snapshot' || action === 'find') {
    host.rememberElementTargets(command, host.normalizeElementRecords(result.elements));
    const observedWindowId = String(result.window_id || command.window_id || '');
    if (observedWindowId) {
      host.rememberObservedWindowScope(command, observedWindowId);
    }
  }
  const { transition: windowTransition, settleDelayMs } = await resolveWindowTransition(
    host,
    run,
    logicalTargetWindowId,
    nativeStep,
    result,
    windowsBefore
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
  if (action === 'focus_window' && inputRecovery && result.verified === true && !result.code) {
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
    inputRecoveryVerification,
    semanticTargetIdentity,
    settleDelayMs,
    commandStartedAt,
    actionTimings,
  });
}
