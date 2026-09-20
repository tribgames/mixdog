/**
 * Everything an input action needs settled before it is delivered: the exact
 * target window and its observed scope, the policy's view of that window,
 * ownership of the targets a mutation will touch, cursor feedback for pointer
 * actions, the input-recovery baseline for foreground delivery, and the
 * window list a transition is judged against.
 */
import { prepareCursorFeedback } from '../overlay/cursor-readiness';
import { CHROME_SETUP_SESSION_ID } from '../session/chrome-setup';
import { elapsedMs } from '../shared/common';
import type { ComputerCommand } from '../shared/types';
import type { ComputerWindowRecord } from '../shared/window-transition';
import type { CommandRouterHost } from './command-router';
import type { ComputerExecutionPolicy } from './execution-policy';
import type { InputRecoveryState } from './execution-state';
import type { ResolvedInputTarget } from './input-resolution';
import { canBatchSequenceInput } from './sequence-dispatch';

export type InputRunPrepareHost = Pick<
  CommandRouterHost,
  | 'sessionIdFor'
  | 'executionContext'
  | 'assertExecutionNotAborted'
  | 'claimComputerTargets'
  | 'readComputerWindows'
  | 'readInputRecovery'
  | 'resolveInputTarget'
  | 'recordDiagnostic'
>;

export interface InputRunContext {
  command: ComputerCommand;
  action: string;
  isMutation: boolean;
  /** A step of a running sequence the host already vetted. */
  trustedSequenceContinuation: boolean;
  sequenceStep: boolean;
  pointerAction: boolean;
  actionTimings: Record<string, number>;
}

export interface PreparedInputRun {
  inputTarget: ResolvedInputTarget;
  targetWindowId: string | undefined;
  /** The observed scope's primary window when the target belongs to one. */
  logicalTargetWindowId: string | undefined;
  batchSequenceStep: boolean;
  inputRecovery: InputRecoveryState | undefined;
  windowsBefore: ComputerWindowRecord[] | null;
}

/** A fresh scope is recorded on the execution for later steps; a trusted
 *  continuation reuses the scope its first step recorded. */
function bindObservedScope(
  host: InputRunPrepareHost,
  inputTarget: ResolvedInputTarget,
  trustedSequenceContinuation: boolean
): void {
  const { targetWindowId } = inputTarget;
  const activeState = host.executionContext.getStore();
  if (targetWindowId && inputTarget.observedScope && activeState) {
    activeState.inputScopes ||= new Map();
    activeState.inputScopes.set(targetWindowId, inputTarget.observedScope);
  } else if (targetWindowId && trustedSequenceContinuation) {
    inputTarget.observedScope = activeState?.inputScopes?.get(targetWindowId);
  }
}

async function recordCursorFeedback(
  host: InputRunPrepareHost,
  command: ComputerCommand,
  action: string
): Promise<void> {
  const feedback = await prepareCursorFeedback(host.sessionIdFor(command));
  host.recordDiagnostic?.(host.sessionIdFor(command), {
    action,
    stage: 'cursor_preparation',
    code: feedback,
    ok: feedback === 'ready',
  });
  host.assertExecutionNotAborted();
}

async function readRecoveryBaseline(
  host: InputRunPrepareHost,
  command: ComputerCommand,
  targetWindowId: string | undefined
): Promise<InputRecoveryState> {
  const inputRecovery = await host.readInputRecovery(command, targetWindowId);
  const activeExecution = host.executionContext.getStore();
  if (activeExecution?.sessionId === host.sessionIdFor(command)) {
    activeExecution.recovery = inputRecovery;
  }
  host.assertExecutionNotAborted();
  return inputRecovery;
}

export async function prepareInputRun(
  host: InputRunPrepareHost,
  policy: ComputerExecutionPolicy,
  run: InputRunContext
): Promise<PreparedInputRun> {
  const { command, action, isMutation, trustedSequenceContinuation, sequenceStep, pointerAction, actionTimings } = run;
  const inputTarget = await host.resolveInputTarget(command, action, trustedSequenceContinuation);
  const { targetWindowId } = inputTarget;
  bindObservedScope(host, inputTarget, trustedSequenceContinuation);
  const logicalTargetWindowId = inputTarget.observedScope?.primaryWindowId || targetWindowId;
  const batchSequenceStep = sequenceStep && canBatchSequenceInput(command, targetWindowId);
  if (policy.restricted && targetWindowId && host.sessionIdFor(command) !== CHROME_SETUP_SESSION_ID) {
    policy.assertWindow({ ...command, window_id: targetWindowId }, await host.readComputerWindows(command));
    host.assertExecutionNotAborted();
  }
  if (isMutation) await host.claimComputerTargets(command, [logicalTargetWindowId, targetWindowId]);
  if (pointerAction) await recordCursorFeedback(host, command, action);
  const inputRecovery =
    action === 'focus_window' || command.delivery === 'foreground'
      ? await readRecoveryBaseline(host, command, targetWindowId)
      : undefined;
  let windowsBefore: ComputerWindowRecord[] | null = null;
  if (isMutation && !batchSequenceStep) {
    const beforeWindowsStartedAt = performance.now();
    windowsBefore = await host.readComputerWindows(command);
    actionTimings.before_windows_ms = elapsedMs(beforeWindowsStartedAt);
  }
  return { inputTarget, targetWindowId, logicalTargetWindowId, batchSequenceStep, inputRecovery, windowsBefore };
}
