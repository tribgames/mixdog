// Bounded whole-file reads for snapshot, rollback, patch and rescue paths.
// Size is decided from the OPENED descriptor (fstat) and enforced again while
// reading: no more than `maxBytes + 1` bytes are ever pulled into memory, so a
// file that grows after any earlier check is still caught. Binary-ness is
// decided from the WHOLE bounded content with the patch-target codec rule
// (detectTextCodec), never from a prefix.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

/** Per-file limit for content the patch/rescue paths may hold in memory. */
export const PATCH_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
/** Byte budget one transaction's snapshots may hold together. */
export const PATCH_SNAPSHOT_BUDGET_BYTES = 64 * 1024 * 1024;

const CHUNK_BYTES = 64 * 1024;
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
const MIB = 1024 * 1024;

export function createSnapshotBudget(totalBytes = PATCH_SNAPSHOT_BUDGET_BYTES) {
  return { total: totalBytes, remaining: totalBytes };
}

// Codec of a text file. A BOM is authoritative; a BOM-LESS file is classified
// by NUL-byte parity, which is what separates UTF-16 text from UTF-8 text.
// `certain:false` means the bytes cannot be attributed to one codec.
// Minimum evidence for a BOM-less UTF-16 verdict: 16 code units. Below that a
// NUL is just as likely to be a stray byte inside UTF-8 text (`61 00`), so
// short input is undecidable by definition. `buf` must be the WHOLE file: a
// prefix cannot rule out a parity flip further in, so a prefix-only caller
// passes `partial:true` and gets "undecidable" instead of a guess.
const UTF16_MIN_EVIDENCE_BYTES = 32;
const UTF16_MIN_NUL_RATIO = 0.5;

export function detectTextCodec(bytes, { partial = false } = {}) {
  const undecidable = { encoding: null, bomLen: 0, certain: false };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf16le', bomLen: 2, certain: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf16be', bomLen: 2, certain: true };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf8', bomLen: 3, certain: true };
  }
  let nulEven = 0;
  let nulOdd = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue;
    if (i % 2 === 0) nulEven += 1;
    else nulOdd += 1;
  }
  if (partial) return undecidable;
  if (nulEven === 0 && nulOdd === 0) return { encoding: 'utf8', bomLen: 0, certain: true };
  if (bytes.length < UTF16_MIN_EVIDENCE_BYTES || bytes.length % 2 !== 0) return undecidable;
  const evenSlots = Math.ceil(bytes.length / 2);
  const oddSlots = Math.floor(bytes.length / 2);
  if (nulEven === 0 && nulOdd / oddSlots >= UTF16_MIN_NUL_RATIO) {
    return { encoding: 'utf16le', bomLen: 0, certain: true };
  }
  if (nulOdd === 0 && nulEven / evenSlots >= UTF16_MIN_NUL_RATIO) {
    return { encoding: 'utf16be', bomLen: 0, certain: true };
  }
  return undecidable;
}

/** Binary = NUL bytes the text codec cannot attribute. `content` must be the
 *  whole file. */
export function looksBinary(content) {
  return content.includes(0) && !detectTextCodec(content).certain;
}

function notRegularFile(path) {
  const error = new Error(`not a regular file: ${path}`);
  error.code = 'ENOTREGULAR';
  return error;
}

function readAt(fd, buffer, position) {
  let total = 0;
  while (total < buffer.length) {
    const read = readSync(fd, buffer, total, buffer.length - total, position + total);
    if (read === 0) break;
    total += read;
  }
  return total;
}

/**
 * One bounded read. Resolves to:
 *   { state: 'absent' }
 *   { state: 'present', content, size, statSize, mode, mtimeMs }
 *   { state: 'omitted', reason: 'oversized'|'binary'|'budget', size, statSize, mode, mtimeMs }
 *   { state: 'classified', ... }  (classifyOnly: size and binary-ness checked
 *     from a bounded read, content not returned or charged to a budget)
 * `detectBinary:false` returns NUL-bearing content as present: for callers
 * that run the codec decision themselves.
 * Throws ENOTREGULAR for anything but a regular file (symlinks are followed,
 * like statSync), and every other open/read error unchanged.
 */
export function readBoundedFile(
  path,
  { maxBytes = PATCH_SNAPSHOT_MAX_BYTES, budget = null, classifyOnly = false, detectBinary = true } = {}
) {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    if (ABSENT_CODES.has(error?.code)) return { state: 'absent' };
    throw error;
  }
  // Checked before open: opening a FIFO would block.
  if (!stat.isFile()) throw notRegularFile(path);
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (ABSENT_CODES.has(error?.code)) return { state: 'absent' };
    throw error;
  }
  try {
    const fstat = fstatSync(fd);
    if (!fstat.isFile()) throw notRegularFile(path);
    const meta = { size: fstat.size, statSize: fstat.size, mode: fstat.mode, mtimeMs: fstat.mtimeMs };
    const omitted = (reason, size = fstat.size) => ({ state: 'omitted', reason, ...meta, size });
    if (fstat.size > maxBytes) return omitted('oversized');
    if (!classifyOnly && budget && fstat.size > budget.remaining) return omitted('budget');
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, maxBytes + 1 - total));
      const read = readAt(fd, chunk, total);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      total += read;
      if (read < chunk.length) break;
    }
    if (total > maxBytes) return omitted('oversized', total);
    const content = Buffer.concat(chunks, total);
    if (detectBinary && looksBinary(content)) return omitted('binary', total);
    if (classifyOnly) return { state: 'classified', ...meta, size: total };
    if (budget && total > budget.remaining) return omitted('budget', total);
    if (budget) budget.remaining -= total;
    return { state: 'present', content, ...meta, size: total };
  } finally {
    closeSync(fd);
  }
}

/** Human phrase for an omitted read: "binary (N bytes)", "larger than 8 MiB (N bytes)". */
export function describeOmittedFile({ reason, size } = {}) {
  const bytes = `${Number(size) || 0} bytes`;
  if (reason === 'binary') return `binary (NUL bytes without a decidable text encoding, ${bytes})`;
  if (reason === 'budget')
    return `over the ${PATCH_SNAPSHOT_BUDGET_BYTES / MIB} MiB per-patch snapshot budget (${bytes})`;
  return `larger than ${PATCH_SNAPSHOT_MAX_BYTES / MIB} MiB (${bytes})`;
}
