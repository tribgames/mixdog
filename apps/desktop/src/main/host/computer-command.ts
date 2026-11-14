/**
 * `host/computer/command` (dual path only): a whole bridge command the core relays to the legacy Windows PowerShell host, as
 * `computer-bridge/client.mjs` would have posted it to the loopback bridge. The same policy applies (`assertPublicComputerRequest`
 * through the host's `assertPublic`, as `host/computer/capture` does); a frame the host returns is uploaded as a blob.
 */
import type {
  HostComputerCommandParams,
  HostComputerCommandResult,
} from '../../../../../packages/protocol/src/index.ts';
import { uploadBlob } from './browser-engine/blob-upload';
import { COMPUTER_UNAVAILABLE } from './computer';
import { HOST_COMMAND_FAILED, HOST_INVALID_PARAMS, HostRpcError, type HostConnection, objectParams } from './connection';

export const HOST_COMPUTER_COMMAND = 'host/computer/command';

/** What the command handler needs from the computer host (`answerBridgeCommand` and the bridge's request policy). */
export interface ComputerCommandHost {
  /** Throws why `command` is not one a bridge caller may send (`assertPublicComputerRequest`). */
  assertPublic(command: unknown): void;
  answerBridgeCommand(
    command: unknown,
    signal: AbortSignal
  ): Promise<
    | { ok: true; value: { text: string; isError?: boolean; image?: { mimeType: string; data: string } } }
    | { ok: false; error: string }
  >;
}

/** The host while the legacy Windows host runs, else null. */
export type ComputerCommandHostSource = () => ComputerCommandHost | null;

export function registerComputerCommand(connection: HostConnection, source: ComputerCommandHostSource): void {
  connection.handleRequest(HOST_COMPUTER_COMMAND, async (params, signal): Promise<HostComputerCommandResult> => {
    const { command } = objectParams<HostComputerCommandParams>(params, HOST_COMPUTER_COMMAND);
    const host = source();
    if (!host) throw new HostRpcError(HOST_COMMAND_FAILED, COMPUTER_UNAVAILABLE);
    try {
      host.assertPublic(command);
    } catch (error) {
      throw new HostRpcError(HOST_INVALID_PARAMS, `invalid request: ${(error as Error).message}`);
    }
    const answer = await host.answerBridgeCommand(command, signal);
    if (!answer.ok) return { ok: false, error: answer.error };
    const { text, isError, image } = answer.value;
    const result: HostComputerCommandResult = { ok: true, text, ...(isError ? { isError: true } : {}) };
    if (image) {
      const bytes = Buffer.from(image.data, 'base64');
      const blob = await uploadBlob(connection, bytes, image.mimeType);
      result.imageBlob = { digest: blob.digest, byteLength: bytes.byteLength, mimeType: image.mimeType } as HostComputerCommandResult['imageBlob'];
    }
    return result;
  });
}
