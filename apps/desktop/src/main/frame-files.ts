/**
 * Frames written beside the run instead of into the conversation, shared by the
 * Computer Use and Browser Use hosts. The host chooses the path — a caller
 * never names a file, so this can never become an arbitrary write — and old
 * frames are pruned so a long session cannot fill the disk. A failed write
 * returns nothing and the caller keeps the inline frame, because losing the
 * pixels silently would be worse than spending the tokens.
 */
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mixdogDataDirectory } from './computer/shared/common';

/** Newest frames kept on disk per surface. */
const FRAME_MAX_FILES = 40;
const FRAME_MAX_BYTES = 100 * 1024 * 1024;
const FRAME_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

interface PersistedFrame {
  path: string;
  bytes: number;
}

interface FrameEntry {
  path: string;
  modifiedAt: number;
  bytes: number;
  /** Write order within this process: frames written in one millisecond. */
  seq?: number;
}

let frameSequence = 0;

// The frames on disk per directory, scanned once and kept current by this
// process's own writes and prunes, so a write never re-lists the directory.
const frameLists = new Map<string, Promise<FrameEntry[]>>();

function scanFrames(directory: string): Promise<FrameEntry[]> {
  let scanned = frameLists.get(directory);
  if (!scanned) {
    scanned = readdir(directory).then((names) =>
      Promise.all(
        names
          .filter((name) => /\.(?:jpg|png|pdf)$/i.test(name))
          .map(async (name): Promise<FrameEntry> => {
            const path = join(directory, name);
            try {
              const info = await stat(path);
              return { path, modifiedAt: info.mtimeMs, bytes: info.size };
            } catch {
              /* removed between listing and stat */
              return { path, modifiedAt: 0, bytes: 0 };
            }
          })
      )
    );
    frameLists.set(directory, scanned);
    scanned.catch(() => frameLists.delete(directory));
  }
  return scanned;
}

async function pruneFrames(files: FrameEntry[], protectedPath: string): Promise<void> {
  files.sort(
    (left, right) =>
      Number(right.path === protectedPath) - Number(left.path === protectedPath) ||
      right.modifiedAt - left.modifiedAt ||
      (right.seq ?? 0) - (left.seq ?? 0)
  );
  let retainedBytes = 0;
  const removed: FrameEntry[] = [];
  const kept: FrameEntry[] = [];
  for (const [index, entry] of files.entries()) {
    if (index < FRAME_MAX_FILES && retainedBytes + entry.bytes <= FRAME_MAX_TOTAL_BYTES) {
      retainedBytes += entry.bytes;
      kept.push(entry);
    } else {
      removed.push(entry);
    }
  }
  files.splice(0, files.length, ...kept);
  await Promise.all(removed.map((entry) => removeFrame(entry.path)));
}

let removeFrame = (path: string): Promise<void> => unlink(path).catch(() => undefined);

/** Test seam: replaces the unlink so a test can delay an eviction. */
export function setFrameRemoverForTest(remover?: (path: string) => Promise<void>): void {
  removeFrame = remover ?? ((path) => unlink(path).catch(() => undefined));
}

// A write and its prune run as one step per directory, so an eviction's unlink
// can never land after a later write of the same name.
const directoryQueues = new Map<string, Promise<unknown>>();

function serializeByDirectory<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const run = (directoryQueues.get(directory) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => undefined);
  directoryQueues.set(directory, tail);
  void tail.then(() => {
    if (directoryQueues.get(directory) === tail) directoryQueues.delete(directory);
  });
  return run;
}

function decodedBase64Bytes(data: string): number {
  let padding = 0;
  if (data.endsWith('==')) padding = 2;
  else if (data.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function frameImageFitsFileBudget(data: string): boolean {
  const bytes = decodedBase64Bytes(data);
  return bytes > 0 && bytes <= FRAME_MAX_BYTES;
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
  const session =
    String(sessionId || 'session')
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 60) || 'session';
  const stamp = String(frameId || Date.now().toString(36))
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 40);
  return `${session}-${stamp}.${extension}`;
}

async function writeFrameFile(directory: string, name: string, bytes: Buffer): Promise<PersistedFrame> {
  const path = join(directory, name);
  const files = await scanFrames(directory);
  await writeFile(path, bytes);
  const existing = files.find((entry) => entry.path === path);
  if (existing) {
    existing.modifiedAt = Date.now();
    existing.bytes = bytes.length;
    existing.seq = ++frameSequence;
  } else {
    files.push({ path, modifiedAt: Date.now(), bytes: bytes.length, seq: ++frameSequence });
  }
  await pruneFrames(files, path);
  return { path, bytes: bytes.length };
}

async function persistBoundedFrame(
  directory: string,
  sessionId: string,
  frameId: string,
  image: { mimeType: string; data: string }
): Promise<PersistedFrame | undefined> {
  const bytes = decodeFrameImage(image.data);
  if (!bytes) return undefined;
  const name = frameFileName(sessionId, frameId, frameFileExtension(image.mimeType));
  return serializeByDirectory(directory, () => writeFrameFile(directory, name, bytes));
}

async function ensureFrameDirectory(scope: 'computer' | 'browser'): Promise<string> {
  const directory = join(mixdogDataDirectory(), `${scope}-frames`);
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function persistFrameImage(
  scope: 'computer' | 'browser',
  sessionId: string,
  frameId: string,
  image: { mimeType: string; data: string }
): Promise<PersistedFrame | undefined> {
  try {
    return await persistBoundedFrame(await ensureFrameDirectory(scope), sessionId, frameId, image);
  } catch {
    return undefined;
  }
}
