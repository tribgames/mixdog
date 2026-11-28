import type { DesktopApi } from '../shared/contract';
import {
  MAX_VISUALIZE_SOURCE_BYTES,
  type VisualizePaneSource,
  type VisualizePaneText,
  type VisualizeRemotePaneFile,
} from '../shared/visualize';
import { bytesFromBase64, concat, readRemoteFile, type Call, type RangeResult } from './remote-file-range';
import { buildPageSrcdoc, resolvePageReference } from './remote-page-inliner';
import { registerIdleReclaim } from './idle-reclaim';
import { enforceRendererCacheBudget, registerBudgetedCache } from './renderer-cache-budget';
import type { RemotePageCache } from './remote-page-cache';

import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useSurfaceActive } from './surface-activity';

export { createRemotePageCache, type RemotePageCache } from './remote-page-cache';

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

type BlobUrlOwner = {
  onLeaseReleased(url: string): void;
};

const REVOKED_BLOB_HISTORY_LIMIT = 1024;
const liveBlobUrlOwners = new Map<string, BlobUrlOwner>();
const revokedBlobUrls = new Set<string>();
const heldBlobUrls = new Map<string, number>();

function recordRevokedBlobUrl(url: string): void {
  revokedBlobUrls.delete(url);
  revokedBlobUrls.add(url);
  if (revokedBlobUrls.size > REVOKED_BLOB_HISTORY_LIMIT) {
    const oldest = revokedBlobUrls.values().next().value;
    if (oldest !== undefined) revokedBlobUrls.delete(oldest);
  }
}

function isManagedBlobUrl(url: string): boolean {
  return liveBlobUrlOwners.has(url) || revokedBlobUrls.has(url);
}

/** Pins a live remote preview `blob:` URL while an active view displays it.
 *  Returns `null` when `url` is a `blob:` URL not currently live in the cache. */
export function retainBlobPreviewUrl(url: string): (() => void) | null {
  if (!url || !url.startsWith('blob:')) return () => {};
  const owner = liveBlobUrlOwners.get(url);
  if (!owner) return null;
  heldBlobUrls.set(url, (heldBlobUrls.get(url) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (heldBlobUrls.get(url) ?? 1) - 1;
    if (count > 0) {
      heldBlobUrls.set(url, count);
      return;
    }
    heldBlobUrls.delete(url);
    owner.onLeaseReleased(url);
  };
}

export interface BlobPreviewLeaseController {
  /** Acquires a synchronous lease for `url` across async resolution until React commits. */
  hold(url: string): void;
  /** Releases any pending uncommitted lease (e.g., on reload or cancellation). */
  releasePending(): void;
}

/** Holds a cache lease for a remote preview `blob:` URL while this surface is active;
 *  calls `onRevoked` if a managed blob URL was revoked before or after render.
 *  Callers resolving previews asynchronously can call `hold(url)` synchronously upon
 *  settlement so the blob stays pinned until React commits the active lease. */
export function useBlobPreviewLease(url: string, onRevoked: () => void): BlobPreviewLeaseController {
  const surfaceActive = useSurfaceActive();
  const managedUrlRef = useRef('');
  const onRevokedRef = useRef(onRevoked);
  onRevokedRef.current = onRevoked;
  const mountedRef = useRef(true);
  const activeLeaseRef = useRef<{ url: string; release: () => void } | null>(null);
  const pendingLeaseRef = useRef<{ url: string; release: () => void } | null>(null);
  if (url && isManagedBlobUrl(url)) managedUrlRef.current = url;

  const releasePending = useCallback(() => {
    const pending = pendingLeaseRef.current;
    if (!pending) return;
    pendingLeaseRef.current = null;
    pending.release();
  }, []);

  const hold = useCallback((nextUrl: string) => {
    const previous = pendingLeaseRef.current;
    if (!mountedRef.current || !nextUrl || !nextUrl.startsWith('blob:')) {
      if (previous) {
        pendingLeaseRef.current = null;
        previous.release();
      }
      return;
    }
    if (isManagedBlobUrl(nextUrl)) managedUrlRef.current = nextUrl;
    if (previous?.url === nextUrl) return;
    let nextPending: { url: string; release: () => void } | null = null;
    if (activeLeaseRef.current?.url !== nextUrl) {
      const release = retainBlobPreviewUrl(nextUrl);
      if (release) nextPending = { url: nextUrl, release };
    }
    pendingLeaseRef.current = nextPending;
    if (previous) previous.release();
  }, []);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releasePending();
    };
  }, [releasePending]);

  useLayoutEffect(() => {
    if (!url || !url.startsWith('blob:')) {
      activeLeaseRef.current = null;
      return;
    }
    if (isManagedBlobUrl(url)) managedUrlRef.current = url;
    if (!surfaceActive) {
      activeLeaseRef.current = null;
      if (pendingLeaseRef.current?.url === url) releasePending();
      return;
    }
    const release = retainBlobPreviewUrl(url);
    if (release) {
      activeLeaseRef.current = { url, release };
      if (pendingLeaseRef.current?.url === url) releasePending();
      return () => {
        if (activeLeaseRef.current?.release === release) activeLeaseRef.current = null;
        release();
      };
    }
    activeLeaseRef.current = null;
    if (pendingLeaseRef.current?.url === url) releasePending();
    if (managedUrlRef.current === url) onRevokedRef.current();
  }, [url, surfaceActive, releasePending]);

  useLayoutEffect(() => {
    if (pendingLeaseRef.current?.url === url) releasePending();
  });

  return useMemo(() => ({ hold, releasePending }), [hold, releasePending]);
}

