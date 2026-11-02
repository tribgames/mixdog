/** Keys and wheel for Mixdog's own window go to its renderer through Electron's
 *  debugger input channel. Chromium ignores window-message keys, and this
 *  channel needs neither OS focus nor the pointer, so the window is never
 *  raised and the user's foreground window stays where it is. */
import type { WebContents } from 'electron';
import { createKeyboardInput } from '../../browser/input-keyboard';
import { cssPoint, normalizeModifierMask, type SendBrowserInput } from '../../browser/input-primitives';
import { dipToNative, nativeToDip } from '../shared/native-coordinates';
import { computerUseCoordinator } from '../session/coordinator';
import type { ComputerCommand, PowerShellResponse } from '../shared/types';
import type { DispatchAuthority, ElectronTextDispatch } from './input-dispatch-electron-text';
import { electronKeyPresses } from './input-electron-keys';
import { assertObservationInputAllowed } from './observation-policy';

/** CSS pixels one wheel notch scrolls, the step Chromium itself uses. */
const WHEEL_NOTCH = 100;

/** Run `work` with the window's debugger attached, releasing it only if this call attached it. */
async function withDebugger<T>(
  contents: WebContents,
  work: (send: SendBrowserInput) => Promise<T>
): Promise<T> {
  const cdp = contents.debugger;
  const attachedHere = !cdp.isAttached();
  if (attachedHere) cdp.attach('1.3');
  try {
    return await work(async (_guest, method, params) => {
      await cdp.sendCommand(method, params);
      return 'completed';
    });
  } finally {
    if (attachedHere && !contents.isDestroyed() && cdp.isAttached()) cdp.detach();
  }
}

/** Where a wheel lands, in the renderer's CSS pixels: the frame point when the
 *  caller gave one, otherwise the middle of the content. */
function wheelPoint(input: ElectronTextDispatch): { x: number; y: number } {
  const { renderer, target } = input;
  const bounds = renderer.getContentBounds();
  const zoom = renderer.webContents.getZoomFactor();
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('background_unsupported: window zoom is unreadable');
  if (target.physicalX === undefined || target.physicalY === undefined) {
    return cssPoint({ x: bounds.width / 2 / zoom, y: bounds.height / 2 / zoom });
  }
  const dip = nativeToDip({ x: target.physicalX, y: target.physicalY });
  return cssPoint({ x: (dip.x - bounds.x) / zoom, y: (dip.y - bounds.y) / zoom });
}

/** The signed wheel deltas of a scroll command, matching the native worker's amount rules. */
function wheelDeltas(command: ComputerCommand): { deltaX: number; deltaY: number } {
  const magnitude = Math.max(1, Math.min(100, Math.abs(command.amount ?? command.dy ?? 3)));
  const negative = command.direction
    ? command.direction === 'up' || command.direction === 'left'
    : (command.dy ?? 0) < 0;
  const delta = (negative ? -magnitude : magnitude) * WHEEL_NOTCH;
  const horizontal = command.direction === 'left' || command.direction === 'right';
  return horizontal ? { deltaX: delta, deltaY: 0 } : { deltaX: 0, deltaY: delta };
}

function delivered(
  input: ElectronTextDispatch,
  text: string,
  path: 'electron_key_event' | 'electron_wheel_event'
): PowerShellResponse {
  return {
    id: 0,
    ok: true,
    result: {
      action: input.command.action,
      text,
      path,
      effect: 'unverifiable',
      verified: false,
      delivery_accepted: true,
      goal_verified: false,
      delivery: 'background',
      window_id: input.target.targetWindowId,
      pid: input.renderer.webContents.getOSProcessId(),
    },
  };
}

export async function dispatchElectronInput(input: ElectronTextDispatch): Promise<PowerShellResponse> {
  const { host, command, target, renderer, authorizeDispatch } = input;
  const contents = renderer.webContents;
  /** Every event that can reach the renderer is re-authorized right before it is sent. */
  const authorizeStep = async (): Promise<DispatchAuthority> => {
    const authority = await authorizeDispatch();
    assertObservationInputAllowed(command, host.isObserveOnly());
    return authority;
  };
  if (command.action === 'key') {
    const presses = electronKeyPresses(String(command.keys || ''));
    await withDebugger(contents, async (send) => {
      const { pressKey } = createKeyboardInput(send, { allowClipboard: true });
      for (const press of presses) {
        await authorizeStep();
        await pressKey(contents, press);
      }
    });
    return delivered(input, `sent ${presses.length} key press(es) to app-owned Electron renderer`, 'electron_key_event');
  }
  const point = wheelPoint(input);
  const { deltaX, deltaY } = wheelDeltas(command);
  const modifiers = command.modifiers ? normalizeModifierMask(command.modifiers.split(/[\s+,]+/).filter(Boolean)) : 0;
  await authorizeStep();
  const bounds = renderer.getContentBounds();
  computerUseCoordinator.showCursor({
    sessionId: host.sessionIdFor(command),
    windowId: target.targetWindowId,
    ...(target.physicalX !== undefined && target.physicalY !== undefined
      ? { x: target.physicalX, y: target.physicalY }
      : dipToNative({ x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) })),
    action: 'scroll',
    effect: 'scroll',
    mode: 'background',
  });
  await withDebugger(contents, async (send) => {
    await send(contents, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY, modifiers, button: 'none' });
  });
  return delivered(input, 'sent a wheel event to app-owned Electron renderer', 'electron_wheel_event');
}
