/** The worker request for one input action: the command's fields, the
 *  resolved physical geometry, and the observation the input is bound to. */
import { normalizeComputerKeySequence } from '../input/keyboard';
import type { ComputerCommand } from '../shared/types';
import type { ResolvedInputTarget } from './input-resolution';

export type InputObservation = NonNullable<NonNullable<ResolvedInputTarget['observedScope']>['inputObservation']>;

export function powerShellInputRequest(
  command: ComputerCommand,
  action: string,
  target: ResolvedInputTarget,
  sessionId: string,
  inputObservation: InputObservation | undefined
) {
  const { targetWindowId, physicalX, physicalY, physicalToX, physicalToY, physicalPath, allowedWindowIds } = target;
  return {
    action,
    window: command.window ?? null,
    window_id: targetWindowId ?? null,
    ref: command.ref ?? null,
    to: command.to ?? null,
    text: command.text ?? null,
    keys: action === 'key' ? normalizeComputerKeySequence(String(command.keys || '')) : (command.keys ?? null),
    dy: command.dy ?? null,
    amount: command.amount ?? null,
    direction: command.direction ?? null,
    app: command.app ?? null,
    x: physicalX ?? null,
    y: physicalY ?? null,
    to_x: physicalToX ?? null,
    to_y: physicalToY ?? null,
    waypoints: physicalPath ?? null,
    allowed_window_ids: allowedWindowIds,
    width: command.width ?? null,
    height: command.height ?? null,
    state: command.state ?? null,
    confirm: command.confirm ?? null,
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
    session_id: sessionId,
    ...(inputObservation
      ? {
          observed_input_monitor_id: inputObservation.monitor,
          observed_input_user_sequence: inputObservation.sequence,
        }
      : {}),
  };
}
