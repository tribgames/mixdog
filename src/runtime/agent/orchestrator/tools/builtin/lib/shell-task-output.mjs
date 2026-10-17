import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { stripAnsi } from '../../shell-exec-output.mjs';
import { FileEncodingSniffer, ShellStreamDecoder, alignedOffset, oemTextEncoding } from '../../shell-codepage.mjs';

import { TOOL_OUTPUT_PAGE_BYTES, TOOL_OUTPUT_TAIL_BYTES } from '../../../../../shared/tool-output-budget.mjs';
const cursors = new WeakMap();
const ESC = '\x1b';
const PENDING_ANSI_INTRODUCER = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*|\\](?:(?!${ESC}\\\\)[^\x07\x9c])*)?$`);

function newCursor() {
  return {
    offset: 0,
    preview: '',
    decoder: new ShellStreamDecoder(),
    ansi: '',
    sniffer: new FileEncodingSniffer(),
    committed: false,
  };
}

// Only the introducer is retained, plus the ESC that may open a split OSC
// terminator (`ESC \`), so the next chunk can complete the sequence.
function pendingAnsiIntroducer(sequence) {
  if (sequence.startsWith('\x1b]')) return sequence.endsWith('\x1b') ? '\x1b]\x1b' : '\x1b]';
  if (sequence.startsWith('\x1b[')) return '\x1b[';
  return '\x1b';
}

// First index at or after `start` that does not sit inside a UTF-8 sequence.
function utf8Boundary(bytes, start, end) {
  let index = start;
  while (index < end && (bytes[index] & 0xc0) === 0x80) index++;
  return index;
}

function visibleText(cursor, text) {
  const value = cursor.ansi + text;
  // Retain only the introducer of an unfinished CSI/OSC, not its potentially
  // unbounded payload. It will be stripped with the following chunk.
  const pending = PENDING_ANSI_INTRODUCER.exec(value);
  cursor.ansi = '';
  if (!pending) return stripAnsi(value);
  const sequence = pending[0];
  cursor.ansi = pendingAnsiIntroducer(sequence);
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
  const limit = terminal || replay ? TOOL_OUTPUT_TAIL_BYTES : TOOL_OUTPUT_PAGE_BYTES;
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
      const start = utf8Boundary(bytes, Math.max(0, bytes.length - limit), bytes.length);
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
      // Raw capture files carry the child's bytes. The stream's encoding is
      // decided once, firmly (or when the task is terminal); until then only
      // the ASCII prefix is read.
      const label = cursor.sniffer.probe(fd, size, terminal);
      if (label && !cursor.committed) {
        cursor.committed = true;
        cursor.decoder.force(label);
      }
      const readEnd = label ? size : cursor.sniffer.safeEnd(size);
      let start = terminal || replay ? Math.max(cursor.offset, readEnd - limit) : cursor.offset;
      if (start > cursor.offset) {
        start = Math.min(readEnd, alignedOffset(fd, start, label || 'utf-8'));
        sections.push(`[${stream}: ${start - cursor.offset} earlier bytes omitted; read ${path} for the original log]`);
        cursor.decoder = new ShellStreamDecoder(oemTextEncoding(), label);
        cursor.ansi = '';
      }
      const buffer = Buffer.alloc(Math.min(limit, Math.max(0, readEnd - start)));
      const count = buffer.length ? readSync(fd, buffer, 0, buffer.length, start) : 0;
      cursor.offset = start + count;
      let decoded = cursor.decoder.write(buffer.subarray(0, count));
      if (terminal && cursor.offset === size) decoded += cursor.decoder.end();
      const text = visibleText(cursor, decoded);
      if (text) sections.push(`[${stream}]\n${text}`);
      if (cursor.offset < size) {
        sections.push(
          `[${stream}: ${size - cursor.offset} unread bytes; task read continues, read ${path} for the original log]`
        );
      }
    } catch (error) {
      sections.push(`[${stream} read error: ${error.message}]`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return sections.join('\n\n') || (replay ? '(no output)' : '(no new output)');
}
