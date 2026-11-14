/**
 * The Computer Use screen reads the core asks of the window process: a screen capture
 * (`host/computer/capture`) and the display list (`host/computer/displays`). Both are served by the one
 * computer host (`createComputerHost`): a capture is the command the loopback bridge would have been posted,
 * run through the bridge's own answer (`answerPublicCommand`: policy, dispatch, sealed reply), so the frame is
 * fitted and encoded by the host's capture engine and not again here.
 *
 * The rest of what a Computer Use helper needs from this process has a module of its own: the foreground-lock lease
 * (`computer-lease.ts`), the desktop's own windows every window list leaves out (`computer-internal-windows.ts`) and
 * the pointer progress the overlay draws (`computer-pointer.ts`).
 */
import type {
  HostComputerCaptureParams,
  HostComputerCaptureResult,
  HostComputerDisplay,
} from '../../../../../packages/protocol/src/index.ts';
import { registerComputerInternalWindows } from './computer-internal-windows';
import { registerComputerLease } from './computer-lease';
import { registerComputerPointer } from './computer-pointer';
import { HOST_COMMAND_FAILED, HOST_INVALID_PARAMS, HostRpcError, type HostConnection, objectParams } from './connection';

export const HOST_COMPUTER_CAPTURE = 'host/computer/capture';
export const HOST_COMPUTER_DISPLAYS = 'host/computer/displays';

/** What the client says when no desktop serves Computer Use (`computer-bridge/client.mjs` `BRIDGE_UNAVAILABLE_MESSAGE`). */
export const COMPUTER_UNAVAILABLE = 'computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings';

/** What the host serves from, handed in by the process that owns the computer host (it reaches Electron, which this module does not). */
export interface ComputerControl {
  /** Throws why `command` is not one a bridge caller may send (`assertPublicComputerRequest`). */
  assertPublic(command: unknown): void;
  /** The bridge's answer to one accepted command (`answerPublicCommand`). */
  answer(command: unknown, signal: AbortSignal): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  /** `readDisplays`. */
  displays(): HostComputerDisplay[];
}

/** The control while Computer Use is on, else null (the bridge Node would not have published). */
export type ComputerControlSource = () => ComputerControl | null;

export function registerComputerHost(connection: HostConnection, source: ComputerControlSource): void {
  const running = (): ComputerControl => {
    const control = source();
    if (!control) throw new HostRpcError(HOST_COMMAND_FAILED, COMPUTER_UNAVAILABLE);
    return control;
  };
  connection.handleRequest(HOST_COMPUTER_CAPTURE, async (params, signal): Promise<HostComputerCaptureResult> => {
    const { command } = objectParams<HostComputerCaptureParams>(params, HOST_COMPUTER_CAPTURE);
    const control = running();
    try {
      control.assertPublic(command);
    } catch (error) {
      throw new HostRpcError(HOST_INVALID_PARAMS, `invalid request: ${(error as Error).message}`);
    }
    const action = (command as { action?: unknown }).action;
    if (action !== 'capture') {
      throw new HostRpcError(HOST_INVALID_PARAMS, `${HOST_COMPUTER_CAPTURE} serves capture, not ${String(action)}.`);
    }
    const answer = await control.answer(command, signal);
    if (!answer.ok) throw new HostRpcError(HOST_COMMAND_FAILED, answer.error);
    return answer.value as HostComputerCaptureResult;
  });
  connection.handleRequest(HOST_COMPUTER_DISPLAYS, async (): Promise<HostComputerDisplay[]> => running().displays());
  registerComputerLease(connection);
  registerComputerInternalWindows(connection);
  registerComputerPointer(connection);
}