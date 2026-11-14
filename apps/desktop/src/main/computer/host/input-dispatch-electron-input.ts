/** Keys and wheel for Mixdog's own window go to its renderer through Electron's
 *  debugger input channel. Chromium ignores window-message keys, and this
 *  channel needs neither OS focus nor the pointer, so the window is never
 *  raised and the user's foreground window stays where it is. */
import type { WebContents } from 'electron';
import { createKeyboardInput } from '../../browser/input-keyboard';
import { createMouseInput } from '../../browser/input-mouse';
import {
  type BrowserMouseButton,
  cssPoint,
  normalizeModifierMask,
  type SendBrowserInput,
} from '../../browser/input-primitives';
import { dipToNative, nativeToDip } from '../shared/native-coordinates';
import type { ComputerCommand, PowerShellResponse } from '../shared/types';
import type { DispatchAuthority, ElectronTextDispatch } from './input-dispatch-electron-text';
import { electronKeyPresses } from './input-electron-keys';
import { assertObservationInputAllowed } from './observation-policy';

/** CSS pixels one wheel notch scrolls, the step Chromium itself uses. */
const WHEEL_NOTCH = 100;

/** The tail of each window's queued input operations. Sessions run their commands on separate
 *  chains, so without this one session could detach the debugger between another's keydown and keyup. */
const operationTails = new WeakMap<WebContents, Promise<unknown>>();

/** Run `work` with the window's debugger attached, releasing it only if this call attached it.
 *  Whole operations (attach, work, detach) run one at a time per window. */
async function withDebugger<T>(contents: WebContents, work: (send: SendBrowserInput) => Promise<T>): Promise<T> {
  const previous = operationTails.get(contents) ?? Promise.resolve();
  const run = previous.then(() => attachedOperation(contents, work));
  operationTails.set(
    contents,
    run.catch(() => undefined)
  );
  return run;
}

async function attachedOperation<T>(contents: WebContents, work: (send: SendBrowserInput) => Promise<T>): Promise<T> {
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

/** A native physical point as the renderer's CSS pixels. */
function rendererPoint(renderer: ElectronTextDispatch['renderer'], native: { x: number; y: number }): { x: number; y: number } {
  const bounds = renderer.getContentBounds();
  const zoom = renderer.webContents.getZoomFactor();
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('background_unsupported: window zoom is unreadable');
  const dip = nativeToDip(native);
  return cssPoint({ x: (dip.x - bounds.x) / zoom, y: (dip.y - bounds.y) / zoom });
}

/** Where a wheel lands, in the renderer's CSS pixels: the frame point when the
 *  caller gave one, otherwise the middle of the content. */
function wheelPoint(input: ElectronTextDispatch): { x: number; y: number } {
  const { renderer, target } = input;
  if (target.physicalX === undefined || target.physicalY === undefined) {
    const bounds = renderer.getContentBounds();
    const zoom = renderer.webContents.getZoomFactor();
    if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('background_unsupported: window zoom is unreadable');
    return cssPoint({ x: bounds.width / 2 / zoom, y: bounds.height / 2 / zoom });
  }
  return rendererPoint(renderer, { x: target.physicalX, y: target.physicalY });
}

/** A pointer click (move, press, release per click) or a move at a native physical point, through the renderer's own
 *  input channel: no OS pointer and no focus change. `clicks` presses count up so a double click reads as one. */
export async function sendElectronPointer(
  renderer: ElectronTextDispatch['renderer'],
  native: { x: number; y: number },
  pointer: { kind: 'click' | 'move'; button?: BrowserMouseButton; clicks?: number; modifiers?: number }
): Promise<void> {
  const contents = renderer.webContents;
  const point = rendererPoint(renderer, native);
  await withDebugger(contents, async (send) => {
    const mouse = createMouseInput(send);
    if (pointer.kind === 'move') return mouse.hoverAt(contents, point.x, point.y);
    for (let count = 1; count <= (pointer.clicks ?? 1); count++) {
      await mouse.clickAt(contents, point.x, point.y, count, pointer.button ?? 'left', pointer.modifiers ?? 0);
    }
  });
}

/** The CDP modifier mask of a `ctrl+shift` style text. */
function modifierMask(text: string | undefined): number {
  return text ? normalizeModifierMask(text.split(/[\s+,]+/).filter(Boolean)) : 0;
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
  path: 'electron_key_event' | 'electron_wheel_event' | 'electron_click_event' | 'electron_move_event'
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
    return delivered(
      input,
      `sent ${presses.length} key press(es) to app-owned Electron renderer`,
      'electron_key_event'
    );
  }
  const point = wheelPoint(input);
  const { deltaX, deltaY } = wheelDeltas(command);
  const modifiers = modifierMask(command.modifiers);
  await authorizeStep();
  const bounds = renderer.getContentBounds();
  input.showCursor?.({
    sessionId: host.sessionIdFor(command),
    windowId: target.targetWindowId,
    ...(target.physicalX !== undefined && target.physicalY !== undefined
      ? { x: target.physicalX, y: target.physicalY }
      : dipToNative({ x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) })),
    action: 'scroll',
  });
  await withDebugger(contents, async (send) => {
    await send(contents, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...point,
      deltaX,
      deltaY,
      modifiers,
      button: 'none',
    });
  });
  return delivered(input, 'sent a wheel event to app-owned Electron renderer', 'electron_wheel_event');
}

/** A click or a move at the target's point in an app-owned renderer (the `appInput` ops the key/type/scroll route does not
 *  cover), re-authorized right before it is sent. */
export async function dispatchElectronPointer(
  input: ElectronTextDispatch,
  pointer: { kind: 'click' | 'move'; button?: BrowserMouseButton; clicks?: number; modifiers?: string }
): Promise<PowerShellResponse> {
  const { host, command, target, authorizeDispatch, renderer } = input;
  if (target.physicalX === undefined || target.physicalY === undefined) {
    throw new Error(`${pointer.kind} needs a point`);
  }
  const native = { x: target.physicalX, y: target.physicalY };
  await authorizeDispatch();
  assertObservationInputAllowed(command, host.isObserveOnly());
  const modifiers = modifierMask(pointer.modifiers);
  await sendElectronPointer(renderer, native, { ...pointer, modifiers });
  input.showCursor?.({ sessionId: host.sessionIdFor(command), windowId: target.targetWindowId, ...native, action: pointer.kind });
  return delivered(
    input,
    pointer.kind === 'click' ? 'sent a click to app-owned Electron renderer' : 'sent a pointer move to app-owned Electron renderer',
    pointer.kind === 'click' ? 'electron_click_event' : 'electron_move_event'
  );
}