/** Largest file previewed whole in the browser; blob URLs hold it in memory. */
const REMOTE_PREVIEW_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Largest file one page `fetch`/XHR may read through the bridge. */
const PAGE_FETCH_MAX_BYTES = 16 * 1024 * 1024;
const BLOB_CACHE_LIMIT = 48;
const BLOB_CACHE_MAX_CHARS = 24 * 1024 * 1024;

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

let blobCacheSequence = 0;

function blobChars(bytes: number): number {
  return Math.ceil(Math.max(0, Number.isFinite(bytes) ? bytes : 0) / 2);
}

type BlobCacheEntry = {
  url: Promise<string>;
  resolvedUrl: string | null;
  chars: number;
};

/** Blob URL promises in use order; unpinned evicted, idle-reclaimed, or backgrounded URLs are revoked so a long session stays bounded. */
function createBlobUrlCache() {
  const name = `remote-preview-blobs-${++blobCacheSequence}`;
  const blobs = new Map<string, BlobCacheEntry>();
  const batchPinned = new Set<BlobCacheEntry>();
  let retainedChars = 0;
  let activeKey: string | null = null;
  let activePreviews = 0;
  let postSettlementTrimEpoch = 0;
  let postSettlementTrimPending = false;
  let needsPostSettlementTrim = false;
  let unregisterBudget: (() => void) | null = null;
  let unregisterReclaim: (() => void) | null = null;
  let listeningVisibility = false;
  let needsRefreshOnVisible = false;

  const isPinned = (entryKey: string, entry: BlobCacheEntry): boolean =>
    entryKey === activeKey || entry.resolvedUrl === null || (heldBlobUrls.get(entry.resolvedUrl) ?? 0) > 0;

  const isBudgetPinned = (entryKey: string, entry: BlobCacheEntry): boolean =>
    isPinned(entryKey, entry) || batchPinned.has(entry);

  const hasInflight = (): boolean => {
    for (const entry of blobs.values()) {
      if (entry.resolvedUrl === null) return true;
    }
    return false;
  };

  const hasPendingWork = (): boolean => activePreviews > 0 || hasInflight();

  const unregisterVisibility = (): void => {
    if (listeningVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      listeningVisibility = false;
    }
  };

  const unregisterCaches = (): void => {
    batchPinned.clear();
    postSettlementTrimEpoch += 1;
    postSettlementTrimPending = false;
    needsPostSettlementTrim = false;
    unregisterBudget?.();
    unregisterBudget = null;
    unregisterReclaim?.();
    unregisterReclaim = null;
    if (!needsRefreshOnVisible) unregisterVisibility();
  };

  const owner: BlobUrlOwner = {
    onLeaseReleased(url) {
      for (const entry of batchPinned) {
        if (entry.resolvedUrl === url) {
          batchPinned.delete(entry);
          break;
        }
      }
      if (blobs.size) enforceLimits(null);
    },
  };

  const revokeEntry = (entry: BlobCacheEntry): void => {
    if (entry.resolvedUrl) {
      const resolved = entry.resolvedUrl;
      if (liveBlobUrlOwners.get(resolved) === owner) liveBlobUrlOwners.delete(resolved);
      recordRevokedBlobUrl(resolved);
      URL.revokeObjectURL(resolved);
      return;
    }
    void entry.url.then(
      (value) => {
        if (liveBlobUrlOwners.get(value) === owner) liveBlobUrlOwners.delete(value);
        recordRevokedBlobUrl(value);
        URL.revokeObjectURL(value);
      },
      () => {}
    );
  };

  const evict = (key: string, entry: BlobCacheEntry): void => {
    blobs.delete(key);
    batchPinned.delete(entry);
    retainedChars -= entry.chars;
    revokeEntry(entry);
    if (!blobs.size) unregisterCaches();
  };

  const clearOnHidden = (): void => {
    if (!blobs.size) return;
    let hasInflight = false;
    let hasEvictable = false;
    for (const [entryKey, entry] of blobs) {
      if (isPinned(entryKey, entry)) {
        if (entry.resolvedUrl === null) hasInflight = true;
      } else {
        hasEvictable = true;
      }
    }
    if (hasInflight || (hasEvictable && mediaSessionListeners.size > 0)) {
      needsRefreshOnVisible = true;
    }
    for (const [entryKey, entry] of [...blobs]) {
      if (isPinned(entryKey, entry)) continue;
      evict(entryKey, entry);
    }
  };

  const reclaim = (): void => {
    if (!blobs.size) return;
    for (const [entryKey, entry] of [...blobs]) {
      if (isPinned(entryKey, entry)) continue;
      evict(entryKey, entry);
    }
  };

  const onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      clearOnHidden();
    } else if (needsRefreshOnVisible) {
      needsRefreshOnVisible = false;
      if (!blobs.size) unregisterVisibility();
      notifyMediaSessionChanged();
    }
  };

  const pinnedChars = (): number => {
    let total = 0;
    for (const [entryKey, entry] of blobs) {
      if (isBudgetPinned(entryKey, entry)) total += entry.chars;
    }
    return total;
  };

  const trim = (target: number): void => {
    for (const [entryKey, entry] of [...blobs]) {
      if (retainedChars <= target) break;
      if (isBudgetPinned(entryKey, entry)) continue;
      evict(entryKey, entry);
    }
  };

  const ensureRegistered = (): void => {
    if (!unregisterBudget) {
      unregisterBudget = registerBudgetedCache({
        name,
        chars: () => retainedChars,
        pinned: pinnedChars,
        trim,
      });
    }
    if (!unregisterReclaim) {
      unregisterReclaim = registerIdleReclaim(reclaim);
    }
    if (!listeningVisibility && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      listeningVisibility = true;
    }
  };

  const enforceLimits = (pinKey: string | null): void => {
    const previousActiveKey = activeKey;
    activeKey = pinKey;
    try {
      if (blobs.size > BLOB_CACHE_LIMIT || retainedChars > BLOB_CACHE_MAX_CHARS) {
        for (const [oldest, dropped] of [...blobs]) {
          if (blobs.size <= BLOB_CACHE_LIMIT && retainedChars <= BLOB_CACHE_MAX_CHARS) break;
          if (isBudgetPinned(oldest, dropped)) continue;
          evict(oldest, dropped);
        }
      }
      enforceRendererCacheBudget();
    } finally {
      activeKey = previousActiveKey;
    }
  };

  // Run one coalesced trim at the tail of the current microtask wave once all
  // in-flight reads have settled, so staggered concurrent batches (including
  // Promise.all) can synchronously acquire leases before unleased excess entries
  // are evicted.
  const schedulePostSettlementTrim = (): void => {
    needsPostSettlementTrim = true;
    if (hasPendingWork()) {
      postSettlementTrimEpoch += 1;
      postSettlementTrimPending = false;
      return;
    }
    const epoch = ++postSettlementTrimEpoch;
    postSettlementTrimPending = true;
    const step = (remaining: number): void => {
      if (epoch !== postSettlementTrimEpoch) return;
      if (hasPendingWork()) {
        postSettlementTrimPending = false;
        return;
      }
      if (remaining > 0) {
        queueMicrotask(() => step(remaining - 1));
        return;
      }
      batchPinned.clear();
      postSettlementTrimPending = false;
      needsPostSettlementTrim = false;
      if (blobs.size) enforceLimits(null);
    };
    queueMicrotask(() => step(4));
  };

  const beginPreview = (): (() => void) => {
    activePreviews += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      activePreviews = Math.max(0, activePreviews - 1);
      if (needsPostSettlementTrim && !hasPendingWork()) {
        schedulePostSettlementTrim();
      }
    };
  };

  const getOrCreate = (
    key: string,
    bytes: number,
    create: () => Promise<{ url: string; bytes: number }>
  ): Promise<string> => {
    let entry = blobs.get(key);
    if (entry) {
      blobs.delete(key);
      blobs.set(key, entry);
      if (entry.resolvedUrl !== null) {
        batchPinned.add(entry);
        schedulePostSettlementTrim();
      }
      return entry.url;
    }
    const deferInsertTrim = hasInflight() || activePreviews > 1 || needsPostSettlementTrim || postSettlementTrimPending;
    const initialChars = blobChars(bytes);
    const created = create();
    const nextEntry: BlobCacheEntry = {
      url: Promise.resolve(''),
      resolvedUrl: null,
      chars: initialChars,
    };
    const url = created.then((result) => {
      if (blobs.get(key) === nextEntry) {
        nextEntry.resolvedUrl = result.url;
        revokedBlobUrls.delete(result.url);
        liveBlobUrlOwners.set(result.url, owner);
        batchPinned.add(nextEntry);
        const actualChars = blobChars(Math.max(bytes, result.bytes));
        if (actualChars !== nextEntry.chars) {
          retainedChars += actualChars - nextEntry.chars;
          nextEntry.chars = actualChars;
        }
        schedulePostSettlementTrim();
      }
      return result.url;
    });
    nextEntry.url = url;
    entry = nextEntry;
    blobs.set(key, entry);
    retainedChars += initialChars;
    ensureRegistered();
    void url.catch(() => {
      if (blobs.get(key) !== entry) return;
      blobs.delete(key);
      retainedChars -= entry.chars;
      if (!blobs.size) unregisterCaches();
      else if (needsPostSettlementTrim && !hasPendingWork()) schedulePostSettlementTrim();
    });
    if (deferInsertTrim) {
      if (postSettlementTrimPending) {
        postSettlementTrimEpoch += 1;
        postSettlementTrimPending = false;
      }
      needsPostSettlementTrim = true;
    } else {
      enforceLimits(key);
    }
    return url;
  };

  return { getOrCreate, beginPreview };
}

