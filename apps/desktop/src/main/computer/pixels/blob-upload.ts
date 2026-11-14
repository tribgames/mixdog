/**
 * Moves encoded pixels into the core's blob store with `blob/put` (content-addressed: `sha256:` and 64 hex digits), in raw
 * chunks under the core's `limits.maxBlobPutChunkBytes`, so a capture larger than one inbound frame never drops the host
 * connection. `callCore` is the host connection's request to the core.
 */
import {
  BLOB_PUT_CHUNK_BYTES,
  blobDigestOf,
} from "../../host/browser-engine/blob-upload";

export type CallCore = (method: string, params: unknown) => Promise<unknown>;

export interface UploadedBlob {
  digest: string;
  byteLength: number;
}

/** The chunk size actually used: at most `chunkBytes` (the default fits every core's limit), a multiple of 3 so that no
 *  chunk but the last carries base64 padding, and never below 3. */
export function blobChunkBytes(
  chunkBytes: number = BLOB_PUT_CHUNK_BYTES,
): number {
  const bounded = Math.min(Math.floor(chunkBytes), BLOB_PUT_CHUNK_BYTES);
  return Math.max(3, bounded - (bounded % 3));
}

export async function uploadBlob(
  callCore: CallCore,
  bytes: Uint8Array,
  chunkBytes?: number,
): Promise<UploadedBlob> {
  const digest = blobDigestOf(bytes);
  const step = blobChunkBytes(chunkBytes);
  let offset = 0;
  do {
    const chunk = bytes.subarray(offset, offset + step);
    await callCore("blob/put", {
      digest,
      offset,
      bytesB64: Buffer.from(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength,
      ).toString("base64"),
    });
    offset += chunk.byteLength;
  } while (offset < bytes.byteLength);
  return { digest, byteLength: bytes.byteLength };
}
