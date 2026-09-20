/** Text for an app-owned Electron renderer is inserted through its own
 *  WebContents instead of synthesized keystrokes, once the editable target is
 *  confirmed; nothing is typed when that confirmation fails. */
import { screen } from 'electron';
import type { electronWindowForNativeId } from '../observation/window-handles';
import { computerUseCoordinator } from '../session/coordinator';
import type { ComputerCommand, PowerShellResponse } from '../shared/types';
import type { CommandRouterHost } from './command-router';
import { waitForElectronTypingTarget } from './electron-text-target';
import type { ComputerExecutionPolicy } from './execution-policy';
import type { ResolvedInputTarget } from './input-resolution';
import { assertObservationInputAllowed } from './observation-policy';
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';

export type DispatchAuthority =
  | Awaited<ReturnType<ComputerExecutionPolicy['dispatchAuthority']>>
  | Record<string, never>;

export type ElectronTextRenderer = NonNullable<ReturnType<typeof electronWindowForNativeId>>;

export interface ElectronTextDispatch {
  host: Pick<CommandRouterHost, 'callPowerShell' | 'sessionIdFor' | 'isObserveOnly'>;
  command: ComputerCommand;
  target: ResolvedInputTarget;
  renderer: ElectronTextRenderer;
  /** Runs the abort, coordinator and policy checks; resolves to the dispatch authority fields. */
  authorizeDispatch(): Promise<DispatchAuthority>;
}

type Point = { x: number; y: number };
type TargetWindowId = ResolvedInputTarget['targetWindowId'];

/** The preparatory click was not confirmed, so no text was sent. */
function preparatoryClickFailure(focused: PowerShellResponse, targetWindowId: TargetWindowId): PowerShellResponse {
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

function typingTargetUnconfirmed(typingPoint: Point | undefined, targetWindowId: TargetWindowId): PowerShellResponse {
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
}

export async function dispatchElectronText(input: ElectronTextDispatch): Promise<PowerShellResponse> {
  const { host, command, target, renderer, authorizeDispatch } = input;
  const { targetWindowId, physicalX, physicalY, allowedWindowIds } = target;
  const text = String(command.text ?? '');
  const typingPoint = physicalX !== undefined && physicalY !== undefined ? { x: physicalX, y: physicalY } : undefined;
  if (typingPoint) {
    const authority = await authorizeDispatch();
    assertObservationInputAllowed(command, host.isObserveOnly());
    const focused = await host.callPowerShell({
      ...authority,
      action: 'click',
      window_id: targetWindowId ?? null,
      x: typingPoint.x,
      y: typingPoint.y,
      allowed_window_ids: allowedWindowIds,
      delivery: 'background',
      session_id: host.sessionIdFor(command),
    });
    if (!focused.ok || focused.result?.code || focused.result?.delivery_accepted !== true) {
      return preparatoryClickFailure(focused, targetWindowId);
    }
  }
  const ready = await waitForElectronTypingTarget(renderer, typingPoint, async () => {
    await authorizeDispatch();
    assertObservationInputAllowed(command, host.isObserveOnly());
  });
  if (!ready) return typingTargetUnconfirmed(typingPoint, targetWindowId);
  await authorizeDispatch();
  assertObservationInputAllowed(command, host.isObserveOnly());
  const bounds = renderer.getContentBounds();
  const feedbackPoint =
    typingPoint ??
    screen.dipToScreenPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    });
  computerUseCoordinator.showCursor({
    sessionId: host.sessionIdFor(command),
    windowId: targetWindowId,
    ...feedbackPoint,
    action: 'type',
    effect: 'type',
    mode: 'background',
  });
  await renderer.webContents.insertText(text);
  return {
    id: 0,
    ok: true,
    result: {
      action: 'type',
      text: `typed ${text.length} literal characters into app-owned Electron renderer`,
      path: typingPoint ? 'electron_point_focus_insert_text' : 'electron_insert_text',
      effect: 'unverifiable',
      verified: false,
      delivery_accepted: true,
      goal_verified: false,
      delivery: 'background',
      window_id: targetWindowId,
      pid: renderer.webContents.getOSProcessId(),
    },
  };
}
