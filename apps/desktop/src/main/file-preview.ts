import { randomUUID } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { filePreviewTypeForPath, type DesktopFilePreviewKind } from '../shared/file-preview';

export const FILE_PREVIEW_SCHEME = 'mixdog-media';
const MAX_REGISTERED_FILE_PREVIEWS = 256;

interface FilePreviewRecord {
  path: string;
  kind: DesktopFilePreviewKind;
  mime: string;
  cacheKey: string;
  /** When set, the file is served only while it still resolves inside this
   *  folder: a parent swapped for a link to elsewhere must not leak bytes. */
  root?: string;
  /** Set when `path` is a cache product (a converted document): converts the
   *  original again, so an evicted file is regenerated under the same token. */
  regenerate?: () => Promise<{ path: string; mtimeMs: number; size: number }>;
  /** The source revision (`mtimeMs:size`) the token was registered for: the core's cache is keyed by it, so only that
   *  revision is regenerated. A source saved since is another document, which the viewer reaches by its own new URL. */
  version: string;
  /** Counts the re-pointings. The converter's bytes are not guaranteed stable, so each is another representation: the served
   *  validator carries it and a reader of an earlier one is not continued with this one. */
  generation: number;
  /** The reconversion in flight, shared by every read that misses meanwhile. */
  regenerating?: Promise<void>;
}

const filePreviews = new Map<string, FilePreviewRecord>();
const filePreviewTokensByKey = new Map<string, string>();

export function registerFilePreview(
  path: string,
  cacheVersion: string | number = '',
  options: { root?: string; regenerate?: () => Promise<{ path: string; mtimeMs: number; size: number }> } = {}
): {
  url: string;
  kind: DesktopFilePreviewKind;
  mime: string;
} | null {
  if (!isAbsolute(path)) return null;
  const absolute = resolve(path);
  const type = filePreviewTypeForPath(absolute);
  if (!type) return null;
  if (options.root !== undefined && !isAbsolute(options.root)) return null;
  const root = options.root === undefined ? undefined : resolve(options.root);
  const comparable = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const comparablePath = comparable(absolute);
  const cacheKey = `${comparablePath}\0${String(cacheVersion)}\0${root ? comparable(root) : ''}`;
  const existingToken = filePreviewTokensByKey.get(cacheKey);
  const existing = existingToken ? filePreviews.get(existingToken) : null;
  if (existingToken && existing) {
    filePreviews.delete(existingToken);
    filePreviews.set(existingToken, existing);
    if (options.regenerate) existing.regenerate = options.regenerate;
    return {
      url: previewUrl(existingToken, absolute),
      kind: existing.kind,
      mime: existing.mime,
    };
  }
  if (existingToken) filePreviewTokensByKey.delete(cacheKey);
  const token = randomUUID();
  filePreviews.set(token, {
    path: absolute,
    cacheKey,
    version: String(cacheVersion),
    generation: 0,
    ...(root ? { root } : {}),
    ...(options.regenerate ? { regenerate: options.regenerate } : {}),
    ...type,
  });
  filePreviewTokensByKey.set(cacheKey, token);
  evictOldestPreviews();
  return { url: previewUrl(token, absolute), ...type };
}

function previewUrl(token: string, absolutePath: string): string {
  return `${FILE_PREVIEW_SCHEME}://preview/${token}/${encodeURIComponent(basename(absolutePath))}`;
}

function evictOldestPreviews(): void {
  while (filePreviews.size > MAX_REGISTERED_FILE_PREVIEWS) {
    const oldest = filePreviews.keys().next().value;
    if (!oldest) break;
    const dropped = filePreviews.get(oldest);
    filePreviews.delete(oldest);
    if (dropped && filePreviewTokensByKey.get(dropped.cacheKey) === oldest) {
      filePreviewTokensByKey.delete(dropped.cacheKey);
    }
  }
}

export function resolveFilePreview(token: string): FilePreviewRecord | null {
  const preview = filePreviews.get(token);
  if (!preview) return null;
  // Keep previews owned by live tabs ahead of abandoned URLs in the bounded map.
  filePreviews.delete(token);
  filePreviews.set(token, preview);
  return preview;
}

/** Makes sure a converted preview's file exists, re-pointing the token at a
 *  fresh conversion when the cache evicted it. One conversion at a time per
 *  preview; a failed one leaves the file missing, as without a source. */
export async function ensureFilePreviewFile(preview: FilePreviewRecord): Promise<void> {
  if (!preview.regenerate) return;
  if (!preview.regenerating) {
    const regenerate = preview.regenerate;
    preview.regenerating = (async () => {
      if (
        await access(preview.path).then(
          () => true,
          () => false
        )
      )
        return;
      const fresh = await regenerate();
      if (`${fresh.mtimeMs}:${fresh.size}` !== preview.version)
        throw new Error('The source changed since this preview.');
      preview.path = resolve(fresh.path);
      preview.generation += 1;
    })().finally(() => {
      preview.regenerating = undefined;
    });
  }
  await preview.regenerating.catch(() => undefined);
}

/** Whether a preview may be served now: a rooted preview must still resolve
 *  (symlinks and junctions included) inside its root. Fails closed. */
export async function filePreviewServable(preview: Pick<FilePreviewRecord, 'path' | 'root'>): Promise<boolean> {
  if (!preview.root) return true;
  try {
    const [root, file] = await Promise.all([realpath(preview.root), realpath(preview.path)]);
    const rel = relative(root, file);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  } catch {
    return false;
  }
}
