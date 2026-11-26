import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomicAsync } from '../../../../../src/runtime/shared/atomic-file.mjs';
import { FILE_PREVIEW_SCHEME } from '../file-preview';
import { safeStorageDecrypt, safeStorageEncrypt } from './browser-session-store';
import type { BrowserPageThumbnailStorage } from './page-identity';

export const PAGE_THUMB_HOST = 'page-thumb';
export const PAGE_THUMB_PREFIX = `${FILE_PREVIEW_SCHEME}://${PAGE_THUMB_HOST}/`;

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

const EXT_BY_SUBTYPE: Record<string, string> = {
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
};

const SAFE_FILE_NAME = /^[0-9a-f]{32}\.(?:jpg|png|webp|gif)$/;
const DATA_IMAGE_PATTERN = /^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i;

export interface DiskPageThumbnailOptions {
  encrypt?(text: string): Promise<Buffer | null>;
  decrypt?(data: Buffer): Promise<string | null>;
  onWriteFailed?(key: string, thumbnailUrl: string): void;
}

interface RegisteredDirectoryEntry {
  accessToken: Buffer;
  decrypt: (data: Buffer) => Promise<string | null>;
  waitFor: (fileName: string) => Promise<void>;
}

const registeredDirectories = new Map<string, Set<RegisteredDirectoryEntry>>();

const diskFileName = (fileName: string): string => `${fileName}.bin`;

