/**
 * Picture of a local HTML or image file for transcript cards whose live
 * source is gone (a closed visualize tab, a card after a restart). The file is
 * rendered off screen in a throw-away, sandboxed window and returned as a
 * small data URL. One capture runs at a time; a result is reused until the
 * file changes (path + mtime + size).
 */
import { realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectEntryPathIn } from './project-files';

export const SNAPSHOT_TIMEOUT_MS = 4_000;
/** Time for scripts, fonts and images to settle after the load event. */
export const SNAPSHOT_SETTLE_MS = 300;
export const SNAPSHOT_MAX_WIDTH = 640;
/** Largest file rendered; a bigger one keeps its placeholder. */
export const SNAPSHOT_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Largest result returned; a PNG over this is re-encoded as JPEG. */
export const SNAPSHOT_MAX_RESULT_BYTES = 400 * 1024;
const CACHE_LIMIT = 48;
const QUEUE_LIMIT = 16;

const HTML = new Set(['.html', '.htm']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);

/** What a file can be pictured as, by extension; null for anything else. */
export function snapshotKind(path: string): 'html' | 'image' | null {
  const extension = extname(path).toLowerCase();
  if (HTML.has(extension)) return 'html';
  return IMAGE.has(extension) ? 'image' : null;
}

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Whether the capture window may make a request: inline `data:` / `blob:` /
 *  `about:` content, and `file:` resources inside `root` (symlinks resolved).
 *  Everything else, network included, is refused. With `onlyFile` (a file
 *  granted on its own) the one `file:` resource allowed is that file. */
export function snapshotRequestAllowed(root: string, url: string, onlyFile?: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (/^(?:data|blob|about):$/.test(target.protocol)) return true;
  if (target.protocol !== 'file:') return false;
  let path: string;
  try {
    path = canonical(fileURLToPath(target));
  } catch {
    return false;
  }
  if (onlyFile !== undefined) return path === canonical(onlyFile);
  const rel = relative(canonical(root), path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel));
}

export interface FileSnapshot {
  /** `data:image/png` (or jpeg) of the rendered file, at most 640 px wide. */
  dataUrl: string;
  mtimeMs: number;
  size: number;
}

export interface SnapshotRenderInput {
  fileUrl: string;
  root: string;
  /** A file granted on its own: only this file may load, not its siblings. */
  onlyFile?: string;
  signal: AbortSignal;
}

export interface FileSnapshotDeps {
  /** The project's confinement check: the absolute path, or a thrown refusal. */
  confine(root: string, rel: string): string;
  render(input: SnapshotRenderInput): Promise<string>;
  timeoutMs?: number;
}

export function createFileSnapshotService({ confine, render, timeoutMs = SNAPSHOT_TIMEOUT_MS }: FileSnapshotDeps) {
  const cache = new Map<string, FileSnapshot>();
  const inflight = new Map<string, Promise<FileSnapshot>>();
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;

  const run = async (
    root: string,
    absolute: string,
    key: string,
    info: { mtimeMs: number; size: number },
    grant: boolean
  ) => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('The snapshot took too long to render.'));
      }, timeoutMs);
    });
    try {
      const rendering = render({
        fileUrl: pathToFileURL(absolute).href,
        root,
        ...(grant ? { onlyFile: absolute } : {}),
        signal: controller.signal,
      });
      rendering.catch(() => undefined);
      const dataUrl = await Promise.race([rendering, deadline]);
      const snapshot = { dataUrl, mtimeMs: info.mtimeMs, size: info.size };
      cache.delete(key);
      cache.set(key, snapshot);
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
      return snapshot;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    /** `grant`: the file was granted on its own, so `root` is only its parent
     *  folder and the capture may load nothing but the file itself. */
    async capture(root: string, rel: string, grant = false): Promise<FileSnapshot> {
      const absolute = confine(root, rel);
      if (!snapshotKind(absolute)) throw new Error('This file type has no snapshot.');
      const info = await stat(absolute);
      if (!info.isFile()) throw new Error('The snapshot target is not a file.');
      if (info.size > SNAPSHOT_MAX_FILE_BYTES) throw new Error('This file is too large for a snapshot.');
      const key = `${grant ? 'grant' : 'project'}\0${absolute}\0${info.mtimeMs}:${info.size}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const pending = inflight.get(key);
      if (pending) return pending;
      if (queued >= QUEUE_LIMIT) throw new Error('Too many snapshots are waiting.');
      queued += 1;
      const job = tail.then(() => run(root, absolute, key, info, grant));
      tail = job.catch(() => undefined);
      const tracked = job.finally(() => {
        queued -= 1;
        inflight.delete(key);
      });
      inflight.set(key, tracked);
      return tracked;
    },
  };
}

/** The app's one service: desktop windows and paired phones share its queue. */
export const fileSnapshots = createFileSnapshotService({ confine: projectEntryPathIn, render: renderFileSnapshot });

/** The production renderer: a hidden, off-screen, sandboxed window with its
 *  own in-memory session. No preload, no dialogs, no new windows or
 *  navigation; only `file:` resources of the project load. */
export async function renderFileSnapshot({ fileUrl, root, onlyFile, signal }: SnapshotRenderInput): Promise<string> {
  signal.throwIfAborted();
  const { BrowserWindow } = await import('electron');
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      // No `persist:` prefix: an in-memory session shared with nothing.
      partition: `file-snapshot-${randomUUID()}`,
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      disableDialogs: true,
      backgroundThrottling: false,
    },
  });
  const contents = window.webContents;
  const aborted = new Promise<never>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new Error('The snapshot was cancelled.')), { once: true })
  );
  try {
    contents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) =>
      callback({ cancel: !snapshotRequestAllowed(root, details.url, onlyFile) })
    );
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    const render = async (): Promise<string> => {
      await window.loadURL(fileUrl);
      await new Promise((resolveSettle) => setTimeout(resolveSettle, SNAPSHOT_SETTLE_MS));
      let image = await contents.capturePage();
      const { width } = image.getSize();
      if (width > SNAPSHOT_MAX_WIDTH) image = image.resize({ width: SNAPSHOT_MAX_WIDTH, quality: 'best' });
      if (image.isEmpty()) throw new Error('The page rendered nothing.');
      const png = image.toPNG();
      return png.length <= SNAPSHOT_MAX_RESULT_BYTES
        ? `data:image/png;base64,${png.toString('base64')}`
        : `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}`;
    };
    const rendering = render();
    rendering.catch(() => undefined);
    return await Promise.race([rendering, aborted]);
  } finally {
    window.destroy();
  }
}
