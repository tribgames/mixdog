// A payload that may be larger than one inbound frame goes to the core as a blob (`blob/put`, content-addressed, in chunks) and the
// request carries `{ $blobRef, as }` where the string would be; the app server expands it at the pointers `blob_fields.json` lists
// before the method runs (mixdog-core-domains blob/param_refs.rs).
import type { ProtocolConnection } from './protocol/connection';
import { uploadBlob } from './computer/pixels/blob-upload';

export interface BlobRef {
  $blobRef: string;
  as: 'text' | 'base64';
}

/** Uploads `bytes` and answers the reference to put in the listed field: `text` is read back as the bytes' UTF-8 text, `base64` as their standard base64. */
export async function putBlobRef(
  core: Pick<ProtocolConnection, 'call'>,
  bytes: Uint8Array,
  as: BlobRef['as']
): Promise<BlobRef> {
  const { digest } = await uploadBlob((method, params) => core.call(method, params), bytes);
  return { $blobRef: digest, as };
}
