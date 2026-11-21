import type { DesktopApi } from '../shared/contract';
import {
  MAX_VISUALIZE_SOURCE_BYTES,
  type VisualizePaneSource,
  type VisualizePaneText,
  type VisualizeRemotePaneFile,
} from '../shared/visualize';
import { bytesFromBase64, concat, readRemoteFile, type Call, type RangeResult } from './remote-file-range';
import { buildPageSrcdoc, resolvePageReference } from './remote-page-inliner';

import { useSyncExternalStore } from 'react';

// Streamed preview URLs embed the media session: when it changes (reconnect)
// the old URLs are dead, so mounted previews must resolve theirs again.
let mediaSessionEpoch = 0;
const mediaSessionListeners = new Set<() => void>();

/** Called when the authenticated media session is published or revoked. */
export function notifyMediaSessionChanged(): void {
  mediaSessionEpoch += 1;
  for (const listener of [...mediaSessionListeners]) listener();
}

export function subscribeMediaSession(listener: () => void): () => void {
  mediaSessionListeners.add(listener);
  return () => {
    mediaSessionListeners.delete(listener);
  };
}

export const getMediaSessionEpoch = (): number => mediaSessionEpoch;

/** Changes whenever the media session does; list it in the dependencies of an
 *  effect that calls `previewProjectFile` to re-resolve after a reconnect. */
export function useMediaSessionEpoch(): number {
  return useSyncExternalStore(subscribeMediaSession, getMediaSessionEpoch, getMediaSessionEpoch);
}

/** Largest file previewed whole in the browser; blob URLs hold it in memory. */
const REMOTE_PREVIEW_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Largest file one page `fetch`/XHR may read through the bridge. */
const PAGE_FETCH_MAX_BYTES = 16 * 1024 * 1024;
const BLOB_CACHE_LIMIT = 48;

/** A visualize pane's content for a paired client (main/remote-visualize.ts):
 *  the same bounded range reads and caps as file previews, addressed by tab
 *  and working-directory-relative path. Pages become a self-contained
 *  document with their relative assets inlined, plus a `fetch` the page
 *  bridge serves the page's own requests with; image, audio and video stream
 *  on the encrypted media lane when `laneUrl` yields one that answers;
 *  everything else (and media without the lane) becomes a blob: URL the
 *  caller revokes. */
export async function readRemoteVisualizePane(
  call: Call,
  sessionId: string,
  tabId: string,
  index: number,
  laneUrl?: (assetId: string, variant?: string) => string,
  /** This connection's built pages (none: every page is read). */
  pages?: RemotePageCache
): Promise<VisualizePaneSource> {
  // The host authorizes every load here (containment re-checked), cached or not.
  const meta = await call<VisualizeRemotePaneFile>('visualizePaneFile', [sessionId, tabId, index]);
  // The page builder and the whole-file reader speak the preview range call;
  // route it to the pane's own range method.
  const paneCall: Call = <T>(method: string, params: unknown[] = []) => {
    if (method !== 'previewProjectFileRange') return Promise.reject(new Error(`Unsupported pane call ${method}.`));
    // The pane index scopes `rel` to that pane's root (a kept version's
    // snapshot or the live files).
    return call<T>('visualizePaneRange', [sessionId, tabId, params[1], params[3], params[4], index]);
  };
  if (meta.kind === 'html') {
    // A revision bump with the same content (a reopen, a reload racing an
    // open, a reconnect) reuses the page this connection already built; only
    // the host's content identity keys it.
    const { contentId } = meta;
    const srcdoc =
      pages && contentId
        ? await pages.page([sessionId, tabId, index, meta.rel, contentId].join('\0'), () =>
            buildKeptPage(paneCall, meta.rel, contentId)
          )
        : await buildPageSrcdoc(paneCall, '', meta.rel, null);
    return {
      kind: 'html',
      srcdoc,
      page: meta.rel,
      ...(contentId ? { contentId } : {}),
      // The page's own fetch/XHR, over this load's call (never a cached
      // one): resolved against the page here, contained
      // and typed by the host exactly like an inlined asset.
      fetch: async (reference) => {
        const path = resolvePageReference(meta.rel, reference);
        if (!path) throw new Error('The page may only read its own project files.');
        const file = await readRemoteFile(paneCall, ['', path, null], PAGE_FETCH_MAX_BYTES);
        return { bytes: concat(file.parts), mime: file.mime };
      },
    };
  }
  const streamUrl =
    meta.mediaAssetId && (meta.kind === 'image' || meta.kind === 'audio' || meta.kind === 'video')
      ? laneUrl?.(meta.mediaAssetId, 'original')
      : '';
  if (streamUrl && (await mediaLaneAnswers(streamUrl))) return { kind: meta.kind, url: streamUrl };
  if (meta.size > REMOTE_PREVIEW_MAX_FILE_BYTES)
    throw new Error('This file is too large to preview over remote access.');
  const file = await readRemoteFile(paneCall, ['', meta.rel, null], REMOTE_PREVIEW_MAX_FILE_BYTES);
  return { kind: meta.kind, url: URL.createObjectURL(new Blob(file.parts as BlobPart[], { type: meta.mime })) };
}

const REMOTE_PAGE_CACHE_LIMIT = 6;

/** Built remote HTML pages of one authenticated connection, keyed by tab,
 *  pane and the host's content identity, in use order. `scope` names the
 *  pairing (server, device, keys): another one drops every page, and none
 *  keeps nothing. Only page text is kept; a page's fetch always goes over
 *  the load that asked for it. */
