/**
 * Frames written beside the run instead of into the conversation, shared by the
 * Computer Use and Browser Use hosts. The host chooses the path — a caller
 * never names a file, so this can never become an arbitrary write — and old
 * frames are pruned so a long session cannot fill the disk. A failed write
 * returns nothing and the caller keeps the inline frame, because losing the
 * pixels silently would be worse than spending the tokens.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mixdogDataDirectory } from './computer/shared/common';

/** Newest frames kept on disk per surface. */
const FRAME_MAX_FILES = 40;
const FRAME_MAX_BYTES = 100 * 1024 * 1024;
const FRAME_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

export interface PersistedFrame {
  path: string;
  bytes: number;
}

function pruneFrames(directory: string, protectedPath?: string): void {
  const files = readdirSync(directory)
    .filter((name) => /\.(?:jpg|png|pdf)$/i.test(name))
    .map((name) => {
      const path = join(directory, name);
      let modifiedAt = 0;
      let bytes = 0;
      try {
        const info = statSync(path);
        modifiedAt = info.mtimeMs;
        bytes = info.size;
      } catch { /* removed between listing and stat */ }
      return { path, modifiedAt, bytes };
    })
    .sort((left, right) => (
      Number(right.path === protectedPath) - Number(left.path === protectedPath)
      || right.modifiedAt - left.modifiedAt
    ));
  let retainedBytes = 0;
  files.forEach((entry, index) => {
    const keep = index < FRAME_MAX_FILES
      && retainedBytes + entry.bytes <= FRAME_MAX_TOTAL_BYTES;
    if (keep) {
      retainedBytes += entry.bytes;
      return;
    }
    try { unlinkSync(entry.path); } catch { /* another run already removed it */ }
  });
}

function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

export function frameImageFitsFileBudget(data: string): boolean {
  return decodedBase64Bytes(data) > 0 && decodedBase64Bytes(data) <= FRAME_MAX_BYTES;
}

function decodeFrameImage(data: string): Buffer | undefined {
  if (!frameImageFitsFileBudget(data)) return undefined;
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > FRAME_MAX_BYTES) return undefined;
  return bytes;
}

function frameFileExtension(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'image/png') return 'png';
  return 'jpg';
}

function frameFileName(sessionId: string, frameId: string, extension: string): string {
  const session = String(sessionId || 'session').replace(/[^\w.-]+/g, '_').slice(0, 60)
    || 'session';
  const stamp = String(frameId || Date.now().toString(36))
    .replace(/[^\w.-]+/g, '_').slice(0, 40);
  return `${session}-${stamp}.${extension}`;
}

function writeFrameFile(
  directory: string,
  name: string,
  bytes: Buffer,
): PersistedFrame {
  const path = join(directory, name);
  writeFileSync(path, bytes);
  pruneFrames(directory, path);
  return { path, bytes: bytes.length };
}

function persistBoundedFrame(
  directory: string,
  sessionId: string,
  frameId: string,
  image: { mimeType: string; data: string },
): PersistedFrame | undefined {
  const bytes = decodeFrameImage(image.data);
  if (!bytes) return undefined;
  return writeFrameFile(
    directory,
    frameFileName(sessionId, frameId, frameFileExtension(image.mimeType)),
    bytes,
  );
}

function ensureFrameDirectory(scope: 'computer' | 'browser'): string {
  const directory = join(mixdogDataDirectory(), `${scope}-frames`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function persistFrame(
  scope: 'computer' | 'browser',
  sessionId: string,
  frameId: string,
  image: { mimeType: string; data: string },
): PersistedFrame | undefined {
  try {
    return persistBoundedFrame(ensureFrameDirectory(scope), sessionId, frameId, image);
  } catch {
    return undefined;
  }
}

export function persistFrameImage(
  scope: 'computer' | 'browser',
  sessionId: string,
  frameId: string,
  image: { mimeType: string; data: string },
): PersistedFrame | undefined {
  return persistFrame(scope, sessionId, frameId, image);
}
