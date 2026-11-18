/**
 * `host/visualize/command{...request}` → the visualize service's result, and
 * the visualize tabs' state for the core (`hostState.visualize`). This is the
 * loopback bridge without its listener: the params are the bridge's request
 * body, the result is the value the bridge wrapped as `{ ...value, ok: true }`,
 * and a failure carries the same message the bridge answered as `{ ok: false, error }`.
 */
import type { HostVisualizeCommandParams, VisualizeHostValue } from '../../../../../packages/protocol/src/index.ts';
import type { VisualizeHostEvent, VisualizeHostState } from '../../shared/visualize';
import { HOST_COMMAND_FAILED, HostRpcError, type HostConnection, objectParams } from './connection';
import { HOST_STATE_SET, sendHostState } from './browser-tabs';
import { MAX_INLINE_RESULT_BYTES, uploadBlob } from './browser-engine/blob-upload';
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

/** What the core keeps of a session's tabs (`VisualizePanes`) is each tab's cwd and each pane's kind, path and root, and
 *  whether history is empty; the rest is what a paired device pulls from the desktop when it shows a pane. So the wire
 *  state leaves out what is unbounded or large and unread: card thumbnails (60 KiB per tab), inline sources (`deferred`,
 *  as a paired device's snapshot has them), versions, problems, annotations (up to 120 per tab) and restore lists. What
 *  stays is bounded: at most 8 tabs of up to 3 panes per session and 50 history items. */
export function visualizeWireState(state: VisualizeHostState): VisualizeHostState {
  return {
    ...state,
    tabs: state.tabs.map(
      ({
        thumbnail: _thumbnail,
        thumbnailVersion: _thumbnailVersion,
        versions: _versions,
        problems: _problems,
        annotations: _annotations,
        restoreAssets: _restoreAssets,
        ...tab
      }) => ({
      ...tab,
      panes: tab.panes.map((pane) =>
        pane.inline
          ? {
              ...pane,
              inline: {
                kind: pane.inline.kind,
                source: '',
                ...(pane.inline.title ? { title: pane.inline.title } : {}),
                deferred: true as const,
              },
            }
          : pane
      ),
    })),
  };
}

/** One `host/state/set{key:'visualize'}` carrying `value` whole, whatever its size: a value over the frame budget is
 *  uploaded with `blob/put` and named by `{$blobRef, as:'text'}`, which the core expands to the JSON text before the
 *  method runs and parses as the snapshot or event it is. The snapshot replaces the core's whole map in one call, so it is
 *  atomic at any size. */
async function sendVisualizeValue(
  connection: HostConnection,
  value: VisualizeHostEvent | VisualizeHostState[]
): Promise<void> {
  const text = JSON.stringify(value);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= MAX_INLINE_RESULT_BYTES) {
    await sendHostState(connection, { key: 'visualize', value: value as VisualizeHostValue });
    return;
  }
  const { digest } = await uploadBlob(connection, bytes, 'application/json');
  await connection.request(HOST_STATE_SET, { key: 'visualize', value: { $blobRef: digest, as: 'text' } });
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
  // A large value is uploaded before its request goes: one queue, so a change published during a snapshot's upload is
  // sent after the snapshot. Every publication is built from the state at the moment it is enqueued (an event already
  // carries its session's state from when it was made), so enqueue order is also state order: a snapshot that waits behind
  // earlier work is not followed by an older event. The core applies one connection's publications in the order they
  // arrive on it, so no number or clock orders them.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (value: Parameters<typeof sendVisualizeValue>[1]): Promise<void> => {
    const sent = queue.then(() => sendVisualizeValue(connection, value));
    queue = sent.catch(() => undefined);
    return sent;
  };
  return {
    /** A change event of the service's `publishRemote`. */
    publish: (event: VisualizeHostEvent): Promise<void> =>
      enqueue({ ...event, ...(event.state ? { state: visualizeWireState(event.state) } : {}) }),
    /** After a claim: the core learns every session's tabs again, in one value (it replaces the core's whole map). */
    start(): void {
      try {
        void enqueue(control().snapshot().map(visualizeWireState)).catch(onPublishFailed);
      } catch (error) {
        onPublishFailed(error);
      }
    },
  };
}
