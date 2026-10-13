// Durable thumbnails for transcript cards whose source can disappear (a closed
// visualize tab, a deleted or moved image, a browser page after a restart).
// While the source shows a picture it is saved, downscaled, in the shared
// IndexedDB preview store; once the source is gone the card shows that copy.
import { useEffect, useState } from 'react';

import type { DesktopApi } from '../shared/contract';
import { verifyLocalLink } from './local-link-resolver';
import {
  type ImagePreviewStore,
  makeImageThumbnail,
  onSessionPreviewsDeleted,
  PREVIEW_MAX_BYTES,
  persistentImagePreviews,
  previewKey,
} from './image-preview-store';

// Which key + picture were already saved this run (marker -> session). The
// picture is a short hash, never the (possibly huge) URL, and the set is capped.
const SAVED_LIMIT = 512;
const saved = new Map<string, string>();

function pictureHash(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) hash = Math.imul(hash ^ url.charCodeAt(i), 0x01000193);
  return `${url.length}:${(hash >>> 0).toString(36)}`;
}

onSessionPreviewsDeleted((session) => {
  for (const [marker, owner] of saved) if (owner === session) saved.delete(marker);
});

/** Saves `url` under `key`. A small data URL is stored as is, anything else is
 *  downscaled first. Best effort, and once per key + picture. */
export async function rememberThumbnail(
  key: string,
  session: string,
  url: string,
  options: { store?: ImagePreviewStore; make?: (url: string) => Promise<string> } = {}
): Promise<void> {
  const store = options.store ?? persistentImagePreviews;
  const marker = `${key}\0${pictureHash(url)}`;
  if (!url || saved.has(marker) || store.peek(key) === url) return;
  saved.set(marker, session);
  while (saved.size > SAVED_LIMIT) saved.delete(saved.keys().next().value as string);
  try {
    const small = url.startsWith('data:image/') && url.length * 0.75 <= PREVIEW_MAX_BYTES * 2;
    await store.put(key, session, small ? url : await (options.make ?? makeImageThumbnail)(url));
  } catch {
    saved.delete(marker);
  }
}

/** `live` while the source has a picture (saving it); else the saved copy
 *  (instantly when this window already has it, otherwise once loaded). */
export function usePersistedThumbnail(session: string, line: string, live: string | undefined): string | undefined {
  const key = line ? previewKey(session, line) : '';
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    if (live) {
      void rememberThumbnail(key, session, live);
      return;
    }
    let active = true;
    void persistentImagePreviews
      .get(key)
      .then((url) => {
        if (active && url) setLoaded({ key, url });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [key, session, live]);
  if (live) return live;
  if (!key) return undefined;
  return persistentImagePreviews.peek(key) ?? (loaded?.key === key ? loaded.url : undefined);
}

/** Test seam: forget what was saved this run. */
export function resetSavedThumbnails(): void {
  saved.clear();
  snapshotRuns.clear();
  failedSnapshots.clear();
}

/** HTML and image files, the kinds the host can picture. */
export const SNAPSHOT_FILE = /\.(?:html?|png|jpe?g|gif|webp|svg|bmp|avif)$/i;

type SnapshotApi = Pick<DesktopApi, 'statProjectFile' | 'captureFileSnapshot'>;
const snapshotRuns = new Map<string, Promise<string | undefined>>();
const failedSnapshots = new Set<string>();

/** A picture of a local file, for a card whose live source has none: the saved
 *  one when the file is unchanged (key = path + mtime + size), else one the
 *  host renders now (saved for next time). Once per file version; undefined
 *  when the host cannot or the capture failed. */
export function fileSnapshot(
  session: string,
  target: { project: string; path: string; accessToken?: string },
  api: SnapshotApi | undefined = typeof window === 'undefined' ? undefined : window.mixdogDesktop,
  store: ImagePreviewStore = persistentImagePreviews
): Promise<string | undefined> {
  const { statProjectFile, captureFileSnapshot } = api ?? {};
  if (!statProjectFile || !captureFileSnapshot || !SNAPSHOT_FILE.test(target.path)) return Promise.resolve(undefined);
  return statProjectFile(target.project, target.path, target.accessToken).then(
    async (info) => {
      const key = previewKey(session, `snapshot|${target.project}|${target.path}|${info.mtimeMs}:${info.size}`);
      const stored = await store.get(key).catch(() => undefined);
      if (stored) return stored;
      if (failedSnapshots.has(key)) return undefined;
      let run = snapshotRuns.get(key);
      if (!run) {
        run = captureFileSnapshot(target.project, target.path, target.accessToken)
          .then(async ({ dataUrl }) => {
            await store.put(key, session, dataUrl).catch(() => undefined);
            return dataUrl;
          })
          .catch(() => {
            failedSnapshots.add(key);
            return undefined;
          })
          .finally(() => snapshotRuns.delete(key));
        snapshotRuns.set(key, run);
      }
      return run;
    },
    () => undefined
  );
}

/** `fileSnapshot` of a card's first file target while `enabled` (no live or
 *  saved picture yet). Undefined while pending or when none could be made. */
export function useFileSnapshot(session: string, project: string, path: string, enabled: boolean): string | undefined {
  const [result, setResult] = useState<{ id: string; url: string } | null>(null);
  const id = `${session}\0${project}\0${path}`;
  useEffect(() => {
    if (!enabled || !path || !SNAPSHOT_FILE.test(path)) return;
    let active = true;
    verifyLocalLink(project, path, session || undefined)
      .then((target) => (target.directory ? undefined : fileSnapshot(session, target)))
      .then((url) => {
        if (active && url) setResult({ id, url });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [enabled, id, project, path, session]);
  return enabled && result?.id === id ? result.url : undefined;
}
