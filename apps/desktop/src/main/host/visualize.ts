/**
 * `host/visualize/command{...request}` → the visualize service's result, and
 * the visualize tabs' state for the core (`hostState.visualize`). This is the
 * loopback bridge without its listener: the params are the bridge's request
 * body, the result is the value the bridge wrapped as `{ ...value, ok: true }`,
 * and a failure carries the same message the bridge answered as `{ ok: false, error }`.
 */
import type { HostVisualizeCommandParams } from '../../../../../packages/protocol/src/index.ts';
import type { VisualizeHostEvent, VisualizeHostState } from '../../shared/visualize';
import { HOST_COMMAND_FAILED, HostRpcError, type HostConnection, objectParams } from './connection';
import { sendHostState } from './browser-tabs';
import { requiredVisualizeTabCommand } from '../ipc-validation';

export const HOST_VISUALIZE_COMMAND = 'host/visualize/command';

export interface VisualizeControl {
  /** The visualize service's `execute` (what the bridge ran). */
  execute(command: object): Promise<unknown>;
  /** The service's `exportForDevice`: a pane's PNG / PDF drawn into a fresh temp folder; `{path, pages?}`. */
  exportForDevice(command: ReturnType<typeof requiredVisualizeTabCommand>): Promise<unknown>;
  /** The service's `hostSnapshot`: every session's host state (a list), sent again on a claim. */
  snapshot(): VisualizeHostState[];
}

/** The core marks an export for a device with `input.forDevice`; no other action carries it. */
function forDevice(input: unknown): boolean {
  return !!input && typeof input === 'object' && (input as { forDevice?: unknown }).forDevice === true;
}

export function createVisualizeHost(
  connection: HostConnection,
  control: () => VisualizeControl,
  /** The claim-time snapshot could not be sent (change events report through the publisher's own path). */
  onPublishFailed: (error: unknown) => void
) {
  connection.handleRequest(HOST_VISUALIZE_COMMAND, async (params) => {
    const command = objectParams<HostVisualizeCommandParams>(params, HOST_VISUALIZE_COMMAND);
    try {
      if (command.action === 'export' && forDevice(command.input)) {
        // A paired device's export (the core's `export` transfer source): what main's
        // `visualizeExport` host method ran (remote-visualize.ts:329, index.ts `visualizeExport`).
        const valid = requiredVisualizeTabCommand({ ...(command.input as object), action: 'export' });
        if (valid.action !== 'export' || valid.format === 'project') throw new TypeError('export format is invalid.');
        return (await control().exportForDevice(valid)) ?? null;
      }
      return (await control().execute(command)) ?? null;
    } catch (error) {
      throw new HostRpcError(HOST_COMMAND_FAILED, (error as Error)?.message || String(error));
    }
  });
  return {
    /** A change event of the service's `publishRemote`. */
    publish: (event: VisualizeHostEvent): Promise<void> =>
      sendHostState(connection, { key: 'visualize', value: event }),
    /** After a claim: the core learns every session's tabs again. */
    start(): void {
      void Promise.resolve()
        .then(() => sendHostState(connection, { key: 'visualize', value: control().snapshot() }))
        .catch(onPublishFailed);
    },
  };
}
