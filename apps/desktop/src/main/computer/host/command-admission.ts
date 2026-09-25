/**
 * The fixed guard order every command passes before it is routed: action and
 * platform, session id, the observation-only gate, safety, the execution
 * policy (a zoom is judged by the window its frame came from), exact target,
 * and the mutation / capture_after classification. Control actions that end
 * here — execution_end, session_release, diagnose, sequence — return their
 * reply instead of an admitted command.
 */
import { assertSafeComputerInput, assertSafeComputerSessionId, assertSafeComputerTargetTokens } from '../input/guards';
import { assertExactWindowCommandTarget } from '../input/targeting';
import { assertCaptureAfterOptions } from '../observation/analysis';
import { CHROME_SETUP_SESSION_ID } from '../session/chrome-setup';
import { computerUseCoordinator } from '../session/coordinator';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { AUTO_CAPTURE_ACTIONS, READ_ACTIONS } from './action-sets';
import type { CommandRouterHost } from './command-router';
import type { ComputerExecutionPolicy } from './execution-policy';
import { assertObservationInputAllowed } from './observation-policy';
import { captureAfterSuppressed } from './sequence-runner';

export type CommandAdmissionHost = Pick<
  CommandRouterHost,
  | 'sessionIdFor'
  | 'framesBySession'
  | 'lastCaptureBySession'
  | 'assertExecutionNotAborted'
  | 'releaseComputerSession'
  | 'diagnoseComputer'
  | 'resolveAppWindowId'
  | 'readComputerWindows'
  | 'resolveElementAliases'
  | 'isObserveOnly'
  | 'runBoundedSequence'
>;

export interface AdmittedCommand {
  /** The command with app resolved to a window, capture_after settled, and
   *  element aliases expanded. */
  command: ComputerCommand;
  action: string;
  isMutation: boolean;
  /** The ref's identity at the last capture, judged again after the action. */
  semanticTargetIdentity?: string;
}

export type CommandAdmission = { reply: ComputerCommandResult } | { admitted: AdmittedCommand };

function assertCommandPreconditions(command: ComputerCommand, action: string, isObserveOnly: () => boolean): void {
  if (!action) throw new Error('computer command requires action');
  assertSafeComputerSessionId(command);
  // Checked before every early return, so a bounded sequence cannot slip past
  // it. The app's own Browser Use setup flow keeps its internal session.
  assertObservationInputAllowed(command, isObserveOnly());
  if (action === 'sequence' && command.read_only) {
    throw new Error("read_only run: 'sequence' is a mutation");
  }
}

async function assertPolicyAdmits(
  host: CommandAdmissionHost,
  policy: ComputerExecutionPolicy,
  command: ComputerCommand,
  action: string
): Promise<void> {
  if (host.sessionIdFor(command) === CHROME_SETUP_SESSION_ID) return;
  const policyCommand =
    action === 'zoom'
      ? {
          ...command,
          window_id: host.framesBySession.get(host.sessionIdFor(command))?.get(String(command.frame_id || ''))
            ?.windowId,
        }
      : command;
  policy.assertAction(policyCommand);
  if (policy.restricted && policyCommand.window_id) {
    policy.assertWindow(policyCommand, await host.readComputerWindows(policyCommand));
    host.assertExecutionNotAborted();
  }
}

/** Whether the action mutates and whether a fresh capture follows it; the
 *  command carries the settled capture_after so every later stage agrees. */
function classifyMutation(command: ComputerCommand, action: string): { command: ComputerCommand; isMutation: boolean } {
  const isMutation = !READ_ACTIONS.has(action);
  const shouldCaptureAfter =
    isMutation &&
    !captureAfterSuppressed(command) &&
    (AUTO_CAPTURE_ACTIONS.has(action) || command.capture_after === true);
  if (isMutation && command.read_only) {
    throw new Error(`read_only run: '${action}' is a mutation`);
  }
  if (!isMutation && command.capture_after) {
    throw new Error(`capture_after is only valid for mutation actions, not '${action}'`);
  }
  if (shouldCaptureAfter) assertCaptureAfterOptions(command);
  return {
    isMutation,
    command: shouldCaptureAfter !== command.capture_after ? { ...command, capture_after: shouldCaptureAfter } : command,
  };
}

export async function admitCommand(
  host: CommandAdmissionHost,
  policy: ComputerExecutionPolicy,
  initial: ComputerCommand
): Promise<CommandAdmission> {
  let command = initial;
  const action = String(command.action || '').trim();
  assertCommandPreconditions(command, action, host.isObserveOnly);
  if (action === 'execution_end') {
    computerUseCoordinator.endExecution(host.sessionIdFor(command));
    return { reply: { text: 'computer execution ended' } };
  }
  if (action === 'session_release') return { reply: await host.releaseComputerSession(command) };
  assertSafeComputerInput(command);
  await assertPolicyAdmits(host, policy, command, action);
  if (action === 'diagnose') return { reply: await host.diagnoseComputer(command) };
  if (command.app?.trim() && !['launch', 'list_apps', 'capture'].includes(action)) {
    command = {
      ...command,
      app: undefined,
      window: undefined,
      window_id: await host.resolveAppWindowId(command),
    };
  }
  if (action === 'sequence') {
    assertCaptureAfterOptions(command);
    assertExactWindowCommandTarget(command);
    return { reply: await host.runBoundedSequence(command) };
  }
  const classified = classifyMutation(command, action);
  command = classified.command;
  assertExactWindowCommandTarget(command);
  command = host.resolveElementAliases(command);
  assertSafeComputerTargetTokens(command);
  const semanticTargetIdentity = command.ref
    ? host.lastCaptureBySession.get(host.sessionIdFor(command))?.refIdentities.get(command.ref)
    : undefined;
  return { admitted: { command, action, isMutation: classified.isMutation, semanticTargetIdentity } };
}
