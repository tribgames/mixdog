/**
 * `host/computer/command` (dual path only): a whole bridge command the core relays to the desktop's Windows PowerShell host, as
 * `computer-bridge/client.mjs` would have posted it to the loopback bridge. The same policy applies (`assertPublicComputerRequest`
 * through the host's `assertPublic`, as `host/computer/capture` does); a frame the host returns is uploaded as a blob.
 *
 * A host that offers `answerScopedCommand` runs the command under the request's scope endpoint: each worker request of the
 * command is admitted through the scope's `commit` and signal and counted by its `track` (`computer/host/command-fence.ts`), a
 * request its worker's retirement ended until that worker's exit is observed; the route is then fenced by the scope. A host that
 * offers only `answerBridgeCommand` (the composition has not supplied the endpoint) runs it unfenced: the whole command is counted
 * by `trackUnfenced`, and one still out at the revocation leaves the scope's admission unconfirmed.
 */
import type {
  HostComputerCommandParams,
  HostComputerCommandResult,
} from '../../../../../packages/protocol/src/index.ts';
import { uploadBlob } from './browser-engine/blob-upload';
import { COMPUTER_UNAVAILABLE } from './computer';
import type { CommandEndpoint } from '../computer/host/command-fence';
import type { ComputerScopes } from './computer-scope';
import {
  HOST_COMMAND_FAILED,
  HOST_INVALID_PARAMS,
  HostRpcError,
  type HostConnection,
  objectParams,
} from './connection';

export const HOST_COMPUTER_COMMAND = 'host/computer/command';
/** The executor a relayed command runs in, as a scope's report names it. */
export const BRIDGE_COMMAND_EXECUTOR = 'bridge_command';

/** What the command handler needs from the computer host (`answerBridgeCommand` and the bridge's request policy). */
export interface ComputerCommandHost {
  /** Throws why `command` is not one a bridge caller may send (`assertPublicComputerRequest`). */
  assertPublic(command: unknown): void;
  answerBridgeCommand(command: unknown, signal: AbortSignal): Promise<CommandAnswer>;
  /** The command under the scope's endpoint: every worker request of it admitted and counted there. */
  answerScopedCommand?(command: unknown, endpoint: CommandEndpoint): Promise<CommandAnswer>;
}

type CommandAnswer =
  | { ok: true; value: { text: string; isError?: boolean; image?: { mimeType: string; data: string } } }
  | { ok: false; error: string };

/** The host while the desktop's PowerShell Windows host runs, else null. */
export type ComputerCommandHostSource = () => ComputerCommandHost | null;

export function registerComputerCommand(
  connection: HostConnection,
  source: ComputerCommandHostSource,
  scopes: ComputerScopes
): void {
  connection.handleRequest(HOST_COMPUTER_COMMAND, async (params, signal): Promise<HostComputerCommandResult> => {
    const { command } = objectParams<HostComputerCommandParams>(params, HOST_COMPUTER_COMMAND);
    const host = source();
    if (!host) throw new HostRpcError(HOST_COMMAND_FAILED, COMPUTER_UNAVAILABLE);
    try {
      host.assertPublic(command);
    } catch (error) {
      throw new HostRpcError(HOST_INVALID_PARAMS, `invalid request: ${(error as Error).message}`);
    }
    const scope = scopes.admit(params, signal);
    let answering: Promise<CommandAnswer>;
    if (host.answerScopedCommand) {
      // Fenced: each worker request is admitted and counted by the scope itself; the command as a whole is counted too, so the
      // scope's report waits for its answer.
      answering = host.answerScopedCommand(command, scope);
      scope.track(answering);
    } else {
      // Not fenced by this scope: inside the host a running command is stopped by Computer Use going off, not at each of its own
      // requests, so one still out at the revocation leaves the scope's admission unconfirmed.
      answering = host.answerBridgeCommand(command, scope.signal);
      scope.trackUnfenced(answering, BRIDGE_COMMAND_EXECUTOR);
    }
    const answer = await answering;
    // Answered after the revocation: the reply (a frame, text read from the screen) is not handed on.
    scope.commit();
    if (!answer.ok) return { ok: false, error: answer.error };
    const { text, isError, image } = answer.value;
    const result: HostComputerCommandResult = { ok: true, text, ...(isError ? { isError: true } : {}) };
    if (image) {
      const bytes = Buffer.from(image.data, 'base64');
      const blob = await uploadBlob(connection, bytes, image.mimeType);
      result.imageBlob = {
        digest: blob.digest,
        byteLength: bytes.byteLength,
        mimeType: image.mimeType,
      } as HostComputerCommandResult['imageBlob'];
    }
    return result;
  });
}
