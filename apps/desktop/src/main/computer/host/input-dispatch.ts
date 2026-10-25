/** Execute one authorized input without owning routing, leases, or reply policy. */
import { electronWindowForNativeId } from '../observation/window-handles';
import { CHROME_SETUP_SESSION_ID } from '../shared/common';
import { computerUseCoordinator } from '../session/coordinator';
import type { ComputerCommand, PowerShellResponse } from '../shared/types';
import type { CommandRouterHost } from './command-router';
import type { ComputerExecutionPolicy } from './execution-policy';
import { dispatchElectronText, type DispatchAuthority } from './input-dispatch-electron-text';
import { powerShellInputRequest, type InputObservation } from './input-dispatch-request';
import { canUseAppOwnedTextInput } from './input-preflight';
import type { ResolvedInputTarget } from './input-resolution';
import { assertObservationInputAllowed } from './observation-policy';
import { fillSavedLogin } from './saved-login';
import { sequenceStepRequest } from './sequence-dispatch';
import { UNKNOWN_WINDOW_INTEGRITY } from './window-reads';

type DispatchHost = Pick<
  CommandRouterHost,
  | 'callPowerShell'
  | 'callPowerShellElevated'
  | 'sessionIdFor'
  | 'readWindowIntegrity'
  | 'readComputerWindows'
  | 'assertExecutionNotAborted'
  | 'isObserveOnly'
  | 'savedLogins'
>;
type WindowIntegrity = Awaited<ReturnType<DispatchHost['readWindowIntegrity']>>;

/** Foreground input is sent only against a fresh, foreground-ready observation
 *  of the user's input state; chrome setup drives its own window. */
function foregroundInputObservation(
  command: ComputerCommand,
  target: ResolvedInputTarget,
  sessionId: string
): InputObservation | undefined {
  if (command.delivery !== 'foreground' || sessionId === CHROME_SETUP_SESSION_ID) return undefined;
  const inputObservation = target.observedScope?.inputObservation;
  if (!inputObservation?.monitor || !Number.isSafeInteger(inputObservation.sequence)) {
    throw new Error('input_observation_unavailable: capture a fresh foreground-ready observation before input');
  }
  // The observation exists but did not prove the user's hands were off the
  // input: that is the user's state, not a broken host, so it must not send
  // the caller into host diagnosis.
  if (!inputObservation.ready) {
    // The reason travels with the observation, so the refusal itself separates
    // "the user is typing" from "the observer was unready" without sending the
    // caller back to a capture payload it may no longer hold.
    throw new Error(
      `foreground_input_not_ready: the last observation was not foreground-ready (foreground_input_reason=${
        inputObservation.reason || 'unknown'
      }); user input means wait for the user, an unready observer means diagnose`
    );
  }
  return inputObservation;
}

/** A privileged (UAC-elevated) one-shot worker answered; the reply says so. */
function annotatePrivilegedResponse(
  response: PowerShellResponse,
  integrity: Pick<WindowIntegrity, 'ownName' | 'targetName'>
): void {
  if (!response.result) return;
  response.result.path = `uac_elevated_${String(response.result.path || 'foreground_input')}`;
  response.result.privilege = {
    source_integrity: integrity.ownName,
    target_integrity: integrity.targetName,
    worker: 'one_shot',
  };
}

/** How a vetted sequence step treats the refs of the observation it started from:
 *  keep them for a later ref step, and re-prove a ref this later step addresses. */
export interface SequenceRefScope {
  retainRefs?: boolean;
  continuationRef?: boolean;
}