/** The remote implementations of the preview calls on DesktopApi.
 *  `laneUrl` yields an encrypted-media-lane URL for a host asset id, or ''
 *  when the lane is unavailable. */
export function createRemotePreviewApi(
  call: Call,
  laneUrl?: (assetId: string, variant?: string) => string
): Pick<DesktopApi, 'previewProjectFile' | 'localPageSource' | 'captureFileSnapshot'> {
  const blobCache = createBlobUrlCache();
  return {
    captureFileSnapshot: (projectPath, relPath, accessToken) =>
      call('captureFileSnapshot', [projectPath, relPath, accessToken ?? null]),
    previewProjectFile: async (projectPath, relPath, accessToken) => {
      const finishPreview = blobCache.beginPreview();
      try {
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
        const url = await blobCache.getOrCreate(key, meta.size, () =>
          readRemoteFile(call, target, REMOTE_PREVIEW_MAX_FILE_BYTES).then(({ parts }) => {
            const totalBytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
            return {
              url: URL.createObjectURL(new Blob(parts as BlobPart[], { type: meta.mime })),
              bytes: totalBytes,
            };
          })
        );
        return { url, kind: meta.kind, mime: meta.mime, mtimeMs: meta.mtimeMs, size: meta.size };
      } finally {
        finishPreview();
      }
    },
    localPageSource: (projectPath, relPath, accessToken) =>
      buildPageSrcdoc(call, projectPath, relPath, accessToken ?? null),
  };
}
