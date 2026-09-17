/** Execute one authorized input without owning routing, leases, or reply policy. */
import { screen } from 'electron';
import { electronWindowForNativeId } from '../observation/window-handles';
import { normalizeComputerKeySequence } from '../input/keyboard';
import { CHROME_SETUP_SESSION_ID } from '../session/chrome-setup';
import { computerUseCoordinator } from '../session/coordinator';
import type { ComputerCommand, PowerShellResponse } from '../shared/types';
import type { ResolvedInputTarget } from './input-resolution';
import type { CommandRouterHost } from './command-router';
import type { ComputerExecutionPolicy } from './execution-policy';
import { sequenceStepRequest } from './sequence-dispatch';
import { assertObservationInputAllowed } from './observation-policy';
import { waitForElectronTypingTarget } from './electron-text-target';
import { canUseAppOwnedTextInput } from './input-preflight';
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';

type DispatchHost = Pick<
  CommandRouterHost,
  | 'callPowerShell'
  | 'callPowerShellElevated'
  | 'sessionIdFor'
  | 'readWindowIntegrity'
  | 'readComputerWindows'
  | 'assertExecutionNotAborted'
  | 'isObserveOnly'
>;

export function createInputDispatch(host: DispatchHost, policy: ComputerExecutionPolicy) {
  const {
    callPowerShell,
    callPowerShellElevated,
    sessionIdFor,
    readWindowIntegrity,
    readComputerWindows,
    assertExecutionNotAborted,
  } = host;
  return async function dispatchInput(
    command: ComputerCommand,
    action: string,
    target: ResolvedInputTarget,
    batchSequenceStep = false
  ): Promise<PowerShellResponse> {
    const { targetWindowId, physicalX, physicalY, physicalToX, physicalToY, allowedWindowIds } = target;
    const inputObservation =
      command.delivery === 'foreground' && sessionIdFor(command) !== CHROME_SETUP_SESSION_ID
        ? target.observedScope?.inputObservation
        : undefined;
    if (
      command.delivery === 'foreground' &&
      sessionIdFor(command) !== CHROME_SETUP_SESSION_ID &&
      (!inputObservation?.ready || !inputObservation.monitor || !Number.isSafeInteger(inputObservation.sequence))
    ) {
      throw new Error('input_observation_unavailable: capture a fresh foreground-ready observation before input');
    }
    const authorizeDispatch = async () => {
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
      const text = String(command.text ?? '');
      if (physicalX !== undefined && physicalY !== undefined) {
        const authority = await authorizeDispatch();
        assertObservationInputAllowed(command, host.isObserveOnly());
        const focused = await callPowerShell({
          ...authority,
          action: 'click',
          window_id: targetWindowId ?? null,
          x: physicalX,
          y: physicalY,
          allowed_window_ids: allowedWindowIds,
          delivery: 'background',
          session_id: sessionIdFor(command),
        });
        if (!focused.ok || focused.result?.code || focused.result?.delivery_accepted !== true) {
          const result = focused.result;
          const noInput = result?.delivery_accepted === false && result?.input_may_have_executed !== true;
          return {
            id: focused.id,
            ok: true,
            result: {
              ...result,
              action: 'type',
              code: result?.code || computerErrorCode(focused.error) || 'typing_target_unconfirmed',
              text: focused.error || result?.text || 'The preparatory click was not confirmed; no text was sent.',
              effect: 'unverifiable',
              verified: false,
              goal_verified: false,
              delivery: 'background',
              window_id: targetWindowId,
              delivery_accepted: noInput ? false : null,
              input_may_have_executed: !noInput,
            },
          };
        }
      }
      const typingPoint =
        physicalX !== undefined && physicalY !== undefined ? { x: physicalX, y: physicalY } : undefined;
      const ready = await waitForElectronTypingTarget(electronTextTarget, typingPoint, async () => {
        await authorizeDispatch();
        assertObservationInputAllowed(command, host.isObserveOnly());
      });
      if (!ready)
        return {
          id: 0,
          ok: true,
          result: {
            action: 'type',
            code: 'typing_target_unconfirmed',
            text: 'The requested editable target was not confirmed; no text was sent. Observe fresh state before continuing.',
            effect: 'unverifiable',
            verified: false,
            delivery_accepted: false,
            goal_verified: false,
            ...(typingPoint ? { input_may_have_executed: true } : {}),
            path: 'electron_typing_target_check',
            delivery: 'background',
            window_id: targetWindowId,
          },
        };
      await authorizeDispatch();
      assertObservationInputAllowed(command, host.isObserveOnly());
      const bounds = electronTextTarget.getContentBounds();
      const feedbackPoint = typingPoint ?? screen.dipToScreenPoint({
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height / 2),
      });
      computerUseCoordinator.showCursor({
        sessionId: sessionIdFor(command),
        windowId: targetWindowId,
        ...feedbackPoint,
        action: 'type',
        effect: 'type',
        mode: 'background',
      });
      await electronTextTarget.webContents.insertText(text);
      return {
        id: 0,
        ok: true,
        result: {
          action: 'type',
          text: `typed ${text.length} literal characters into app-owned Electron renderer`,
          path:
            physicalX !== undefined && physicalY !== undefined
              ? 'electron_point_focus_insert_text'
              : 'electron_insert_text',
          effect: 'unverifiable',
          verified: false,
          delivery_accepted: true,
          goal_verified: false,
          delivery: 'background',
          window_id: targetWindowId,
          pid: electronTextTarget.webContents.getOSProcessId(),
        },
      };
    }
    const powerShellRequest = {
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
      allowed_window_ids: allowedWindowIds,
      width: command.width ?? null,
      height: command.height ?? null,
      state: command.state ?? null,
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
      session_id: sessionIdFor(command),
      ...(inputObservation
        ? {
            observed_input_monitor_id: inputObservation.monitor,
            observed_input_user_sequence: inputObservation.sequence,
          }
        : {}),
    };
    const integrity =
      command.delivery === 'foreground'
        ? await readWindowIntegrity(targetWindowId, sessionIdFor(command))
        : { known: false, higher: false, ownName: 'Unknown', targetName: 'Unknown' };
    if (command.delivery === 'foreground' && !integrity.known) {
      throw new Error(
        'target_integrity_unknown: foreground input was not sent because the target integrity could not be verified'
      );
    }
    const usePrivilegedWorker = integrity.known && integrity.higher;
    assertExecutionNotAborted();
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
    const response = usePrivilegedWorker
      ? await callPowerShellElevated({ ...powerShellRequest, ...authority })
      : await callPowerShell(
          batchSequenceStep
            ? sequenceStepRequest({ ...powerShellRequest, ...authority })
            : { ...powerShellRequest, ...authority },
          action === 'invoke_menu' ? 3_000 : undefined
        );
    if (usePrivilegedWorker && response.result) {
      response.result.path = `uac_elevated_${String(response.result.path || 'foreground_input')}`;
      response.result.privilege = {
        source_integrity: integrity.ownName,
        target_integrity: integrity.targetName,
        worker: 'one_shot',
      };
    }
    return response;
  };
}