function tokenMatches(expected: Buffer, provided: string): boolean {
  const actual = Buffer.from(provided, 'utf8');
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

function fileNameFromThumbUrl(url: string): string | null {
  if (!url.startsWith(PAGE_THUMB_PREFIX)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${FILE_PREVIEW_SCHEME}:` || parsed.hostname !== PAGE_THUMB_HOST) return null;
    const name = parsed.pathname.replace(/^\/+/, '');
    return SAFE_FILE_NAME.test(name) ? name : null;
  } catch {
    return null;
  }
}

function versionFromThumbUrl(url: string): string | null {
  try {
    const v = new URL(url).searchParams.get('v');
    return v && /^[0-9a-f]{1,32}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

function mimeForFileName(fileName: string): string | null {
  if (!SAFE_FILE_NAME.test(fileName)) return null;
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

/** Resolves a `mixdog-media://page-thumb/<file>` request to its encrypted file on disk. */
export function resolveBrowserPageThumbnail(fileName: string): { path: string; mime: string } | null {
  const mime = mimeForFileName(fileName);
  if (!mime) return null;
  const storedName = diskFileName(fileName);
  for (const dir of registeredDirectories.keys()) {
    const full = join(dir, storedName);
    if (existsSync(full)) return { path: full, mime };
  }
  return null;
}

/** Reads and decrypts a `mixdog-media://page-thumb/<file>` thumbnail from disk,
 *  requiring the active runtime capability token issued for that thumbnail storage. */
export async function readBrowserPageThumbnail(
  fileName: string,
  token: string
): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!token) return null;
  const mime = mimeForFileName(fileName);
  if (!mime) return null;
  const storedName = diskFileName(fileName);
  for (const [dir, entries] of [...registeredDirectories.entries()]) {
    const matching = [...entries].filter((entry) => tokenMatches(entry.accessToken, token));
    if (!matching.length) continue;
    for (const entry of matching) await entry.waitFor(fileName);
    let sealed: Buffer;
    try {
      sealed = await readFile(join(dir, storedName));
    } catch {
      continue;
    }
    for (const entry of matching) {
      const decoded = await entry.decrypt(sealed).catch(() => null);
      if (!decoded) continue;
      const bytes = Buffer.from(decoded, 'base64');
      if (bytes.length) return { bytes, mime };
    }
  }
  return null;
}

/** Stores browser page thumbnails encrypted with safeStorage on disk and returns compact
 *  `mixdog-media://page-thumb/...` URLs instead of keeping base64 payloads in memory. */
export function createDiskPageThumbnailStorage(
  directory: string,
  options: DiskPageThumbnailOptions = {}
): BrowserPageThumbnailStorage & {
  directory: string;
  settled(): Promise<void>;
  dispose(): void;
} {
  const encrypt = options.encrypt ?? safeStorageEncrypt;
  const decrypt = options.decrypt ?? safeStorageDecrypt;
  const accessToken = randomBytes(16).toString('hex');
  const accessTokenBuf = Buffer.from(accessToken, 'utf8');
  let dirReady: Promise<void> | null = null;
  let disposed = false;
  const lastRevByFile = new Map<string, string>();
  const fileSeq = new Map<string, number>();
  const chains = new Map<string, Promise<void>>();

  const formatThumbUrl = (fileName: string, rev: string | null): string =>
    rev
      ? `${PAGE_THUMB_PREFIX}${fileName}?v=${rev}&t=${accessToken}`
      : `${PAGE_THUMB_PREFIX}${fileName}?t=${accessToken}`;

  const ensureDir = (): Promise<void> => {
    dirReady ??= mkdir(directory, { recursive: true }).then(
      () => undefined,
      (error) => {
        dirReady = null;
        throw error;
      }
    );
    return dirReady;
  };

  const enqueue = (fileName: string, work: () => Promise<void>): Promise<void> => {
    const previous = chains.get(fileName) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    chains.set(fileName, tail);
    void tail.finally(() => {
      if (chains.get(fileName) === tail) {
        chains.delete(fileName);
        fileSeq.delete(fileName);
      }
    });
    return next;
  };

  const entry: RegisteredDirectoryEntry = {
    accessToken: accessTokenBuf,
    decrypt,
    waitFor: (fileName) => chains.get(fileName) ?? Promise.resolve(),
  };
  let dirEntries = registeredDirectories.get(directory);
  if (!dirEntries) {
    dirEntries = new Set();
    registeredDirectories.set(directory, dirEntries);
  }
  dirEntries.add(entry);

  return {
    directory,
    put(key: string, dataUrl: string): string | null {
      if (disposed) return null;
      const existingName = fileNameFromThumbUrl(dataUrl);
      if (existingName) {
        if (!lastRevByFile.has(existingName) && !existsSync(join(directory, diskFileName(existingName)))) return null;
        return formatThumbUrl(existingName, versionFromThumbUrl(dataUrl));
      }
      const match = DATA_IMAGE_PATTERN.exec(dataUrl);
      if (!match) return null;
      const ext = EXT_BY_SUBTYPE[match[1].toLowerCase()];
      if (!ext) return null;
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length) return null;
      const keyHash = createHash('sha256').update(key).digest('hex').slice(0, 32);
      const revHash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
      const fileName = `${keyHash}.${ext}`;
      const fullPath = join(directory, diskFileName(fileName));
      const url = formatThumbUrl(fileName, revHash);
      if (lastRevByFile.get(fileName) === revHash && (chains.has(fileName) || existsSync(fullPath))) {
        return url;
      }
      const seq = (fileSeq.get(fileName) ?? 0) + 1;
      fileSeq.set(fileName, seq);
      lastRevByFile.set(fileName, revHash);
      const payload = bytes.toString('base64');
      const rollback = () => {
        if (lastRevByFile.get(fileName) === revHash) lastRevByFile.delete(fileName);
        options.onWriteFailed?.(key, url);
      };
      void enqueue(fileName, async () => {
        if (fileSeq.get(fileName) !== seq) return;
        if (disposed) {
          rollback();
          return;
        }
        let sealed: Buffer | null = null;
        try {
          sealed = await encrypt(payload);
        } catch {
          sealed = null;
        }
        if (fileSeq.get(fileName) !== seq) return;
        if (disposed || !sealed || sealed.length === 0) {
          rollback();
          return;
        }
        try {
          await ensureDir();
          if (fileSeq.get(fileName) !== seq) return;
          if (disposed) {
            rollback();
            return;
          }
          await writeFileAtomicAsync(fullPath, sealed, { secret: true });
        } catch {
          rollback();
        }
      });
      return url;
    },
    accept(thumbnailUrl: string): boolean {
      const name = fileNameFromThumbUrl(thumbnailUrl);
      return name !== null && (lastRevByFile.has(name) || existsSync(join(directory, diskFileName(name))));
    },
    remove(thumbnailUrl: string): void {
      const name = fileNameFromThumbUrl(thumbnailUrl);
      if (!name) return;
      const seq = (fileSeq.get(name) ?? 0) + 1;
      fileSeq.set(name, seq);
      lastRevByFile.delete(name);
      void enqueue(name, async () => {
        if (fileSeq.get(name) !== seq) return;
        await rm(join(directory, diskFileName(name)), { force: true }).catch(() => undefined);
      });
    },
    async settled(): Promise<void> {
      while (chains.size > 0) {
        await Promise.all([...chains.values()]);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const current = registeredDirectories.get(directory);
      if (current) {
        current.delete(entry);
        if (current.size === 0) registeredDirectories.delete(directory);
      }
    },
  };
}
