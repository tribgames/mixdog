/**
 * Moves bytes to the core's blob store with `blob/put`: content-addressed
 * (digest `sha256:` and 64 lowercase hex digits, `BlobDigest`), in raw chunks
 * whose base64 and request envelope fit one 256 KiB inbound frame.
 */
import { createHash } from 'node:crypto';

import type { BrowserBlobRef } from '../../../../../../packages/protocol/src/index.ts';
import type { HostConnection } from '../connection';

/** Raw bytes per `blob/put` (a multiple of 3, so no chunk but the last carries base64 padding). */
export const BLOB_PUT_CHUNK_BYTES = 96 * 1024;

/** A serialized result above this does not travel in a response (192 KiB). */
export const MAX_INLINE_RESULT_BYTES = 192 * 1024;

export function blobDigestOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Uploads `bytes` and answers the ref the result carries. `blob/put` is
 * content-addressed and names no media type, so `mimeType` is not sent: the
 * result that holds the ref states it (`mimeType` of a screenshot).
 */
export async function uploadBlob(
  connection: HostConnection,
  bytes: Uint8Array,
  _mimeType: string
): Promise<BrowserBlobRef> {
  const digest = blobDigestOf(bytes);
  let offset = 0;
  do {
    const chunk = bytes.subarray(offset, offset + BLOB_PUT_CHUNK_BYTES);
    await connection.request('blob/put', {
      digest,
      offset,
      bytesB64: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64'),
    });
    offset += chunk.byteLength;
  } while (offset < bytes.byteLength);
  return { digest, size: bytes.byteLength };
}
