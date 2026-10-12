// Authenticated encryption for the relay's HTTP media lane.
//
// The relay proxies `/media/<asset>` as opaque bytes, so everything it carries
// is a sequence of FRAMES sealed with the session's media key
// (RelayE2EEChannel.mediaKey):
//
//   frame = u32be(length) | nonce(12) | AES-GCM ciphertext+tag
//   response = meta frame, then one data frame per 64 KiB plaintext segment
//
// Every frame has its own random nonce, and its AAD binds the asset id,
// variant and position, so a frame cannot be moved to another asset, offset or
// size, or replayed into a different slot. A different session has a different
// key, so frames cannot cross sessions either. public/sw-media.js decodes the
// same format in the browser; sw-media.test.mjs pins the two together.
const MEDIA_CONTEXT = 'mixdog-relay-media-v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const LENGTH_BYTES = 4;
const MAX_META_PLAINTEXT_BYTES = 4096;

/** The `enc` query value a client sends to opt into this protocol. A request
 *  without it (an older renderer expecting plaintext bytes) is never answered
 *  with ciphertext: the host treats it as "no media here". */
export const MEDIA_SCHEME = 'e2ee1';

/** Plaintext bytes per data frame; ranges are served on this grid. */
export const MEDIA_SEGMENT_BYTES = 64 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface MediaAssetRef {
  assetId: string;
  variant: string;
}

/** What the host says about the window it is about to send. `start`/`end` are
 *  the inclusive plaintext bounds of this response (segment aligned). */
export interface MediaWindowMeta {
  size: number;
  mime: string;
  start: number;
  end: number;
}

/** A standalone copy: a Node Buffer's own `slice` is a view over a shared pool,
 *  so its `.buffer` would be far more than the bytes meant. */
function bytesOf(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function metaAad(asset: MediaAssetRef, start: number): ArrayBuffer {
  return bytesOf(encoder.encode(`${MEDIA_CONTEXT}\0meta\0${asset.assetId}\0${asset.variant}\0${start}`));
}

function dataAad(asset: MediaAssetRef, offset: number, size: number): ArrayBuffer {
  return bytesOf(encoder.encode(`${MEDIA_CONTEXT}\0data\0${asset.assetId}\0${asset.variant}\0${offset}\0${size}`));
}

async function seal(key: CryptoKey, plaintext: Uint8Array, additionalData: ArrayBuffer): Promise<Uint8Array> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytesOf(nonce), additionalData },
      key,
      bytesOf(plaintext)
    )
  );
  const frame = new Uint8Array(LENGTH_BYTES + NONCE_BYTES + sealed.byteLength);
  new DataView(frame.buffer).setUint32(0, NONCE_BYTES + sealed.byteLength, false);
  frame.set(nonce, LENGTH_BYTES);
  frame.set(sealed, LENGTH_BYTES + NONCE_BYTES);
  return frame;
}

async function open(key: CryptoKey, body: Uint8Array, additionalData: ArrayBuffer): Promise<Uint8Array> {
  if (body.byteLength < NONCE_BYTES + TAG_BYTES) throw new Error('Truncated media frame.');
  return new Uint8Array(
    await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesOf(body.subarray(0, NONCE_BYTES)), additionalData },
      key,
      bytesOf(body.subarray(NONCE_BYTES))
    )
  );
}

export function encryptMediaMeta(key: CryptoKey, asset: MediaAssetRef, meta: MediaWindowMeta): Promise<Uint8Array> {
  return seal(key, encoder.encode(JSON.stringify(meta)), metaAad(asset, meta.start));
}

export function encryptMediaSegment(
  key: CryptoKey,
  asset: MediaAssetRef,
  offset: number,
  size: number,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  return seal(key, plaintext, dataAad(asset, offset, size));
}

/** `expectedStart` is the segment-aligned offset the caller asked for: a meta
 *  frame answering a different request fails authentication. */
export async function decryptMediaMeta(
  key: CryptoKey,
  asset: MediaAssetRef,
  expectedStart: number,
  body: Uint8Array
): Promise<MediaWindowMeta> {
  const plaintext = await open(key, body, metaAad(asset, expectedStart));
  const meta = JSON.parse(decoder.decode(plaintext)) as Partial<MediaWindowMeta>;
  if (
    !Number.isSafeInteger(meta.size) ||
    !Number.isSafeInteger(meta.start) ||
    !Number.isSafeInteger(meta.end) ||
    typeof meta.mime !== 'string' ||
    meta.start !== expectedStart ||
    (meta.end as number) < (meta.start as number) - 1 ||
    (meta.end as number) >= (meta.size as number)
  ) {
    throw new Error('Invalid media window.');
  }
  return meta as MediaWindowMeta;
}

export function decryptMediaSegment(
  key: CryptoKey,
  asset: MediaAssetRef,
  offset: number,
  size: number,
  body: Uint8Array
): Promise<Uint8Array> {
  return open(key, body, dataAad(asset, offset, size));
}

/** Re-frames an arbitrarily chunked byte stream into frame bodies
 *  (nonce + ciphertext), rejecting lengths no honest host produces. */
export function createMediaFrameReader(): { push(chunk: Uint8Array): Uint8Array[] } {
  let pending = new Uint8Array(0);
  const maxBody = Math.max(MEDIA_SEGMENT_BYTES, MAX_META_PLAINTEXT_BYTES) + NONCE_BYTES + TAG_BYTES;
  return {
    push(chunk) {
      const joined = new Uint8Array(pending.byteLength + chunk.byteLength);
      joined.set(pending, 0);
      joined.set(chunk, pending.byteLength);
      const bodies: Uint8Array[] = [];
      let at = 0;
      while (joined.byteLength - at >= LENGTH_BYTES) {
        const length = new DataView(joined.buffer, joined.byteOffset + at, LENGTH_BYTES).getUint32(0, false);
        if (length < NONCE_BYTES + TAG_BYTES || length > maxBody) throw new Error('Invalid media frame length.');
        if (joined.byteLength - at - LENGTH_BYTES < length) break;
        bodies.push(joined.slice(at + LENGTH_BYTES, at + LENGTH_BYTES + length));
        at += LENGTH_BYTES + length;
      }
      pending = joined.slice(at);
      return bodies;
    },
  };
}
