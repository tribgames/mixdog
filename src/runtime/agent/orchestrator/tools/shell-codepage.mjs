// Console output encoding for native Windows programs (ping, ipconfig, ...).
//
// Design
//  * Producer control first: PowerShell sets [Console]::OutputEncoding to UTF-8
//    (builtin/bash-tool/invocation-plan.mjs). cmd.exe and direct-exe spawns
//    cannot be switched (chcp 65001 changes program language), so they are
//    decoded here.
//  * The encoding is decided PER STREAM, never per chunk. Leading ASCII needs
//    no decision. From the first non-ASCII byte a window is examined: it
//    ends at the 16th non-ASCII byte or WINDOW_CAP bytes after the first
//    non-ASCII byte, whichever comes first (or at end of stream). A window
//    that is strictly valid UTF-8 (a trailing incomplete sequence is
//    tolerated, never judged) => UTF-8, otherwise the system OEM code page.
//    A window that is invalid UTF-8 decides OEM at once. The choice is then
//    committed and one stateful TextDecoder decodes the rest of the stream.
//    The undecided buffer is bounded by WINDOW_CAP, so output flows after it.
//  * Raw capture files (direct capture) use FileEncodingSniffer: the same
//    window rule, with the first non-ASCII byte located anywhere in the file by
//    an incremental, cached scan. It stays undecided (callers read only the
//    ASCII prefix) until the decision is firm or the producer has finished.
//    Files written by the JS path are always UTF-8 and are not sniffed.
//  * Head/tail and task cursors cut on character boundaries of the committed
//    encoding (alignedOffset: UTF-8 continuation rules; DBCS lead/trail rules
//    anchored at a sync byte < 0x40 or, failing that, walked from file start).
//  * Supported OEM pages: DBCS 932/936/949/950 and the exactly-mapped single
//    byte pages 866, 874, 1250-1258. Pages 437/850 (and other pages with no
//    exact WHATWG label) are NOT supported: they stay UTF-8 with the existing
//    binary sanitizer, because substituting another page would mis-decode.
//  * Remaining ambiguity: OEM text whose first WINDOW_CAP bytes after the first
//    non-ASCII byte contain fewer than 16 non-ASCII bytes and happen to be
//    valid UTF-8 (e.g. a lone C6 AE) is read as UTF-8; a stream mixing UTF-8
//    and OEM is decoded entirely with one encoding.
//  * No effect off win32.
import { execFileSync } from 'node:child_process';
import { readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CODEPAGE_LABELS = new Map([
  [866, 'ibm866'],
  [874, 'windows-874'],
  [932, 'shift_jis'],
  [936, 'gbk'],
  [949, 'euc-kr'],
  [950, 'big5'],
  ...[1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258].map((p) => [p, `windows-${p}`]),
]);

const DBCS_LEAD = {
  'euc-kr': (b) => b >= 0x81 && b <= 0xfe,
  gbk: (b) => b >= 0x81 && b <= 0xfe,
  big5: (b) => b >= 0x81 && b <= 0xfe,
  shift_jis: (b) => (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc),
};

const NON_ASCII_DECISION_BYTES = 16;
const WINDOW_CAP = 4096;
const SCAN_CHUNK = 64 * 1024;
const SYNC_BACK_BYTES = 64 * 1024;

let cachedOem;

// TextDecoder label of the system OEM code page, or null (non-Windows, UTF-8
// OEM page, or unsupported page).
export function oemTextEncoding() {
  if (cachedOem !== undefined) return cachedOem;
  cachedOem = null;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 }
      );
      cachedOem = CODEPAGE_LABELS.get(Number(/OEMCP\s+REG_SZ\s+(\d+)/.exec(out)?.[1])) ?? null;
    } catch {}
  }
  return cachedOem;
}

