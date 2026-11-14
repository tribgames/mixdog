/**
 * `host/computer/appInput`: input into one of the desktop's own windows, delivered through its renderer's input channel
 * (`computer/host/input-dispatch-electron-*.ts`), so the window is never raised and the pointer never moves. The core
 * (`mixdog-tools` computer_app_owned.rs) reads the answer back as the result of an `act` step.
 *
 * A window that is not app-owned is -32602 (the core then sends the step to the helper); a window gone mid-delivery is
 * answered `window_gone`. `key` takes the helper's key grammar, `wheel` signed CSS-pixel deltas, and every point is in
 * physical pixels relative to the window's bounds.
 */
import type {
  HostComputerAppInputParams,
  HostComputerAppInputResult,
} from '../../../../../packages/protocol/src/index.ts';
import {
  dispatchElectronInput,
  dispatchElectronPointer,
  sendElectronPointer,
} from '../computer/host/input-dispatch-electron-input';
import {
  type DispatchAuthority,
  type ElectronCursor,
  type ElectronTextDispatch,
  dispatchElectronText,
} from '../computer/host/input-dispatch-electron-text';
import { electronKeyPresses } from '../computer/host/input-electron-keys';
import type { ComputerCommand, PowerShellResponse } from '../computer/shared/types';
import { appWindowBounds, appWindowById } from './computer-app-windows';
import { HOST_COMMAND_FAILED, HOST_INVALID_PARAMS, type HostConnection, HostRpcError, objectParams } from './connection';

export const HOST_COMPUTER_APP_INPUT = 'host/computer/appInput';

/** What the host says of an `appInput`: the generated result plus what the core reads beyond it. */
export type ComputerAppInputAnswer = Omit<HostComputerAppInputResult, 'effect'> & {
  effect: HostComputerAppInputResult['effect'] | 'click_unconfirmed';
  /** Key presses sent (`key`). */
  presses?: number;
  /** The renderer's process. */
  pid?: number;
  code?: string;
  text?: string;
  deliveryAccepted?: boolean | null;
  inputMayHaveExecuted?: boolean;
};

export interface ComputerAppInputDeps {
  /** Shows the agent's arrow at a native physical point (the presence overlay's `showCursor`). */
  showCursor(sessionId: string, x: number, y: number, action: string): void;
}

/** CSS pixels one wheel notch scrolls (the core sends deltas already multiplied by it). */
const NOTCH = 100;

function invalid(message: string): never {
  throw new HostRpcError(HOST_INVALID_PARAMS, `${HOST_COMPUTER_APP_INPUT}: ${message}`);
}

