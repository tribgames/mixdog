// Incremental delivery of a shell task's output. Each task (the authorized
// task object) owns one cursor per stream; every wait, read, background move
// and completion notice delivers only the bytes after it, in the shared
// delivery shape (lib/shell-delivery.mjs). The cursor always advances over the
// whole unseen range, even when its middle is omitted: omitted bytes are never
// re-sent, the marker's log path is how to get them back.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { stripAnsi } from '../../shell-exec-output.mjs';
import { FileEncodingSniffer, ShellStreamDecoder, alignedOffset, oemTextEncoding } from '../../shell-codepage.mjs';
import {
  DELIVERY_FULL_CHARS,
  countNewlines,
  createCarriageReturnFolder,
  edgesPiece,
  escapeHarnessTags,
  fitPieces,
  formatKb,
  omissionMarker,
  persistDeliveryLog,
  prepareShellText,
  textPiece,
} from './shell-delivery.mjs';

const cursors = new WeakMap();
const ESC = '\x1b';
const PENDING_ANSI_INTRODUCER = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*|\\](?:(?!${ESC}\\\\)[^\x07\x9c])*)?$`);
// An unseen range up to this size is read whole; a longer one only at its two
// ends (the middle is counted, never loaded).
const FULL_READ_BYTES = 64 * 1024;
const EDGE_READ_BYTES = 16 * 1024;
const COUNT_CHUNK_BYTES = 1 << 20;

function newCursor() {
  return {
    offset: 0,
    preview: '',
    decoder: new ShellStreamDecoder(),
    ansi: '',
    fold: createCarriageReturnFolder(),
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

function readBytes(fd, start, length) {
  const buffer = Buffer.alloc(Math.max(0, length));
  const count = length > 0 ? readSync(fd, buffer, 0, length, start) : 0;
  return buffer.subarray(0, count);
}

function countNewlinesInRange(fd, start, end) {
  let count = 0;
  const buffer = Buffer.alloc(Math.min(COUNT_CHUNK_BYTES, Math.max(1, end - start)));
  for (let position = start; position < end; ) {
    const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
    if (bytes <= 0) break;
    for (let i = 0; i < bytes; i += 1) if (buffer[i] === 10) count += 1;
    position += bytes;
  }
  return count;
}

function decodeVisible(cursor, bytes, flush) {
  let decoded = cursor.decoder.write(bytes);
  if (flush) decoded += cursor.decoder.end();
  return prepareShellText(visibleText(cursor, decoded), cursor.fold);
}

// One unseen file range [start, end) in the delivery shape. A long range is
// read only at its ends; the tail starts a fresh decoder at a character
// boundary, as the original paging did when it skipped bytes.
function readRange(fd, cursor, { start, end, label, flush, path }) {
  const total = end - start;
  if (total <= FULL_READ_BYTES) {
    const text = decodeVisible(cursor, readBytes(fd, start, total), flush);
    return { piece: textPiece(text, { path }), bytes: total, lines: countNewlines(text), text };
  }
  const headText = decodeVisible(cursor, readBytes(fd, start, EDGE_READ_BYTES), false);
  const tailStart = alignedOffset(fd, end - EDGE_READ_BYTES, label || 'utf-8');
  cursor.decoder = new ShellStreamDecoder(oemTextEncoding(), label);
  cursor.ansi = '';
  cursor.fold = createCarriageReturnFolder();
  const tailText = decodeVisible(cursor, readBytes(fd, tailStart, end - tailStart), flush);
  const lines = countNewlinesInRange(fd, start, end);
  return {
    piece: edgesPiece(headText, tailText, { totalBytes: total, totalLines: lines, path }),
    bytes: total,
    lines,
    text: tailText,
  };
}

const PERCENT_RE = /(\d{1,3}(?:\.\d+)?)\s?%/g;
const ETA_RE = /\b(?:ETA|eta|remaining|left)\b[:=\s]*(\d+(?::\d{2}){1,2}|\d+(?:\.\d+)?\s?(?:h|m|s|min|sec)\b)/g;

function lastMatch(pattern, text) {
  let found = null;
  for (const match of text.matchAll(pattern)) found = match;
  return found;
}

/** What changed since the agent last saw the job: growth, last line, any
 *  visible percent/ETA. Used where a still-running job is reported. */
function progressDigest(growth) {
  const bytes = growth.reduce((sum, entry) => sum + entry.bytes, 0);
  const lines = growth.reduce((sum, entry) => sum + entry.lines, 0);
  const text = growth
    .map((entry) => entry.text)
    .filter(Boolean)
    .join('\n');
  const parts = [
    bytes > 0 ? `+${formatKb(bytes)}, +${lines} lines since you last saw it` : 'no new output since you last saw it',
  ];
  const last = text
    .split('\n')
    .reverse()
    .find((line) => line.trim());
  if (last) parts.push(`last line: ${JSON.stringify(last.trim().slice(0, 200))}`);
  const percent = lastMatch(PERCENT_RE, text);
  if (percent && Number(percent[1]) <= 100) parts.push(`${percent[1]}%`);
  const eta = lastMatch(ETA_RE, text);
  if (eta) parts.push(`ETA ${eta[1].trim()}`);
  return `[progress] ${parts.join(' · ')} — still running, not an error`;
}

/** A whole finished log as a piece of the delivery (a foreground command whose
 *  capture spilled to disk), read with a fresh cursor. */
export function shellLogPiece(path) {
  const cursor = newCursor();
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const label = cursor.sniffer.probe(fd, size, true);
    if (label) cursor.decoder.force(label);
    return readRange(fd, cursor, { start: 0, end: size, label, flush: true, path }).piece;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Cursor ownership follows the authorized task object, not a globally supplied
// task id. Bounded synchronous reads make concurrent task reads non-overlapping.
// Only bytes actually read advance the cursor; previews never stand in for a
// file offset, since a preview may contain an omitted middle.
// Explicit tail reads (`output: 'tail'`) never change the incremental cursor.
// `terminal` flushes the decoders (the producer finished); `digest` prefixes
// the progress digest for a job reported while still running.
export function readShellTaskOutput(
  task,
  result = {},
  { output = 'new', terminal = task.status !== 'running', digest = false } = {}
) {
  const replay = output === 'tail';
  const growth = [];
  let streams = replay ? new Map() : cursors.get(task);
  if (!streams) {
    streams = new Map();
    cursors.set(task, streams);
  }
  // A note, or a stream's body: stdout and stderr share one delivery budget.
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
      const text = prepareShellText(visibleText(cursor, delta), cursor.fold);
      cursor.preview = preview;
      growth.push({ bytes: Buffer.byteLength(delta), lines: countNewlines(text), text });
      // A preview has no log of its own: a capped one is saved for the marker.
      if (text)
        sections.push({
          prefix: `[${stream}]\n`,
          piece: textPiece(text, { path: () => persistDeliveryLog(text, stream) }),
        });
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
      let start = cursor.offset;
      let earlier = '';
      if (replay && readEnd - start > FULL_READ_BYTES) {
        // A replay shows the recent part; everything before it is counted.
        start = Math.min(readEnd, alignedOffset(fd, readEnd - FULL_READ_BYTES, label || 'utf-8'));
        earlier = omissionMarker({ lines: countNewlinesInRange(fd, 0, start), bytes: start, path });
        cursor.decoder = new ShellStreamDecoder(oemTextEncoding(), label);
      }
      const range = readRange(fd, cursor, { start, end: readEnd, label, flush: terminal && readEnd === size, path });
      cursor.offset = readEnd;
      growth.push(range);
      if (range.piece.natural)
        sections.push({ prefix: `[${stream}]\n${earlier ? `${earlier}\n` : ''}`, piece: range.piece });
    } catch (error) {
      sections.push(`[${stream} read error: ${error.message}]`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  // Notes and prefixes come off the budget; the streams split what is left.
  const fixed = sections.reduce(
    (sum, item) => sum + (item.prefix ?? item).length,
    2 * Math.max(0, sections.length - 1)
  );
  const pieces = sections.filter((item) => item.piece);
  const bodies = fitPieces(
    pieces.map((item) => item.piece),
    DELIVERY_FULL_CHARS - fixed
  );
  const body =
    sections.map((item) => (item.piece ? `${item.prefix}${bodies[pieces.indexOf(item)]}` : item)).join('\n\n') ||
    (replay ? '(no output)' : '(no new output)');
  return escapeHarnessTags(digest ? `${progressDigest(growth)}\n\n${body}` : body);
}
