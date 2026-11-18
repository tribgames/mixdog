// A payload that may be larger than one inbound frame goes to the core as a blob (`blob/put`, content-addressed, in chunks) and the
// request carries `{ $blobRef, as }` where the string would be; the app server expands it at the pointers `blob_fields.json` lists
// before the method runs (mixdog-core-domains blob/param_refs.rs).
import type { ProtocolConnection } from './protocol/connection';
import { uploadBlob } from './computer/pixels/blob-upload';
import { blobDigestOf } from './host/browser-engine/blob-upload';

export interface BlobRef {
  $blobRef: string;
  as: 'text' | 'base64';
}

/** The uploads under way, by core connection and digest. */
const uploading = new WeakMap<object, Map<string, Promise<void>>>();

/** Has the core the blob? A read of one byte from its start: the core answers `blobNotFound` for one it does not hold (and
 *  waits for a blob another connection has just finished uploading, so it is not uploaded twice). */
async function stored(core: Pick<ProtocolConnection, 'call'>, digest: string): Promise<boolean> {
  try {
    await core.call('blob/read', { digest, offset: 0, length: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Uploads `bytes` unless the core already holds them, and answers the reference to put in the listed field: `text` is read back
 * as the bytes' UTF-8 text, `base64` as their standard base64. A digest is uploaded by one caller at a time: concurrent callers
 * with the same content (two pages that carry the same library) wait for that upload and share its outcome.
 */
export async function putBlobRef(
  core: Pick<ProtocolConnection, 'call'>,
  bytes: Uint8Array,
  as: BlobRef['as']
): Promise<BlobRef> {
  const digest = blobDigestOf(bytes);
  const flights = uploading.get(core) ?? new Map<string, Promise<void>>();
  uploading.set(core, flights);
  let flight = flights.get(digest);
  if (!flight) {
    flight = (async () => {
      if (!(await stored(core, digest))) await uploadBlob((method, params) => core.call(method, params), bytes);
    })().finally(() => flights.delete(digest));
    flights.set(digest, flight);
  }
  await flight;
  return { $blobRef: digest, as };
}
