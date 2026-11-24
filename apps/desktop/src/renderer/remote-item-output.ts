import { rowOf } from '../../../../packages/protocol-client/src/index.ts';
import { findToolRecord, REMOTE_OUTPUT_TRUNCATED_FIELD } from '../main/remote-transcript';
import { record } from './record-utils';

/** What the whole output is read with: the core's `thread/items/read`, and the blob a large field is stored as. */
export interface WholeOutputReader {
  call(method: string, params: unknown): Promise<unknown>;
  readBlob?(ref: { blob: unknown }): Promise<Uint8Array>;
}

/** Whether the core sent this tool row's output cut to the size the phone announced (`toolOutput`): the row says how long the output
 *  was (`remoteOutputTruncated`, the same field the phone's own cut writes on its copy, which the folded row never carries). */
export function outputCutByCore(state: unknown, itemId: string): boolean {
  const held = findToolRecord(state, itemId);
  return typeof held?.[REMOTE_OUTPUT_TRUNCATED_FIELD] === 'number';
}

async function textOf(reader: WholeOutputReader, value: unknown): Promise<unknown> {
  const stub = record(value);
  return stub.blob !== undefined && reader.readBlob ? new TextDecoder().decode(await reader.readBlob(stub as { blob: unknown })) : value;
}

/** The uncut output of one tool row, read from the core: what "show full output" shows. Null when the core no longer has the row. */
export async function readWholeToolOutput(
  reader: WholeOutputReader,
  threadId: string,
  itemId: string,
  /** The core's id of the row, when the row the phone holds is named by another (a live card's call). */
  coreItemId: string = itemId
): Promise<{ id: string; result?: unknown; rawResult?: unknown; uiDiff?: unknown } | null> {
  const reply = record(await reader.call('thread/items/read', { threadId, itemIds: [coreItemId] }));
  const item = (Array.isArray(reply.items) ? reply.items : []).map(record).find((candidate) => candidate.id === coreItemId);
  if (!item) return null;
  const run = record(item.run);
  const whole = {
    ...item,
    ...(item.output === undefined ? {} : { output: await textOf(reader, item.output) }),
    run: {
      ...run,
      ...Object.fromEntries(
        await Promise.all(
          (['result', 'rawResult', 'uiDiff'] as const)
            .filter((field) => run[field] !== undefined)
            .map(async (field) => [field, await textOf(reader, run[field])] as const)
        )
      ),
    },
  };
  const row = rowOf(whole as Parameters<typeof rowOf>[0]);
  if (!row) return null;
  return {
    id: itemId,
    ...(Object.hasOwn(row, 'result') ? { result: row.result } : {}),
    ...(Object.hasOwn(row, 'rawResult') ? { rawResult: row.rawResult } : {}),
    ...(Object.hasOwn(row, 'uiDiff') ? { uiDiff: row.uiDiff } : {}),
  };
}
