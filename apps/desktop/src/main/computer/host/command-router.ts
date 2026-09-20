/**
 * Command dispatch for the Computer Use host. One command comes in, its
 * guards run in a fixed order (observation-only gate, safety, exact target,
 * fresh observation), then it is routed to a read, a capture, a bounded
 * sequence, or the resident backend, and the reply carries the verdict and
 * post-action observation the runtime acts on.
 */
import { elapsedMs } from '../shared/common';
import type { ComputerCommand, ComputerCommandResult, PowerShellResponse } from '../shared/types';
import type { createWindowTargeting } from '../input/targeting';
import type { createCaptureEngine } from '../observation/capture';
import type { createInspection } from '../observation/inspect';
import type { createWorkerPool } from '../backend/worker-pool';
import type { createSessionState } from '../session/state';
import { AUTO_CAPTURE_ACTIONS } from './action-sets';
import { admitCommand } from './command-admission';
import { observationRoute } from './command-observation-routes';
import { createCommandReplies } from './command-replies';
import type { ExecutionState } from './execution-state';
import { createComputerExecutionPolicy, type ComputerExecutionPolicy } from './execution-policy';
import { createInputDispatch } from './input-dispatch';
import type { InputResolution } from './input-resolution';
import { prepareInputRun, type InputRunContext, type PreparedInputRun } from './input-run-prepare';
import { settleInputRun } from './input-run-settle';
import { isSequenceStep, isTrustedSequenceContinuation } from './sequence-runner';
import type { SessionLifecycle } from './session-lifecycle';
import type { WindowReads } from './window-reads';

const POINTER_ACTIONS = [
  'invoke',
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'triple_click',
  'mouse_down',
  'mouse_up',
  'mouse_move',
  'drag',
  'scroll',
  'type',
  'key',
  'key_down',
  'key_up',
];

type WorkerPool = ReturnType<typeof createWorkerPool>;
type SessionState = ReturnType<typeof createSessionState>;
type CaptureEngine = ReturnType<typeof createCaptureEngine>;
type Inspection = ReturnType<typeof createInspection>;
type WindowTargeting = ReturnType<typeof createWindowTargeting>;

export interface CommandRouterHost
  extends Pick<WorkerPool, 'callPowerShell' | 'callPowerShellElevated'>,
    Pick<
      SessionState,
      | 'sessionIdFor'
      | 'framesBySession'
      | 'elementTargetsBySession'
      | 'observedWindowBySession'
      | 'lastCaptureBySession'
      | 'rememberObservedWindowScope'
      | 'freshObservedWindowScope'
      | 'invalidateActionTargets'
      | 'invalidateWindowTargets'
      | 'normalizeElementRecords'
      | 'rememberElementTargets'
      | 'resolveElementAliases'
    >,
    Pick<
      ExecutionState,
      'executionContext' | 'sessionRecoveryBySession' | 'assertExecutionNotAborted' | 'invalidateObservationsForWindows'
    >,
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
  const replies = createCommandReplies(host);
  const { sessionIdFor, framesBySession, elementTargetsBySession, observedWindowBySession, assertExecutionNotAborted } =
    host;

  /** A mutation invalidates every other observer of the touched windows before
   *  and after delivery, and drops this session's frames and element targets. */
  async function deliverInput(
    command: ComputerCommand,
    action: string,
    isMutation: boolean,
    prepared: PreparedInputRun
  ): Promise<PowerShellResponse> {
    const { inputTarget, targetWindowId, logicalTargetWindowId, batchSequenceStep } = prepared;
    const invalidateOtherObservers = () => {
      const ids = [logicalTargetWindowId, targetWindowId];
      host.invalidateWindowTargets(ids, sessionIdFor(command));
      host.invalidateObservationsForWindows(ids, sessionIdFor(command));
    };
    try {
      if (isMutation) invalidateOtherObservers();
      return await dispatchInput(command, action, inputTarget, batchSequenceStep);
    } finally {
      if (isMutation) {
        invalidateOtherObservers();
        framesBySession.delete(sessionIdFor(command));
        elementTargetsBySession.delete(sessionIdFor(command));
        if (AUTO_CAPTURE_ACTIONS.has(action)) {
          observedWindowBySession.delete(sessionIdFor(command));
        }
      }
    }
  }

  async function runCommand(initial: ComputerCommand): Promise<ComputerCommandResult> {
    const commandStartedAt = performance.now();
    const actionTimings: Record<string, number> = {};
    const trustedSequenceContinuation = isTrustedSequenceContinuation(initial);
    const sequenceStep = isSequenceStep(initial);
    const admission = await admitCommand(host, policy, initial);
    if ('reply' in admission) return admission.reply;
    const { command, action, isMutation, semanticTargetIdentity } = admission.admitted;
    const observed = await observationRoute(host, replies, command, action);
    if (observed) return observed;
    const run: InputRunContext = {
      command,
      action,
      isMutation,
      trustedSequenceContinuation,
      sequenceStep,
      pointerAction: POINTER_ACTIONS.includes(action),
      actionTimings,
    };
    const prepared = await prepareInputRun(host, policy, run);
    const deliveryStartedAt = performance.now();
    const response = await deliverInput(command, action, isMutation, prepared);
    actionTimings.delivery_ms = elapsedMs(deliveryStartedAt);
    assertExecutionNotAborted();
    if (!response.ok) throw new Error(response.error || 'computer command failed');
    return await settleInputRun(host, policy, { run, prepared, response, semanticTargetIdentity, commandStartedAt });
  }

  return { runCommand, recaptureRequiredReply: replies.recaptureRequiredReply };
}

export type CommandRouter = ReturnType<typeof createCommandRouter>;
