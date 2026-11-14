// A request whose frame would exceed what the core accepts inbound: its large listed string fields are uploaded with blob/put and
// replaced by {$blobRef, as} (mixdog-core-domains blob/param_refs.rs expands them before the method runs).
import { BLOB_REF_FIELDS } from '../../shared/core-lanes/blob-ref-fields';

/** Above this many bytes the request is measured field by field; the frame bound itself comes from the initialize reply. */
const SEND_BOUND_BYTES = 192 * 1024;
/** A listed string field shorter than this stays inline. */
const FIELD_BLOB_BYTES = 64 * 1024;
/** Room kept in a frame for the JSON-RPC envelope around the params (limits.rs BLOB_PUT_ENVELOPE_BYTES). */
const ENVELOPE_BYTES = 4 * 1024;
const DEFAULT_MAX_INBOUND_FRAME_BYTES = 256 * 1024;

export interface SizedCallClient {
  readonly server: { readonly limits: { readonly maxInboundFrameBytes?: number } };
  call(method: never, params: never): Promise<unknown>;
  putBlob(bytes: Uint8Array, mediaType: string): Promise<{ readonly blob: { readonly digest: string } }>;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Container = Json[] | { [key: string]: Json };

const encoder = new TextEncoder();
const bytesOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/** Every [container, key] whose path matches `pointer` (`*` matches any one key or index) and whose value is a string. */
function stringSlots(root: Json, pointer: string): Array<[Container, string]> {
  const slots: Array<[Container, string]> = [];
  const walk = (node: Json, rest: string[]): void => {
    if (node === null || typeof node !== 'object') return;
    const [head, ...tail] = rest;
    const keys = head === '*' ? Object.keys(node) : Object.prototype.hasOwnProperty.call(node, head) ? [head] : [];
    for (const key of keys) {
      const child = (node as Record<string, Json>)[key];
      if (tail.length === 0) {
        if (typeof child === 'string') slots.push([node, key]);
      } else walk(child, tail);
    }
  };
  walk(root, pointer.split('/').slice(1).map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~')));
  return slots;
}

const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The bytes of a padded standard base64 string, or null when it is not one. The core expands a "base64" reference as the
 * padded standard encoding of the blob, so only text that encoding gives back is sent that way.
 */
function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64_BODY.test(text)) return null;
  try {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * What a string field uploads as: a base64 image/audio/attachment field as "base64" (its bytes), anything else, a data URL
 * included, as "text", so the method receives exactly the string the caller gave (a "base64" reference expands without the
 * `data:...;base64,` prefix).
 */
function blobOf(pointer: string, value: string): { bytes: Uint8Array; as: 'text' | 'base64'; mediaType: string } {
  if (isBase64Field(pointer)) {
    const bytes = decodeBase64(value);
    if (bytes) return { bytes, as: 'base64', mediaType: 'application/octet-stream' };
  }
  return { bytes: encoder.encode(value), as: 'text', mediaType: 'text/plain; charset=utf-8' };
}

/** The listed pointers that hold base64: image, file and audio data, never text content. */
function isBase64Field(pointer: string): boolean {
  return /\/(data|base64)$/.test(pointer) || /\/pastedImages\/\*\/content$/.test(pointer);
}

/**
 * Sends `method` with `params`, uploading what would not fit one inbound frame. The caller's params are not changed.
 * A request still over the frame bound once its listed fields are references throws a TypeError naming the largest field.
 */
export async function sizedCall(client: SizedCallClient, method: string, params: unknown): Promise<unknown> {
  const send = (body: unknown): Promise<unknown> => (client.call as (m: string, p: unknown) => Promise<unknown>)(method, body);
  const frameBound = (client.server.limits.maxInboundFrameBytes ?? DEFAULT_MAX_INBOUND_FRAME_BYTES) - ENVELOPE_BYTES;
  const size = bytesOf(params);
  if (size <= Math.min(SEND_BOUND_BYTES, frameBound)) return send(params);
  const pointers = BLOB_REF_FIELDS[method];
  if (!pointers) {
    if (size <= frameBound) return send(params);
    throw new TypeError(`${method} is too large to send: the request is ${size} bytes and the core accepts ${frameBound} bytes in one frame.`);
  }
  const body = structuredClone(params) as Json;
  for (const pointer of pointers) {
    for (const [container, key] of stringSlots(body, pointer)) {
      const value = (container as Record<string, Json>)[key] as string;
      if (value.length < FIELD_BLOB_BYTES / 3 || encoder.encode(value).length <= FIELD_BLOB_BYTES) continue;
      const blob = blobOf(pointer, value);
      const ref = await client.putBlob(blob.bytes, blob.mediaType);
      (container as Record<string, Json>)[key] = { $blobRef: ref.blob.digest, as: blob.as };
    }
  }
  const total = bytesOf(body);
  if (total <= frameBound) return send(body);
  let largest = { pointer: pointers[0], bytes: 0 };
  for (const pointer of pointers) {
    for (const [container, key] of stringSlots(body, pointer)) {
      const bytes = encoder.encode((container as Record<string, Json>)[key] as string).length;
      if (bytes > largest.bytes) largest = { pointer, bytes };
    }
  }
  throw new TypeError(`${largest.pointer} is too large to send: the request is ${total} bytes and the core accepts ${frameBound} bytes in one frame.`);
}