export function createRemotePageCache(scope: () => string | null) {
  let owner: string | null = null;
  const pages = new Map<string, Promise<string>>();
  return {
    clear(): void {
      pages.clear();
    },
    /** The page for `key`, built once per connection; `build` says whether
     *  its result may be kept. */
    page(key: string, build: () => Promise<{ srcdoc: string; keep: boolean }>): Promise<string> {
      const current = scope();
      if (current !== owner) {
        pages.clear();
        owner = current;
      }
      if (current === null) return build().then((page) => page.srcdoc);
      const kept = pages.get(key);
      if (kept) {
        pages.delete(key);
        pages.set(key, kept);
        return kept;
      }
      const built = build();
      const srcdoc = built.then((page) => page.srcdoc);
      pages.set(key, srcdoc);
      while (pages.size > REMOTE_PAGE_CACHE_LIMIT) pages.delete(pages.keys().next().value as string);
      const drop = () => {
        if (pages.get(key) === srcdoc) pages.delete(key);
      };
      void built.then((page) => {
        if (!page.keep) drop();
      }, drop);
      return srcdoc;
    },
  };
}
export type RemotePageCache = ReturnType<typeof createRemotePageCache>;

/** A page built for the cache: kept only when it inlined no other file (it
 *  is only as fresh as those) and was built from exactly the bytes the host
 *  hashed into `contentId`. */
async function buildKeptPage(
  paneCall: Call,
  rel: string,
  contentId: string
): Promise<{ srcdoc: string; keep: boolean }> {
  const parts: Uint8Array[] = [];
  let read = 0;
  let exact = true;
  const recording: Call = async <T>(method: string, params: unknown[] = []) => {
    const value = await paneCall<T>(method, params);
    if (params[1] !== rel || params[3] !== read) {
      exact = false;
    } else {
      const bytes = bytesFromBase64((value as RangeResult).data);
      parts.push(bytes);
      read += bytes.length;
    }
    return value;
  };
  const srcdoc = await buildPageSrcdoc(recording, '', rel, null);
  const subtle = globalThis.crypto?.subtle;
  if (!exact || !subtle) return { srcdoc, keep: false };
  const digest = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(concat(parts))));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { srcdoc, keep: hex === contentId.slice(contentId.lastIndexOf(':') + 1) };
}

/** An HTML pane's source for a paired client's source view: the start of the
 *  page file (at most MAX_VISUALIZE_SOURCE_BYTES) through the pane's own range
 *  method, so containment is checked by the host like any pane read. */
export async function readRemoteVisualizePaneText(
  call: Call,
  sessionId: string,
  tabId: string,
  index: number
): Promise<VisualizePaneText> {
  const meta = await call<VisualizeRemotePaneFile>('visualizePaneFile', [sessionId, tabId, index]);
  if (meta.kind !== 'html') throw new Error('Only HTML pages have a source view.');
  const range = await call<RangeResult>('visualizePaneRange', [
    sessionId,
    tabId,
    meta.rel,
    0,
    MAX_VISUALIZE_SOURCE_BYTES,
    index,
  ]);
  const bytes = bytesFromBase64(range.data);
  return { text: new TextDecoder().decode(bytes), truncated: range.size > bytes.length };
}

/** True when the encrypted media lane really answers for `url`; a relay or
 *  host that cannot (version skew) leaves the preview on the RPC path. */
async function mediaLaneAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
    void response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/** Blob URL promises in use order; an evicted URL is revoked so a long session stays bounded. */
function createBlobUrlCache() {
  const blobs = new Map<string, Promise<string>>();
  return (key: string, create: () => Promise<string>): Promise<string> => {
    let url = blobs.get(key);
    if (url) {
      blobs.delete(key);
    } else {
      url = create();
      url.catch(() => blobs.delete(key));
    }
    blobs.set(key, url);
    while (blobs.size > BLOB_CACHE_LIMIT) {
      const oldest = blobs.keys().next().value as string;
      const dropped = blobs.get(oldest);
      blobs.delete(oldest);
      void dropped?.then(
        (value) => URL.revokeObjectURL(value),
        () => {}
      );
    }
    return url;
  };
}

/** The remote implementations of the preview calls on DesktopApi.
 *  `laneUrl` yields an encrypted-media-lane URL for a host asset id, or ''
 *  when the lane is unavailable. */
export function createRemotePreviewApi(
  call: Call,
  laneUrl?: (assetId: string, variant?: string) => string
): Pick<DesktopApi, 'previewProjectFile' | 'localPageSource' | 'captureFileSnapshot'> {
  const blobUrl = createBlobUrlCache();
  return {
    captureFileSnapshot: (projectPath, relPath, accessToken) =>
      call('captureFileSnapshot', [projectPath, relPath, accessToken ?? null]),
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
      const url = await blobUrl(key, () =>
        readRemoteFile(call, target, REMOTE_PREVIEW_MAX_FILE_BYTES).then(({ parts }) =>
          URL.createObjectURL(new Blob(parts as BlobPart[], { type: meta.mime }))
        )
      );
      return { url, kind: meta.kind, mime: meta.mime, mtimeMs: meta.mtimeMs, size: meta.size };
    },
    localPageSource: (projectPath, relPath, accessToken) =>
      buildPageSrcdoc(call, projectPath, relPath, accessToken ?? null),
  };
}
