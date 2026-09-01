import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';

import { localFileMimeTypeForPath } from '../shared/local-files';

/** Shape-validated absolute path for trusted local-file operations. */
export function absoluteLocalPath(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('path must be a string.');
  const text = value.trim();
  if (!text || text.length > 16_384 || text.includes('\0')) {
    throw new TypeError('path is invalid.');
  }
  if (!isAbsolute(text)) throw new TypeError('path must be absolute.');
  return resolve(text);
}

/** Attachment/drag lane cap shared by every host that reads a local file. */
export const MAX_LOCAL_FILE_BYTES = 20 * 1024 * 1024;

/** One absolute path described for the file-tab / attachment lanes. */
export async function statLocalEntryAbs(path: string): Promise<{
  absolutePath: string;
  name: string;
  dir: boolean;
  size: number;
}> {
  const absolutePath = absoluteLocalPath(path);
  const info = await stat(absolutePath);
  return {
    absolutePath,
    name: basename(absolutePath) || absolutePath,
    dir: info.isDirectory(),
    size: Number(info.size) || 0,
  };
}

/** Read one local file as base64 for an attachment, with a bounded payload. */
export async function readLocalFileAbs(path: string): Promise<{
  name: string;
  size: number;
  mimeType: string;
  data: string;
}> {
  const file = absoluteLocalPath(path);
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Only files can be attached.');
  if (info.size > MAX_LOCAL_FILE_BYTES) {
    throw new Error(`${basename(file)}: files must be 20 MB or smaller.`);
  }
  const data = await readFile(file);
  return {
    name: basename(file),
    size: info.size,
    mimeType: localFileMimeTypeForPath(file),
    data: data.toString('base64'),
  };
}
