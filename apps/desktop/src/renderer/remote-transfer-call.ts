import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { BLOB_REF_FIELDS } from '../shared/core-lanes/blob-ref-fields';
import { sizedCall } from './core-direct/sized-call';

/** Use the phone's scoped client for both the transfer and its consuming RPC.
 * The method, origin, and permission checks on the final call are unchanged. */
export function phoneTransferCall(client: ProtocolClient<SessionFold>, method: string, params: unknown): Promise<unknown> {
  return Object.hasOwn(BLOB_REF_FIELDS, method)
    ? sizedCall(client, method, params)
    : client.call(method as never, params as never);
}