// Evaluate the bytes seen so far (starting anywhere before the first non-ASCII
// byte). `label` is 'utf-8', `oem`, or null (undecided). `firm` = the decision
// cannot change with more bytes; a non-firm label only comes from `final`.
export function evaluateWindow(buffer, oem, final = false) {
  let first = -1;
  let count = 0;
  let cut = buffer.length;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] < 0x80) continue;
    if (first < 0) first = i;
    if (++count === NON_ASCII_DECISION_BYTES) {
      cut = i + 1;
      break;
    }
  }
  if (first < 0) return { label: final ? 'utf-8' : null, firm: false };
  const decisive = count >= NON_ASCII_DECISION_BYTES || buffer.length - first >= WINDOW_CAP;
  const window = buffer.subarray(first, Math.min(cut, first + WINDOW_CAP));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(window, { stream: true });
  } catch {
    return { label: oem, firm: true };
  }
  if (decisive) return { label: 'utf-8', firm: true };
  // Valid prefix, possibly ending in an incomplete sequence: that is never
  // evidence of OEM. Undecided while live; UTF-8 once the producer is done
  // (the truncated tail then renders as U+FFFD).
  return final ? { label: 'utf-8', firm: false } : { label: null, firm: false };
}

// 'utf-8' | oem | null (undecided). `final` = the buffer is the whole stream.
export function sniffShellEncoding(buffer, oem, final = false) {
  if (!oem) return 'utf-8';
  return evaluateWindow(buffer, oem, final).label;
}

// Per-stream encoding decision for a growing raw capture file.
export class FileEncodingSniffer {
  constructor(oem = oemTextEncoding()) {
    this.oem = oem;
    this.label = oem ? null : 'utf-8';
    this.scanPos = 0;
    this.first = -1;
  }

  // Offset up to which bytes are safe to decode while undecided.
  safeEnd(size) {
    return this.label || this.first < 0 ? size : this.first;
  }

  // Returns the label, or null while undecided. Only a firm decision is
  // remembered; `final` (producer finished) forces an answer for this call.
  probe(fd, size, final = false) {
    if (this.label) return this.label;
    if (this.first < 0) {
      const buffer = Buffer.allocUnsafe(SCAN_CHUNK);
      while (this.scanPos < size) {
        const n = readSync(fd, buffer, 0, Math.min(SCAN_CHUNK, size - this.scanPos), this.scanPos);
        if (n <= 0) break;
        let i = 0;
        while (i < n && buffer[i] < 0x80) i++;
        if (i < n) {
          this.first = this.scanPos + i;
          break;
        }
        this.scanPos += n;
      }
    }
    if (this.first < 0) return final ? 'utf-8' : null;
    const length = Math.min(size - this.first, WINDOW_CAP);
    const window = Buffer.allocUnsafe(length);
    const n = readSync(fd, window, 0, length, this.first);
    const result = evaluateWindow(window.subarray(0, n), this.oem, final);
    if (result.firm) this.label = result.label;
    return result.label;
  }
}

export function decodeShellBytes(buffer, oem = oemTextEncoding(), label = null) {
  if (!oem) return buffer.toString('utf8');
  return new TextDecoder(label ?? sniffShellEncoding(buffer, oem, true)).decode(buffer);
}

// Largest character boundary <= limit (buffer starts on a boundary).
export function charBoundaryBefore(buffer, limit, label) {
  const end = Math.min(limit, buffer.length);
  if (label === 'utf-8') {
    let i = end;
    if (i >= buffer.length) return buffer.length;
    while (i > 0 && (buffer[i] & 0xc0) === 0x80) i--;
    return i;
  }
  const isLead = DBCS_LEAD[label];
  if (!isLead) return end;
  let i = 0;
  while (i < end) {
    const step = isLead(buffer[i]) ? 2 : 1;
    if (i + step > end) break;
    i += step;
  }
  return i;
}