function finite(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${name} must be a finite number`);
  return value;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') invalid(`${name} must be a non-empty string`);
  return value;
}

interface Validated {
  sessionId: string;
  windowId: string;
  op: 'key' | 'type' | 'click' | 'move' | 'wheel';
  keys: string;
  text: string;
  point?: { x: number; y: number };
  button: 'left' | 'right' | 'middle';
  clicks: number;
  dx?: number;
  dy?: number;
  modifiers?: string;
}

function validate(params: unknown): Validated {
  const fields = objectParams<HostComputerAppInputParams & { modifiers?: string }>(params, HOST_COMPUTER_APP_INPUT);
  const sessionId = stringField(fields.sessionThreadId, 'sessionThreadId');
  const windowId = stringField(fields.windowId, 'windowId');
  const op = fields.op;
  if (op !== 'key' && op !== 'type' && op !== 'click' && op !== 'move' && op !== 'wheel') {
    return invalid('op must be key, type, click, move or wheel');
  }
  const x = finite(fields.x, 'x');
  const y = finite(fields.y, 'y');
  if ((x === undefined) !== (y === undefined)) invalid('x and y come together');
  if ((op === 'click' || op === 'move') && x === undefined) invalid(`${op} needs x and y`);
  const button = fields.button ?? 'left';
  if (button !== 'left' && button !== 'right' && button !== 'middle') invalid('button must be left, right or middle');
  const clicks = finite(fields.clicks, 'clicks') ?? 1;
  if (!Number.isInteger(clicks) || clicks < 1 || clicks > 3) invalid('clicks must be 1, 2 or 3');
  if (op === 'key') stringField(fields.keys, 'keys');
  if (op === 'type' && typeof fields.text !== 'string') invalid('text must be a string');
  if (fields.modifiers !== undefined && typeof fields.modifiers !== 'string') invalid('modifiers must be a string');
  return {
    sessionId,
    windowId,
    op,
    keys: typeof fields.keys === 'string' ? fields.keys : '',
    text: typeof fields.text === 'string' ? fields.text : '',
    ...(x !== undefined && y !== undefined ? { point: { x, y } } : {}),
    button,
    clicks,
    dx: finite(fields.dx, 'dx'),
    dy: finite(fields.dy, 'dy'),
    modifiers: fields.modifiers,
  };
}

/** The scroll command of signed CSS-pixel deltas: notches under the dispatcher's own rules, on the dominant axis. */
function wheelCommand(input: Validated): ComputerCommand {
  const dx = input.dx ?? 0;
  const dy = input.dy ?? 0;
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const delta = horizontal ? dx : dy;
  const modifiers = input.modifiers ? { modifiers: input.modifiers } : {};
  if (delta === 0) return { action: 'scroll', ...modifiers };
  const direction = horizontal ? (delta < 0 ? 'left' : 'right') : delta < 0 ? 'up' : 'down';
  return { action: 'scroll', direction, amount: Math.abs(delta) / NOTCH, ...modifiers };
}

function commandOf(input: Validated): ComputerCommand {
  if (input.op === 'key') return { action: 'key', keys: input.keys };
  if (input.op === 'type') return { action: 'type', text: input.text };
  if (input.op === 'wheel') return wheelCommand(input);
  return { action: input.op };
}

function gone(window: { isDestroyed(): boolean; webContents: { isDestroyed(): boolean } }): boolean {
  return window.isDestroyed() || window.webContents.isDestroyed();
}

function answerOf(
  input: Validated,
  response: PowerShellResponse,
  presses: number | undefined,
  cursor: ElectronCursor | undefined
): ComputerAppInputAnswer {
  const result = response.result ?? {};
  const point = cursor ? { cursor: { x: cursor.x, y: cursor.y } } : {};
  if (result.path === 'electron_typing_target_check') {
    return { delivered: false, effect: 'not_editable', evidence: { editable: false }, ...point };
  }
  if (!response.ok || result.code || result.delivery_accepted !== true) {
    // `preparatoryClickFailure`: the click that focuses the point before the text did not confirm, so nothing was typed.
    return {
      delivered: false,
      effect: 'click_unconfirmed',
      ...(typeof result.code === 'string' ? { code: result.code } : {}),
      ...(typeof result.text === 'string' ? { text: result.text } : {}),
      ...(typeof result.delivery_accepted === 'boolean' ? { deliveryAccepted: result.delivery_accepted } : {}),
      ...(typeof result.input_may_have_executed === 'boolean'
        ? { inputMayHaveExecuted: result.input_may_have_executed }
        : {}),
      ...point,
    };
  }
  return {
    delivered: true,
    effect: 'delivered',
    ...(input.op === 'type' ? { evidence: { editable: true } } : {}),
    ...(presses !== undefined ? { presses } : {}),
    ...(typeof result.pid === 'number' ? { pid: result.pid } : {}),
    ...point,
  };
}

export function registerComputerAppInput(connection: HostConnection, deps: ComputerAppInputDeps): void {
  connection.handleRequest(HOST_COMPUTER_APP_INPUT, async (params, signal): Promise<ComputerAppInputAnswer> => {
    const input = validate(params);
    const found = appWindowById(input.windowId);
    if (!found || gone(found)) invalid('the window is not owned by the desktop');
    const renderer = found as NonNullable<typeof found>;
    const bounds = appWindowBounds(renderer);
    const native = input.point ? { x: bounds.x + input.point.x, y: bounds.y + input.point.y } : undefined;
    let cursor: ElectronCursor | undefined;
    const dispatch: ElectronTextDispatch = {
      command: commandOf(input),
      target: {
        targetWindowId: input.windowId,
        allowedWindowIds: [input.windowId],
        ...(native ? { physicalX: native.x, physicalY: native.y } : {}),
      },
      renderer,
      // Every event that can reach the renderer is re-authorized right before it is sent: the core's abort and the window.
      authorizeDispatch: async (): Promise<DispatchAuthority> => {
        signal.throwIfAborted();
        if (gone(renderer)) throw new HostRpcError(HOST_COMMAND_FAILED, 'computer_window_gone');
        return {};
      },
      host: {
        sessionIdFor: () => input.sessionId,
        isObserveOnly: () => false,
        // The click that focuses a typing point lands in the renderer itself, never through the OS pointer.
        callPowerShell: async (request): Promise<PowerShellResponse> => {
          try {
            await sendElectronPointer(renderer, { x: Number(request.x), y: Number(request.y) }, { kind: 'click' });
            return { id: 0, ok: true, result: { action: 'click', delivery_accepted: true } };
          } catch (error) {
            return { id: 0, ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      },
      showCursor(shown) {
        cursor = shown;
        deps.showCursor(shown.sessionId, shown.x, shown.y, shown.action);
      },
    };
    try {
      let presses: number | undefined;
      let response: PowerShellResponse;
      if (input.op === 'type') response = await dispatchElectronText(dispatch);
      else if (input.op === 'key') {
        presses = electronKeyPresses(input.keys).length;
        response = await dispatchElectronInput(dispatch);
      } else if (input.op === 'wheel') response = await dispatchElectronInput(dispatch);
      else {
        response = await dispatchElectronPointer(dispatch, {
          kind: input.op,
          button: input.button,
          clicks: input.clicks,
          modifiers: input.modifiers,
        });
      }
      return answerOf(input, response, presses, cursor);
    } catch (error) {
      if (signal.aborted || error instanceof HostRpcError) {
        if (error instanceof HostRpcError && error.message === 'computer_window_gone') {
          return { delivered: false, effect: 'window_gone' };
        }
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (gone(renderer)) return { delivered: false, effect: 'window_gone' };
      if (message.startsWith('background_unsupported')) {
        return { delivered: false, effect: 'refused', code: 'background_unsupported', text: message };
      }
      throw new HostRpcError(HOST_COMMAND_FAILED, message);
    }
  });
}
