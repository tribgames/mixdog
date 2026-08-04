import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';

import {
  filePreviewTypeForPath,
  type DesktopFilePreviewKind,
} from '../shared/file-preview';

export const FILE_PREVIEW_SCHEME = 'mixdog-media';
const MAX_REGISTERED_FILE_PREVIEWS = 256;

interface FilePreviewRecord {
  path: string;
  kind: DesktopFilePreviewKind;
  mime: string;
  cacheKey: string;
}

const filePreviews = new Map<string, FilePreviewRecord>();
const filePreviewTokensByKey = new Map<string, string>();

export function registerFilePreview(path: string, cacheVersion: string | number = ''): {
  url: string;
  kind: DesktopFilePreviewKind;
  mime: string;
} | null {
  if (!isAbsolute(path)) return null;
  const absolute = resolve(path);
  const type = filePreviewTypeForPath(absolute);
  if (!type) return null;
  const comparablePath = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const cacheKey = `${comparablePath}\0${String(cacheVersion)}`;
  const existingToken = filePreviewTokensByKey.get(cacheKey);
  const existing = existingToken ? filePreviews.get(existingToken) : null;
  if (existingToken && existing) {
    filePreviews.delete(existingToken);
    filePreviews.set(existingToken, existing);
    return {
      url: `${FILE_PREVIEW_SCHEME}://preview/${existingToken}/${encodeURIComponent(basename(absolute))}`,
      kind: existing.kind,
      mime: existing.mime,
    };
  }
  if (existingToken) filePreviewTokensByKey.delete(cacheKey);
  const token = randomUUID();
  filePreviews.set(token, { path: absolute, cacheKey, ...type });
  filePreviewTokensByKey.set(cacheKey, token);
  while (filePreviews.size > MAX_REGISTERED_FILE_PREVIEWS) {
    const oldest = filePreviews.keys().next().value;
    if (!oldest) break;
    const dropped = filePreviews.get(oldest);
    filePreviews.delete(oldest);
    if (dropped && filePreviewTokensByKey.get(dropped.cacheKey) === oldest) {
      filePreviewTokensByKey.delete(dropped.cacheKey);
    }
  }
  return {
    url: `${FILE_PREVIEW_SCHEME}://preview/${token}/${encodeURIComponent(basename(absolute))}`,
    ...type,
  };
}

export function resolveFilePreview(token: string): FilePreviewRecord | null {
  const preview = filePreviews.get(token);
  if (!preview) return null;
  // Keep previews owned by live tabs ahead of abandoned URLs in the bounded map.
  filePreviews.delete(token);
  filePreviews.set(token, preview);
  return preview;
}
