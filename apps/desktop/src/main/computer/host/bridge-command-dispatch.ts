/** Where one accepted bridge command goes: the runtime-only actions the bridge
 *  answers itself (secret binding and typing, turn settlement, session abort)
 *  and the secret-focus capture hold, before everything else is serialized
 *  onto the host. */
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { computerUseCoordinator } from '../session/coordinator';
import { isComputerLifecycleControl, READ_ACTIONS } from './action-sets';
import { bindComputerSecret, secretInputs, typeComputerSecret } from '../../secret-input';
import type { BridgeServerHost } from './bridge-server-contract';

export type BridgeDispatchHost = Pick<BridgeServerHost, 'abortComputerSession' | 'executeSerialized' | 'waitForUser'>;

/** While a typed secret's field may hold focus, no capture leaves the host:
 *  a read is refused, and the next input action (which moves on) lifts the
 *  hold. Returns the refusal, if any. */
function applySecretFocusHold(command: ComputerCommand, sessionId: string): Error | undefined {
  if (!secretInputs.focusArmed(sessionId)) return undefined;
  if (READ_ACTIONS.has(command.action)) {
    return new Error('capture_withheld: a secret field may be focused; move focus (Tab or a click elsewhere) first');
  }
  if (!isComputerLifecycleControl(command)) secretInputs.clearFocus(sessionId);
  return undefined;
}

/** The runtime's authoritative settlement of one agent turn: no fill of that
 *  turn (or an older one of the session) is admitted from here on, and the
 *  saved-login protection they set up retires once those still running have
 *  finished. Input cleanup (execution_end, session_abort, session_release)
 *  never retires it, and a late settlement never reaches a newer turn
 *  (secret-input.ts). */
function settleTurn(command: ComputerCommand, sessionId: string): Promise<ComputerCommandResult> {
  const turnId = Number(command.turn_id);
  const ownerId = typeof command.runtime_id === 'string' ? command.runtime_id : '';
  if (!sessionId || !Number.isSafeInteger(turnId) || turnId < 1 || !ownerId) {
    return Promise.reject(
      new Error('invalid_request: turn_settle needs a session_id, a positive turn_id and a runtime_id')
    );
  }
  void secretInputs.settleSavedLoginTurn({ sessionId, turnId, ownerId });
  return Promise.resolve({ text: 'turn settlement accepted' });
}

/** The caller aborts when its turn is cancelled; that turn never sends
 *  execution_end, so its visible execution and any pause it held end here. */
function abortSession(host: BridgeDispatchHost, command: ComputerCommand): Promise<ComputerCommandResult> {
  return host.abortComputerSession(command).then((result) => {
    computerUseCoordinator.endExecution(String(command.session_id || 'default'));
    return result;
  });
}

export function dispatchBridgeCommand(
  host: BridgeDispatchHost,
  command: ComputerCommand,
  signal: AbortSignal
): Promise<ComputerCommandResult> {
  if (command.action === 'wait_for_user' && host.waitForUser) return host.waitForUser(command, signal);
  const sessionId = String(command.session_id || '');
  // Runtime-only: bind a secret request to its window and field at request
  // time, then type the secret the user handed the desktop (secret-input.ts).
  if (command.action === 'secret_bind') {
    return Promise.resolve(bindComputerSecret(command as Parameters<typeof bindComputerSecret>[0]));
  }
  if (command.action === 'secret_input') {
    return typeComputerSecret(command as Parameters<typeof typeComputerSecret>[0], (typed) =>
      host.executeSerialized(typed as unknown as ComputerCommand)
    );
  }
  const withheld = applySecretFocusHold(command, sessionId);
  if (withheld) return Promise.reject(withheld);
  if (command.action === 'turn_settle') return settleTurn(command, sessionId);
  if (command.action === 'session_abort') return abortSession(host, command);
  return host.executeSerialized(command);
}