export function createInputDispatch(host: DispatchHost, policy: ComputerExecutionPolicy) {
  const {
    callPowerShell,
    callPowerShellElevated,
    sessionIdFor,
    readWindowIntegrity,
    readComputerWindows,
    assertExecutionNotAborted,
  } = host;

  /** Foreground input needs the target's integrity level to pick the worker. */
  async function readForegroundIntegrity(
    command: ComputerCommand,
    targetWindowId: ResolvedInputTarget['targetWindowId']
  ) {
    if (command.delivery !== 'foreground') return { ...UNKNOWN_WINDOW_INTEGRITY };
    const integrity = await readWindowIntegrity(targetWindowId, sessionIdFor(command));
    if (!integrity.known) {
      throw new Error(
        'target_integrity_unknown: foreground input was not sent because the target integrity could not be verified'
      );
    }
    return integrity;
  }

  return async function dispatchInput(
    command: ComputerCommand,
    action: string,
    target: ResolvedInputTarget,
    batchSequenceStep = false,
    sequenceRefs: SequenceRefScope = {}
  ): Promise<PowerShellResponse> {
    const { targetWindowId } = target;
    const inputObservation = foregroundInputObservation(command, target, sessionIdFor(command));
    const authorizeDispatch = async (): Promise<DispatchAuthority> => {
      assertExecutionNotAborted();
      computerUseCoordinator.assertOperationAllowed(action);
      if (sessionIdFor(command) !== CHROME_SETUP_SESSION_ID) {
        if (policy.restricted && targetWindowId) {
          policy.assertWindow({ ...command, window_id: targetWindowId }, await readComputerWindows(command));
        }
        policy.assertAction(command);
      }
      assertExecutionNotAborted();
      return sessionIdFor(command) === CHROME_SETUP_SESSION_ID ? {} : policy.dispatchAuthority(targetWindowId);
    };
    const electronTextTarget = canUseAppOwnedTextInput(command) ? electronWindowForNativeId(targetWindowId) : null;
    if (electronTextTarget && !electronTextTarget.webContents.isDestroyed()) {
      return dispatchElectronText({ host, command, target, renderer: electronTextTarget, authorizeDispatch });
    }
    const powerShellRequest = {
      ...powerShellInputRequest(command, action, target, sessionIdFor(command), inputObservation),
      ...(sequenceRefs.retainRefs ? { retain_refs: true } : {}),
      ...(sequenceRefs.continuationRef ? { sequence_continuation: true } : {}),
    };
    const integrity = await readForegroundIntegrity(command, targetWindowId);
    const usePrivilegedWorker = integrity.known && integrity.higher;
    assertExecutionNotAborted();
    if (action === 'fill_saved_login') {
      // Never through a UAC one-shot worker; each worker request is authorized
      // again, so a policy change or Stop between them sends nothing more. The
      // fill's own last check (Auto login) runs after that authorization with
      // no await before the request is written; past it nothing is recalled.
      if (usePrivilegedWorker) throw new Error('saved_login_refused: the browser runs elevated; no input was sent');
      return await fillSavedLogin(
        command,
        host.savedLogins,
        async (request, beforeSend) => {
          const authority = await authorizeDispatch();
          assertObservationInputAllowed(command, host.isObserveOnly());
          beforeSend?.();
          return await callPowerShell({ ...powerShellRequest, ...authority, ...request });
        },
        { assertRunnable: assertExecutionNotAborted }
      );
    }
    if (usePrivilegedWorker) {
      policy.assertElevated();
      if (command.ref || command.to) {
        throw new Error(
          'privileged_worker_ref_unsupported: use frame-bound coordinates or direct keys/text; no UAC request was opened'
        );
      }
    }
    const authority = await authorizeDispatch();
    assertObservationInputAllowed(command, host.isObserveOnly());
    const authorizedRequest = { ...powerShellRequest, ...authority };
    if (usePrivilegedWorker) {
      const elevated = await callPowerShellElevated(authorizedRequest);
      annotatePrivilegedResponse(elevated, integrity);
      return elevated;
    }
    return await callPowerShell(
      batchSequenceStep ? sequenceStepRequest(authorizedRequest) : authorizedRequest,
      action === 'invoke_menu' ? 3_000 : undefined
    );
  };
}
