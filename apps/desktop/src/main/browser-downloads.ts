/**
 * What the session downloaded, and how a file reaches the caller. A download is
 * named and measured here; it only rides back inside the reply when it is small
 * enough, and otherwise the report says where the file is instead of pretending
 * it could be attached.
 */
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { redactBrowserText, redactBrowserUrl } from './browser-host-policy';

export interface TrackedBrowserDownload {
  id: string;
  file: string;
  path: string;
  url: string;
  mimeType: string;
  state: string;
  received: number;
  total: number;
  completedAt?: number;
}

export interface BrowserDownloadsHost {
  /** Newest first, isolated to the addressed browser session. */
  downloads(sessionId: string): TrackedBrowserDownload[];
  pause(ms: number, signal?: AbortSignal): Promise<void>;
  /** Above this a file is reported by path instead of attached. */
  attachMaxBytes: number;
}

const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 30_000;
const MIN_WAIT_MS = 500;
const WAIT_POLL_MS = 100;
export const MAX_BROWSER_DOWNLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_BROWSER_SESSION_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export function browserDownloadExceedsLimit(
  received: number,
  total: number,
  sessionReceived = 0,
): boolean {
  return received > MAX_BROWSER_DOWNLOAD_BYTES
    || total > MAX_BROWSER_DOWNLOAD_BYTES
    || sessionReceived > MAX_BROWSER_SESSION_DOWNLOAD_BYTES;
}

export function safeBrowserDownloadName(suggested: string): string {
  const leaf = basename(String(suggested || '').replace(/\\/g, '/')).trim();
  let safe = leaf
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 180);
  if (!safe || safe === '.' || safe === '..') safe = 'download';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  return safe;
}

export function browserDownloadSavePath(
  directory: string,
  suggested: string,
  options: {
    exists?: (path: string) => boolean;
    now?: () => number;
  } = {},
): { file: string; path: string } {
  const file = safeBrowserDownloadName(suggested);
  const exists = options.exists || existsSync;
  const initial = join(directory, file);
  if (!exists(initial)) return { file, path: initial };
  const stamp = (options.now || Date.now)().toString(36);
  for (let index = 0; index < 1_000; index += 1) {
    const prefix = index ? `${stamp}-${index}` : stamp;
    const candidate = join(directory, `${prefix}-${file}`);
    if (!exists(candidate)) return { file, path: candidate };
  }
  throw new Error('could not allocate a unique browser download path');
}

/** Extension-derived type, used only when Chromium reported nothing useful. */
export function downloadMimeType(path: string, fallback: string): string {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  const types: Record<string, string> = {
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    pdf: 'application/pdf',
    html: 'text/html',
    htm: 'text/html',
    xml: 'application/xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    zip: 'application/zip',
  };
  return types[extension] || fallback || 'application/octet-stream';
}

export function createBrowserDownloads(host: BrowserDownloadsHost) {
  const { downloads, pause, attachMaxBytes } = host;

  async function listDownloads(
    sessionId: string,
    command: {
      downloadId?: string;
      wait?: boolean;
      attach?: boolean;
      timeoutMs?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<{ text: string; file?: { mimeType: string; data: string; name: string } }> {
    const timeoutMs = Math.min(
      MAX_WAIT_MS,
      Math.max(
        MIN_WAIT_MS,
        Number.isFinite(command.timeoutMs) ? Math.trunc(command.timeoutMs as number) : DEFAULT_WAIT_MS,
      ),
    );
    if (command.wait) {
      const startedAt = Date.now();
      while (!downloads(sessionId).some((download) => (
        (!command.downloadId || download.id === command.downloadId)
        && download.state !== 'in_progress'
      ))) {
        if (Date.now() - startedAt >= timeoutMs) break;
        await pause(WAIT_POLL_MS, signal);
      }
    }
    const recorded = downloads(sessionId);
    if (recorded.length === 0) return { text: 'No downloads this session.' };
    const lines = recorded.map((entry) => {
      const bytes = entry.total > 0 ? entry.total : entry.received;
      return `- [${entry.id}] ${redactBrowserText(entry.file)} — ${entry.state}, ${Math.max(1, Math.round(bytes / 1024))} KB, ${entry.mimeType} → ${entry.path}\n`
        + `  from ${redactBrowserUrl(entry.url)}`;
    });
    const result: { text: string; file?: { mimeType: string; data: string; name: string } } = {
      text: `Downloads this session (newest first):\n${lines.join('\n')}`,
    };
    if (!command.attach) return result;
    const selected = command.downloadId
      ? recorded.find((download) => download.id === command.downloadId)
      : recorded.find((download) => download.state === 'completed');
    if (!selected) throw new Error('no completed download is available to attach');
    if (selected.state !== 'completed') {
      throw new Error(`download ${selected.id} is ${selected.state}; wait for completion before attaching`);
    }
    const handle = await open(selected.path, 'r');
    let data: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`download ${selected.id} is not a readable file`);
      if (info.size > attachMaxBytes) {
        throw new Error(
          `download ${selected.id} is ${info.size} bytes; inline attachment limit is ${attachMaxBytes} bytes. Use read with path ${selected.path}`,
        );
      }
      data = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== info.size || offset !== info.size) {
        throw new Error(`download ${selected.id} changed while it was being attached; retry`);
      }
    } finally {
      await handle.close();
    }
    result.text += `\n\nAttached download ${selected.id} as ${selected.file}.`;
    result.file = {
      mimeType: downloadMimeType(selected.file, selected.mimeType),
      data: data.toString('base64'),
      name: selected.file,
    };
    return result;
  }

  return { listDownloads };
}