// Length of the prefix of `buffer` (which starts on a character boundary) that
// holds only complete characters of `label`: a trailing UTF-8 lead without its
// continuation bytes, or a DBCS lead byte without its trail byte, is excluded.
export function completeLength(buffer, label) {
  if (label === 'utf-8') {
    for (let i = buffer.length - 1; i >= 0 && i >= buffer.length - 4; i--) {
      const b = buffer[i];
      if ((b & 0xc0) === 0x80) continue;
      let need = 1;
      if (b >= 0xf0) need = 4;
      else if (b >= 0xe0) need = 3;
      else if (b >= 0xc0) need = 2;
      return buffer.length - i < need ? i : buffer.length;
    }
    return buffer.length;
  }
  return DBCS_LEAD[label] ? charBoundaryBefore(buffer, buffer.length, label) : buffer.length;
}

// Smallest character boundary >= offset in the file behind `fd`; never an
// unverified offset. DBCS trail bytes are never < 0x40, so such a byte is a
// single-byte character and the next index is a boundary: search back for one
// (bounded), then walk forward by lead/trail rules; with none found, walk from
// the file start.
export function alignedOffset(fd, offset, label) {
  if (offset <= 0) return 0;
  if (label === 'utf-8') {
    const head = Buffer.allocUnsafe(3);
    const n = readSync(fd, head, 0, 3, offset);
    let i = 0;
    while (i < n && (head[i] & 0xc0) === 0x80) i++;
    return offset + i;
  }
  const isLead = DBCS_LEAD[label];
  if (!isLead) return offset;
  const buffer = Buffer.allocUnsafe(SYNC_BACK_BYTES);
  const low = Math.max(0, offset - SYNC_BACK_BYTES);
  const n = readSync(fd, buffer, 0, offset - low, low);
  let base = 0;
  for (let j = n - 1; j >= 0; j--) {
    if (buffer[j] < 0x40) {
      base = low + j + 1;
      break;
    }
  }
  while (base < offset) {
    const got = readSync(fd, buffer, 0, SYNC_BACK_BYTES, base);
    if (got <= 0) break;
    let i = 0;
    while (base + i < offset) {
      const step = isLead(buffer[i]) ? 2 : 1;
      if (i + step > got) break;
      i += step;
    }
    if (i === 0) break;
    base += i;
  }
  return base;
}

// Stateful per-stream decoder with StringDecoder's write/end API. Without an
// OEM page it is a plain UTF-8 StringDecoder. `label` pre-commits the encoding.
export class ShellStreamDecoder {
  constructor(oem = oemTextEncoding(), label = null) {
    this.oem = oem;
    this.td = null;
    this.sd = oem ? null : new StringDecoder('utf8');
    this.held = Buffer.alloc(0);
    if (oem && label) this.td = new TextDecoder(label);
  }

  // Commit `label` while still undecided with nothing held (ASCII-only so far).
  force(label) {
    if (!this.sd && !this.td) this.td = new TextDecoder(label);
  }

  _commit(label) {
    this.td = new TextDecoder(label);
    const held = this.held;
    this.held = Buffer.alloc(0);
    return this.td.decode(held, { stream: true });
  }

  write(chunk) {
    if (this.sd) return this.sd.write(chunk);
    if (this.td) return this.td.decode(chunk, { stream: true });
    let out = '';
    let rest = chunk;
    if (!this.held.length) {
      let i = 0;
      while (i < chunk.length && chunk[i] < 0x80) i++;
      if (i === chunk.length) return chunk.toString('latin1');
      out = chunk.toString('latin1', 0, i);
      rest = chunk.subarray(i);
    }
    const take = rest.subarray(0, WINDOW_CAP - this.held.length);
    this.held = this.held.length ? Buffer.concat([this.held, take]) : Buffer.from(take);
    const { label } = evaluateWindow(this.held, this.oem, false);
    if (!label) return out;
    const text = this._commit(label);
    const remaining = rest.subarray(take.length);
    return out + text + (remaining.length ? this.td.decode(remaining, { stream: true }) : '');
  }

  end() {
    if (this.sd) return this.sd.end();
    if (!this.td) {
      if (!this.held.length) return '';
      const text = this._commit(evaluateWindow(this.held, this.oem, true).label);
      return text + this.td.decode();
    }
    return this.td.decode();
  }
}
