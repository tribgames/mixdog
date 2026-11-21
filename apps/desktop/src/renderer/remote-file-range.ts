export type Call = <T = unknown>(method: string, params?: unknown[]) => Promise<T>;

/** Raw bytes requested per round trip (host clamps to 4 MiB). */
export const REMOTE_PREVIEW_CHUNK_BYTES = 2 * 1024 * 1024;

export interface RangeResult {
  data: string;
  mime: string;
  offset: number;
  size: number;
  mtimeMs: number;
}

export function bytesFromBase64(data: string): Uint8Array {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Reads a whole file in sequential ranges; refuses anything over `maxBytes`
 *  before the first byte moves (size comes from the first range). */
export async function readRemoteFile(
  call: Call,
  target: [string, string, string | null],
  maxBytes: number
): Promise<{ parts: Uint8Array[]; mime: string; size: number }> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let size = Infinity;
  let mime = 'application/octet-stream';
  while (offset < size) {
    const range = await call<RangeResult>('previewProjectFileRange', [...target, offset, REMOTE_PREVIEW_CHUNK_BYTES]);
    size = range.size;
    mime = range.mime;
    if (size > maxBytes) throw new Error('This file is too large to preview over remote access.');
    const bytes = bytesFromBase64(range.data);
    if (!bytes.length) break;
    parts.push(bytes);
    offset += bytes.length;
  }
  return { parts, mime, size: offset };
}
