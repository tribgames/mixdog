// Browser side of remote file previews. Image/audio/video stream over the
// encrypted HTTP media lane when the host offers it (remote-media-lane.ts).
// Otherwise bytes arrive as bounded base64 ranges over the encrypted RPC lane
// and become blob: URLs; local web pages become a self-contained srcdoc
// document. See main/remote-file-preview.ts for the host half.
import type { DesktopApi } from '../shared/contract';

type Call = <T = unknown>(method: string, params?: unknown[]) => Promise<T>;

/** Raw bytes requested per round trip (host clamps to 4 MiB). */
export const REMOTE_PREVIEW_CHUNK_BYTES = 2 * 1024 * 1024;
/** Largest file previewed whole in the browser; blob URLs hold it in memory. */
export const REMOTE_PREVIEW_MAX_FILE_BYTES = 64 * 1024 * 1024;
const PAGE_MAX_BYTES = 4 * 1024 * 1024;
const PAGE_ASSET_MAX_BYTES = 2 * 1024 * 1024;
const PAGE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const PAGE_MAX_ASSETS = 64;
const BLOB_CACHE_LIMIT = 48;

interface RangeResult {
  data: string;
  mime: string;
  offset: number;
  size: number;
  mtimeMs: number;
}

function bytesFromBase64(data: string): Uint8Array {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
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
    const range = await call<RangeResult>('previewProjectFileRange', [
      ...target,
      offset,
      REMOTE_PREVIEW_CHUNK_BYTES,
    ]);
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

const EXTERNAL_REFERENCE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Project-relative path of a page reference, or '' when it is external or
 *  would climb out of the project root. */
export function resolvePageReference(pagePath: string, reference: string): string {
  const raw = reference.trim();
  if (!raw || EXTERNAL_REFERENCE.test(raw)) return '';
  let path = raw.split(/[?#]/, 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return '';
  }
  const segments: string[] = path.startsWith('/') ? [] : pagePath.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!segments.length) return '';
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join('/');
}

function dataUrl(parts: Uint8Array[], mime: string): string {
  let binary = '';
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 0x8000) {
      binary += String.fromCharCode(...part.subarray(index, index + 0x8000));
    }
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

const textOfParts = (parts: Uint8Array[]): string => new TextDecoder().decode(concat(parts));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A self-contained HTML document for `relPath`: stylesheets, scripts and
 *  media it references by relative path are inlined through the same RPC, so
 *  the sandboxed frame needs no network or origin access to the host. */
export async function buildPageSrcdoc(
  call: Call,
  projectPath: string,
  relPath: string,
  accessToken: string | null
): Promise<string> {
  const page = await readRemoteFile(call, [projectPath, relPath, accessToken], PAGE_MAX_BYTES);
  const doc = new DOMParser().parseFromString(textOfParts(page.parts), 'text/html');
  let budget = PAGE_TOTAL_MAX_BYTES;
  let assets = 0;
  const load = async (reference: string) => {
    const path = resolvePageReference(relPath, reference);
    if (!path || assets >= PAGE_MAX_ASSETS || budget <= 0) return null;
    assets += 1;
    try {
      const file = await readRemoteFile(call, [projectPath, path, accessToken], Math.min(PAGE_ASSET_MAX_BYTES, budget));
      budget -= file.size;
      return file;
    } catch {
      // A missing, hidden or oversize asset leaves its reference untouched.
      return null;
    }
  };
  for (const link of Array.from(doc.querySelectorAll('link[href]'))) {
    if (!/\bstylesheet\b/i.test(link.getAttribute('rel') || '')) continue;
    const file = await load(link.getAttribute('href') || '');
    if (!file) continue;
    const style = doc.createElement('style');
    style.textContent = textOfParts(file.parts);
    link.replaceWith(style);
  }
  for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
    const file = await load(script.getAttribute('src') || '');
    if (!file) continue;
    script.removeAttribute('src');
    script.textContent = textOfParts(file.parts).replace(/<\/(script)/gi, '<\\/$1');
  }
  for (const element of Array.from(doc.querySelectorAll('img[src], source[src], audio[src], video[src]'))) {
    const file = await load(element.getAttribute('src') || '');
    if (file) element.setAttribute('src', dataUrl(file.parts, file.mime));
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/** True when the encrypted media lane really answers for `url`. A relay or
 *  host that cannot (version skew) must leave the preview on the RPC path. */
async function mediaLaneAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
    void response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/** The remote implementations of the preview calls on DesktopApi.
 *  `laneUrl` yields an encrypted-media-lane URL for a host asset id, or ''
 *  when the lane is unavailable. */
export function createRemotePreviewApi(
  call: Call,
  laneUrl?: (assetId: string, variant?: string) => string
): Pick<DesktopApi, 'previewProjectFile' | 'localPageSource'> {
  // key -> blob URL promise; revoked when evicted so a long session stays bounded.
  const blobs = new Map<string, Promise<string>>();
  return {
    previewProjectFile: async (projectPath, relPath, accessToken) => {
      const target: [string, string, string | null] = [projectPath, relPath, accessToken ?? null];
      const meta = await call<{
        kind: 'image' | 'pdf' | 'audio' | 'video';
        mime: string;
        mtimeMs: number;
        size: number;
        /** Present when the host can serve this file on the media lane. */
        mediaAssetId?: string;
      }>('previewProjectFile', target);
      // Streamed and seekable: no whole-file download, so no size ceiling.
      const streamUrl = meta.mediaAssetId && meta.kind !== 'pdf' ? laneUrl?.(meta.mediaAssetId, 'original') : '';
      if (streamUrl && (await mediaLaneAnswers(streamUrl))) {
        return { url: streamUrl, kind: meta.kind, mime: meta.mime, mtimeMs: meta.mtimeMs, size: meta.size };
      }
      if (meta.size > REMOTE_PREVIEW_MAX_FILE_BYTES) {
        throw new Error('This file is too large to preview over remote access.');
      }
      const key = `${target.join('\0')}\0${meta.mtimeMs}:${meta.size}`;
      let url = blobs.get(key);
      if (url) {
        blobs.delete(key);
      } else {
        url = readRemoteFile(call, target, REMOTE_PREVIEW_MAX_FILE_BYTES).then(({ parts }) =>
          URL.createObjectURL(new Blob(parts as BlobPart[], { type: meta.mime }))
        );
        url.catch(() => blobs.delete(key));
      }
      blobs.set(key, url);
      while (blobs.size > BLOB_CACHE_LIMIT) {
        const oldest = blobs.keys().next().value as string;
        const dropped = blobs.get(oldest);
        blobs.delete(oldest);
        void dropped?.then((value) => URL.revokeObjectURL(value), () => {});
      }
      return { url: await url, kind: meta.kind, mime: meta.mime, mtimeMs: meta.mtimeMs, size: meta.size };
    },
    localPageSource: (projectPath, relPath, accessToken) =>
      buildPageSrcdoc(call, projectPath, relPath, accessToken ?? null),
  };
}
