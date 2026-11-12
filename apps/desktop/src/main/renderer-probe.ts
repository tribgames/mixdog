import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainEvent } from 'electron';

import { DESKTOP_IPC } from '../shared/contract';
import { RENDERER_PROBE_FLAG_FILE, RENDERER_PROBE_LOG_FILE } from '../shared/renderer-probe';
import { mixdogDataDirectory } from './computer/shared/common';
import type { DesktopIpcMain, IpcHandle } from './ipc';

const LOG_MAX_BYTES = 4 * 1024 * 1024;
/** A record arrives as JSON text; longer text is refused unread. */
export const PROBE_MESSAGE_MAX_CHARS = 16 * 1024;
export const PROBE_MAX_SCRIPTS = 20;
export const PROBE_MAX_CHANNELS = 100;
/** Lines waiting for the disk; more are dropped and counted. */
export const PROBE_MAX_PENDING_LINES = 64;
export const PROBE_REDACTED = '[redacted]';

const CHANNEL_NAME = /^[\w:.-]{1,80}$/;
const SCHEME = /^(?:https?|file|blob|app|node|chrome-extension|devtools|mixdog[\w-]*):/i;
/** A file name with an optional `:line` or `:line:col`. */
const FILE_LOCATION = /^[\w@-][\w.@-]{0,119}(?::\d{1,7}){0,2}$/;
/** A code name: `publishAgentPool`, `Window.requestAnimationFrame`, `DIV#root.onclick`. */
const CODE_NAME = /^[\w$<>[\]@-][\w$.#<>[\]@-]{0,119}$/;
const INVOKER_TYPES = new Set([
  'user-callback',
  'event-listener',
  'resolve-promise',
  'reject-promise',
  'classic-script',
  'module-script',
]);

type Fields = Record<string, unknown>;

class InvalidRecord extends Error {}

const fields = (value: unknown): Fields =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {};

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidRecord();
  return Math.round(value * 10) / 10;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new InvalidRecord();
  return value as number;
}

/** A script location or code name, or the redaction token: URLs keep only
 *  their file name (no directories, query or fragment), and anything else that
 *  is not shaped like code (prompt text, paths) never reaches the file. */
export function probeLocation(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '';
  if (value.length > 2_048) return PROBE_REDACTED;
  let text = value;
  if (SCHEME.test(text)) {
    try {
      text = new URL(text).pathname.split('/').pop() ?? '';
    } catch {
      return PROBE_REDACTED;
    }
    return FILE_LOCATION.test(text) ? text : PROBE_REDACTED;
  }
  return FILE_LOCATION.test(text) || CODE_NAME.test(text) ? text : PROBE_REDACTED;
}

function frameLine(record: Fields, at: Date): string {
  const scripts = Array.isArray(record.scripts) ? record.scripts : [];
  const kept = [];
  for (let index = 0; index < scripts.length && index < PROBE_MAX_SCRIPTS; index += 1) {
    const script = fields(scripts[index]);
    const invokerType = String(script.invokerType ?? '');
    kept.push({
      invoker: probeLocation(script.invoker),
      invokerType: INVOKER_TYPES.has(invokerType) ? invokerType : PROBE_REDACTED,
      sourceURL: probeLocation(script.sourceURL),
      sourceFunctionName: probeLocation(script.sourceFunctionName),
      sourceCharPosition: Math.max(-1, Math.trunc(finite(script.sourceCharPosition))),
      duration: finite(script.duration),
      forcedStyleAndLayoutDuration: finite(script.forcedStyleAndLayoutDuration),
    });
  }
  return JSON.stringify({
    at: at.toISOString(),
    kind: 'frame',
    entryType: record.entryType === 'longtask' ? 'longtask' : 'long-animation-frame',
    duration: finite(record.duration),
    blockingDuration: finite(record.blockingDuration),
    styleAndLayoutDuration: finite(record.styleAndLayoutDuration),
    scripts: kept,
  });
}

