/**
 * `host/visualize/command{...request}` → the visualize service's result, and
 * the visualize tabs' state for the core (`hostState.visualize`). This is the
 * loopback bridge without its listener: the params are the bridge's request
 * body, the result is the value the bridge wrapped as `{ ...value, ok: true }`,
 * and a failure carries the same message the bridge answered as `{ ok: false, error }`.
 */
import { HOST_COMMAND_FAILED, HostRpcError, type HostConnection, objectParams } from './connection';
import { HOST_STATE_SET } from './browser-tabs';

export const HOST_VISUALIZE_COMMAND = 'host/visualize/command';

export interface VisualizeControl {
  /** The visualize service's `execute` (what the bridge ran). */
  execute(command: object): Promise<unknown>;
  /** The service's `hostSnapshot`: every session's host state, sent again on a claim. */
  snapshot(): unknown;
}

export function createVisualizeHost(
  connection: HostConnection,
  control: () => VisualizeControl,
  /** The claim-time snapshot could not be sent (change events report through the publisher's own path). */
  onPublishFailed: (error: unknown) => void
) {
  connection.handleRequest(HOST_VISUALIZE_COMMAND, async (params) => {
    const command = objectParams(params, HOST_VISUALIZE_COMMAND);
    try {
      return (await control().execute(command)) ?? null;
    } catch (error) {
      throw new HostRpcError(HOST_COMMAND_FAILED, (error as Error)?.message || String(error));
    }
  });
  const send = (value: unknown): Promise<void> =>
    connection.request(HOST_STATE_SET, { section: 'visualize', value }).then(() => undefined);
  return {
    /** A change event of the service's `publishRemote`. */
    publish: send,
    /** After a claim: the core learns every session's tabs again. */
    start(): void {
      void Promise.resolve()
        .then(() => send(control().snapshot()))
        .catch(onPublishFailed);
    },
  };
}
