import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { stripAnsi } from '../../shell-exec-output.mjs';

const PAGE_BYTES = 8 * 1024;
const COMPLETION_BYTES = 12 * 1024;
const cursors = new WeakMap();

function newCursor() {
  return { offset: 0, preview: '', decoder: new StringDecoder('utf8'), ansi: '' };
}

function visibleText(cursor, text) {
  const value = cursor.ansi + text;
  // Retain only the introducer of an unfinished CSI/OSC, not its potentially
  // unbounded payload. It will be stripped with the following chunk.
  const pending = /\x1b(?:\[[0-?]*[ -/]*|\](?:(?!\x1b\\)[^\x07\x9c])*)?$/.exec(value);
  cursor.ansi = '';
  if (!pending) return stripAnsi(value);
  const sequence = pending[0];
  cursor.ansi = sequence.startsWith('\x1b]')
    ? `\x1b]${sequence.endsWith('\x1b') ? '\x1b' : ''}`
    : sequence.startsWith('\x1b[') ? '\x1b[' : '\x1b';
  return stripAnsi(value.slice(0, pending.index));
}

// Cursor ownership follows the authorized task object, not a globally supplied
// task id. Bounded synchronous reads make concurrent task reads non-overlapping.
// Only bytes actually read advance the cursor; previews never stand in for a
// file offset, since a preview may contain an omitted middle.
// Explicit tail reads never change the incremental cursor. A terminal read
// prioritizes the final diagnostics; any skipped bytes remain in the raw file.
export function readShellTaskOutput(task, result = {}, { output = 'new' } = {}) {
  const replay = output === 'tail';
  const terminal = task.status !== 'running';
  const limit = terminal || replay ? COMPLETION_BYTES : PAGE_BYTES;
  let streams = replay ? new Map() : cursors.get(task);
  if (!streams) {
    streams = new Map();
    cursors.set(task, streams);
  }
  const sections = [];
  for (const stream of ['stdout', 'stderr']) {
    const path = result[`${stream}_path`];
    if (stream === 'stderr' && path && path === result.stdout_path) continue;
    const key = path || stream;
    let cursor = streams.get(key);
    if (!cursor) {
      cursor = newCursor();
      streams.set(key, cursor);
    }
    if (!path) {
      const preview = String(result[`${stream}_preview`] || '');
      const delta = preview.startsWith(cursor.preview) ? preview.slice(cursor.preview.length) : preview;
      const bytes = Buffer.from(delta);
      let start = Math.max(0, bytes.length - limit);
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      if (start) {
        sections.push(`[${stream}: ${start} preview bytes omitted; no original log path available]`);
        cursor.ansi = '';
      }
      const text = visibleText(cursor, bytes.subarray(start).toString('utf8'));
      cursor.preview = preview;
      if (text) sections.push(`[${stream}]\n${text}`);
      continue;
    }
    let fd;
    try {
      fd = openSync(path, 'r');
      const size = fstatSync(fd).size;
      if (size < cursor.offset) {
        sections.push(`[${stream} log truncated; reading from start]`);
        cursor = newCursor();
        streams.set(key, cursor);
      }
      const start = terminal || replay ? Math.max(cursor.offset, size - limit) : cursor.offset;
      const skipped = start - cursor.offset;
      if (skipped) {
        cursor.decoder = new StringDecoder('utf8');
        cursor.ansi = '';
      }
      const buffer = Buffer.alloc(Math.min(limit, Math.max(0, size - start)));
      const count = buffer.length ? readSync(fd, buffer, 0, buffer.length, start) : 0;
      let prefix = 0;
      if (skipped) while (prefix < count && (buffer[prefix] & 0xc0) === 0x80) prefix++;
      if (skipped + prefix) {
        sections.push(`[${stream}: ${skipped + prefix} earlier bytes omitted; read ${path} for the original log]`);
      }
      cursor.offset = start + count;
      let decoded = cursor.decoder.write(buffer.subarray(prefix, count));
      if (terminal && cursor.offset === size) decoded += cursor.decoder.end();
      const text = visibleText(cursor, decoded);
      if (text) sections.push(`[${stream}]\n${text}`);
      if (cursor.offset < size) {
        sections.push(`[${stream}: ${size - cursor.offset} unread bytes; task read continues, read ${path} for the original log]`);
      }
    } catch (error) {
      sections.push(`[${stream} read error: ${error.message}]`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return sections.join('\n\n') || (replay ? '(no output)' : '(no new output)');
}
