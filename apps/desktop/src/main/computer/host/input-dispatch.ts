/** Execute one authorized input without owning routing, leases, or reply policy. */
import { electronWindowForNativeId } from '../observation/window-handles';
import { normalizeComputerKeySequence } from '../input/keyboard';
import { CHROME_SETUP_SESSION_ID } from '../session/chrome-setup';
import { computerUseCoordinator } from '../session/coordinator';
import type { ComputerCommand, PowerShellResponse } from '../shared/types';
import type { ResolvedInputTarget } from './input-resolution';
import type { CommandRouterHost } from './command-router';
import type { ComputerExecutionPolicy } from './execution-policy';
import { sequenceStepRequest } from './sequence-dispatch';

type DispatchHost = Pick<CommandRouterHost,
  'callPowerShell' | 'callPowerShellElevated' | 'sessionIdFor' | 'readWindowIntegrity'
  | 'readComputerWindows' | 'assertExecutionNotAborted'>;

export function createInputDispatch(host: DispatchHost, policy: ComputerExecutionPolicy) {
  const { callPowerShell, callPowerShellElevated, sessionIdFor,
    readWindowIntegrity, readComputerWindows, assertExecutionNotAborted } = host;
  return async function dispatchInput(
    command: ComputerCommand, action: string, target: ResolvedInputTarget, batchSequenceStep = false,
  ): Promise<PowerShellResponse> {
    const { targetWindowId, physicalX, physicalY, physicalToX, physicalToY, allowedWindowIds } = target;
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
    const electronTextTarget = action === 'type' && command.delivery !== 'foreground' && !command.ref
      ? electronWindowForNativeId(targetWindowId) : null;
    if (electronTextTarget && !electronTextTarget.webContents.isDestroyed()) {
      const text = String(command.text ?? '');
      if (physicalX !== undefined && physicalY !== undefined) {
        const focused = await callPowerShell({
          ...await authorizeDispatch(),
          action: 'click', window_id: targetWindowId ?? null, x: physicalX, y: physicalY,
          allowed_window_ids: allowedWindowIds, delivery: 'background', session_id: sessionIdFor(command),
        });
        if (!focused.ok || focused.result?.code || focused.result?.delivery_accepted !== true) {
          throw new Error(focused.error || String(focused.result?.text || '') || 'element-targeted type could not focus the point');
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      await authorizeDispatch();
      await electronTextTarget.webContents.insertText(text);
      return {
        id: 0, ok: true,
        result: {
          action: 'type', text: `typed ${text.length} literal characters into app-owned Electron renderer`,
          path: physicalX !== undefined && physicalY !== undefined ? 'electron_point_focus_insert_text' : 'electron_insert_text',
          effect: 'unverifiable', verified: false, delivery_accepted: true, goal_verified: false,
          delivery: 'background', window_id: targetWindowId, pid: electronTextTarget.webContents.getOSProcessId(),
        },
      };
    }
    const powerShellRequest = {
      action, window: command.window ?? null, window_id: targetWindowId ?? null,
      ref: command.ref ?? null, to: command.to ?? null, text: command.text ?? null,
      keys: action === 'key' ? normalizeComputerKeySequence(String(command.keys || '')) : command.keys ?? null,
      dy: command.dy ?? null, amount: command.amount ?? null, direction: command.direction ?? null,
      app: command.app ?? null, x: physicalX ?? null, y: physicalY ?? null,
      to_x: physicalToX ?? null, to_y: physicalToY ?? null, allowed_window_ids: allowedWindowIds,
      width: command.width ?? null, height: command.height ?? null, state: command.state ?? null,
      path: command.path ?? null, modifiers: command.modifiers ?? null, duration: command.duration ?? null,
      delivery: command.delivery ?? 'background', read_only: command.read_only ?? false,
      query: command.query ?? null, role: command.role ?? null, visible_only: command.visible_only ?? null,
      include_noninteractive: command.include_noninteractive ?? null, max_elements: command.max_elements ?? null,
      continuation: command.continuation ?? null, known_injection_tick: command.known_injection_tick ?? null,
      session_id: sessionIdFor(command),
    };
    const integrity = command.delivery === 'foreground'
      ? await readWindowIntegrity(targetWindowId, sessionIdFor(command))
      : { known: false, higher: false, ownName: 'Unknown', targetName: 'Unknown' };
    if (command.delivery === 'foreground' && !integrity.known) {
      throw new Error('target_integrity_unknown: foreground input was not sent because the target integrity could not be verified');
    }
    const usePrivilegedWorker = integrity.known && integrity.higher;
    assertExecutionNotAborted();
    if (usePrivilegedWorker) policy.assertElevated();
    const authority = await authorizeDispatch();
    const response = usePrivilegedWorker
      ? await callPowerShellElevated({ ...powerShellRequest, ...authority })
      : await callPowerShell(
        batchSequenceStep
          ? sequenceStepRequest({ ...powerShellRequest, ...authority })
          : { ...powerShellRequest, ...authority },
        action === 'invoke_menu' ? 3_000 : undefined,
      );
    if (usePrivilegedWorker && response.result) {
      response.result.path = `uac_elevated_${String(response.result.path || 'foreground_input')}`;
      response.result.privilege = {
        source_integrity: integrity.ownName, target_integrity: integrity.targetName, worker: 'one_shot',
      };
    }
    return response;
  };
}