function summaryLine(record: Fields, at: Date, droppedLines: number): string {
  const ipc: Record<string, number> = {};
  const received = fields(record.ipc);
  let read = 0;
  for (const channel in received) {
    if (read++ >= PROBE_MAX_CHANNELS) break;
    if (Object.hasOwn(received, channel) && CHANNEL_NAME.test(channel)) ipc[channel] = count(received[channel]);
  }
  return JSON.stringify({
    at: at.toISOString(),
    kind: 'summary',
    windowMs: finite(record.windowMs),
    frames: count(record.frames),
    longFrames: count(record.longFrames),
    blockedMs: finite(record.blockedMs),
    ipc,
    droppedLines,
  });
}

/** The log line for one renderer message (JSON text), or null when the message
 *  is too long, malformed, or carries a number that is not finite. The line is
 *  rebuilt field by field: timings, counts, channel names, code locations. */
export function rendererProbeLine(message: unknown, at = new Date(), droppedLines = 0): string | null {
  if (typeof message !== 'string' || message.length > PROBE_MESSAGE_MAX_CHARS) return null;
  try {
    const record = fields(JSON.parse(message));
    if (record.kind === 'frame') return frameLine(record, at);
    if (record.kind === 'summary') return summaryLine(record, at, droppedLines);
    return null;
  } catch {
    return null;
  }
}

/** The flag check and the bounded log: one file, rotated once to `.1` when full. */
export function createRendererProbeLog(dataDir: () => string = mixdogDataDirectory) {
  let on = false;
  let size: number | null = null;
  let pending = 0;
  let dropped = 0;
  let writes: Promise<void> = Promise.resolve();
  return {
    /** Re-reads the flag; records are written only while the last read found it. */
    async enabled(): Promise<boolean> {
      on = await stat(join(dataDir(), RENDERER_PROBE_FLAG_FILE)).then(
        () => true,
        () => false
      );
      return on;
    },
    /** Lines dropped because the disk fell behind, since the last summary written. */
    dropped: () => dropped,
    write(message: unknown): Promise<void> {
      if (!on) return writes;
      if (pending >= PROBE_MAX_PENDING_LINES) {
        dropped += 1;
        return writes;
      }
      const line = rendererProbeLine(message, new Date(), dropped);
      if (!line) return writes;
      if (line.includes('"kind":"summary"')) dropped = 0;
      pending += 1;
      writes = writes
        .then(async () => {
          const directory = dataDir();
          const file = join(directory, RENDERER_PROBE_LOG_FILE);
          const bytes = Buffer.byteLength(line) + 1;
          if (size === null) {
            await mkdir(directory, { recursive: true });
            size = await stat(file).then(
              (stats) => stats.size,
              () => 0
            );
          }
          if (size + bytes > LOG_MAX_BYTES) {
            await rename(file, `${file}.1`);
            size = 0;
          }
          await appendFile(file, `${line}\n`, 'utf8');
          size += bytes;
        })
        .catch(() => {
          // Diagnostics only; the next write re-reads the size.
          size = null;
        })
        .finally(() => {
          pending -= 1;
        });
      return writes;
    },
  };
}

export function registerRendererProbeIpc({
  window,
  ipcMain,
  handle,
  log = createRendererProbeLog(),
}: {
  window: BrowserWindow;
  ipcMain: Pick<DesktopIpcMain, 'on' | 'removeListener'>;
  handle: IpcHandle;
  log?: ReturnType<typeof createRendererProbeLog>;
}): () => void {
  handle(DESKTOP_IPC.rendererProbeEnabled, () => log.enabled());
  const onLog = (event: IpcMainEvent, message: unknown): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    void log.write(message);
  };
  ipcMain.on(DESKTOP_IPC.rendererProbeLog, onLog);
  return () => ipcMain.removeListener(DESKTOP_IPC.rendererProbeLog, onLog);
}
