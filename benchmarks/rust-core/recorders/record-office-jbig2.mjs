#!/usr/bin/env node
// JBIG2 and CCITT fax decoding goldens (track nr-office, task nr-office-pdf-jbig2-generic): what pdf.js 6.4.299's
// jbig2.wasm (PDFium's fxcodec JBIG2 and fax decoders) makes of streams this recorder writes, decoded through
// pdfjs-dist's image_decoders (`Jbig2Image.decode`, the wrapper `Jbig2Stream` and `CCITTFaxStream` call) with the wasm
// module supplied the way the worker supplies it.
//
// Which module the Node product loads: none. Neither pdf-document.mjs nor pdf-render.mjs nor pdf-extract.mjs gives
// getDocument a `wasmUrl`, so in the product's Node configuration pdf.js cannot instantiate jbig2.wasm and has no
// fallback module to import ("nulljbig2_nowasm_fallback.js"): a JBIG2 or CCITT image fails with "Jbig2Error: JBig2
// failed to initialize". The recorder records that observation (manifest `productConfiguration`, from a PDF with a
// JBIG2 image opened as the product opens its PDFs) and takes the decoder pdf.js uses when it is given its wasm
// files (jbig2.wasm and its asm.js twin jbig2_nowasm_fallback.js are the same code) as the reference.
//
// Streams: generic regions (templates 0 to 3, typical prediction, default and moved adaptive pixels, MMR), generic
// refinement regions (templates 0 and 1, typical prediction, adaptive pixels, intermediate and page references),
// page composition (every operator, the default pixel, clipping, striping), segment headers (long form, long segment
// numbers), end segments, unknown-length regions, the globals stream, truncated and byte-flipped streams, image sizes;
// CCITT G3 1-D and 2-D, G4, every option, every run length, odd widths, truncated and random data, the decoder's
// size rules. The streams are written by the encoders below (T.88 and T.4 / T.6), a stream the wasm decoder does not
// read back as the image encoded is not kept where it was meant to decode exactly (the recorder asserts that for
// the clean streams); every other stream's expected output is whatever the decoder produces, success or failure.
//
//   node benchmarks/rust-core/recorders/record-office-jbig2.mjs --tree <Node product tree with node_modules>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-jbig2.mjs';
const SET = 'office-jbig2';

// ---- encoders (ITU-T T.88 Annex E and A, T.4, T.6) ------------------------------------------------------------------
// Bitmaps are { width, height, data: Uint8Array } with one byte per pixel, 1 = black.

export function bitmap(width, height, fill = 0) {
  return { width, height, data: new Uint8Array(width * height).fill(fill) };
}
export const getPixel = (b, x, y) => (x < 0 || y < 0 || x >= b.width || y >= b.height ? 0 : b.data[y * b.width + x]);

/** Deterministic generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A bilevel picture with blobs, lines, rectangles and a little noise: compressible, with runs of every length. */
export function scene(width, height, seed, noise = 0.02) {
  const r = rng(seed);
  const b = bitmap(width, height);
  const set = (x, y, v = 1) => {
    if (x >= 0 && y >= 0 && x < width && y < height) b.data[y * width + x] = v;
  };
  const shapes = 3 + Math.floor((width * height) / 400);
  for (let s = 0; s < shapes; s += 1) {
    const kind = Math.floor(r() * 4);
    const x0 = Math.floor(r() * width);
    const y0 = Math.floor(r() * height);
    const w = 1 + Math.floor(r() * Math.max(2, width / 3));
    const h = 1 + Math.floor(r() * Math.max(2, height / 3));
    if (kind === 0) for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) set(x, y);
    else if (kind === 1) for (let x = x0; x < x0 + w; x += 1) set(x, y0);
    else if (kind === 2) for (let i = 0; i < Math.min(w, h) * 2; i += 1) set(x0 + i, y0 + i);
    else for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) if ((x - x0 + y - y0) % 3 === 0) set(x, y);
  }
  for (let i = 0; i < width * height * noise; i += 1) {
    const x = Math.floor(r() * width);
    const y = Math.floor(r() * height);
    set(x, y, 1 - getPixel(b, x, y));
  }
  return b;
}

// ---- MQ coder ---------------------------------------------------------------------------------------------------

const QE = [
  [0x5601, 1, 1, 1], [0x3401, 2, 6, 0], [0x1801, 3, 9, 0], [0x0ac1, 4, 12, 0], [0x0521, 5, 29, 0], [0x0221, 38, 33, 0],
  [0x5601, 7, 6, 1], [0x5401, 8, 14, 0], [0x4801, 9, 14, 0], [0x3801, 10, 14, 0], [0x3001, 11, 17, 0], [0x2401, 12, 18, 0],
  [0x1c01, 13, 20, 0], [0x1601, 29, 21, 0], [0x5601, 15, 14, 1], [0x5401, 16, 14, 0], [0x5101, 17, 15, 0],
  [0x4801, 18, 16, 0], [0x3801, 19, 17, 0], [0x3401, 20, 18, 0], [0x3001, 21, 19, 0], [0x2801, 22, 19, 0],
  [0x2401, 23, 20, 0], [0x2201, 24, 21, 0], [0x1c01, 25, 22, 0], [0x1801, 26, 23, 0], [0x1601, 27, 24, 0],
  [0x1401, 28, 25, 0], [0x1201, 29, 26, 0], [0x1101, 30, 27, 0], [0x0ac1, 31, 28, 0], [0x09c1, 32, 29, 0],
  [0x08a1, 33, 30, 0], [0x0521, 34, 31, 0], [0x0441, 35, 32, 0], [0x02a1, 36, 33, 0], [0x0221, 37, 34, 0],
  [0x0141, 38, 35, 0], [0x0111, 39, 36, 0], [0x0085, 40, 37, 0], [0x0049, 41, 38, 0], [0x0025, 42, 39, 0],
  [0x0015, 43, 40, 0], [0x0009, 44, 41, 0], [0x0005, 45, 42, 0], [0x0001, 45, 43, 0], [0x5601, 46, 46, 0],
];

export class MqEncoder {
  constructor() {
    this.buf = [0];
    this.bp = 0;
    this.a = 0x8000;
    this.c = 0;
    this.ct = 12;
  }
  #byteOut() {
    const { buf } = this;
    if (buf[this.bp] === 0xff) {
      this.bp += 1;
      buf[this.bp] = Math.floor(this.c / 2 ** 20);
      this.c %= 2 ** 20;
      this.ct = 7;
    } else if (this.c < 0x8000000) {
      this.bp += 1;
      buf[this.bp] = Math.floor(this.c / 2 ** 19);
      this.c %= 2 ** 19;
      this.ct = 8;
    } else {
      buf[this.bp] += 1;
      if (buf[this.bp] === 0xff) {
        this.c %= 0x8000000;
        this.bp += 1;
        buf[this.bp] = Math.floor(this.c / 2 ** 20);
        this.c %= 2 ** 20;
        this.ct = 7;
      } else {
        this.bp += 1;
        buf[this.bp] = Math.floor(this.c / 2 ** 19) & 0xff;
        this.c %= 2 ** 19;
        this.ct = 8;
      }
    }
  }
  #renorm() {
    do {
      this.a = (this.a << 1) & 0xffff;
      this.c *= 2;
      this.ct -= 1;
      if (this.ct === 0) this.#byteOut();
    } while ((this.a & 0x8000) === 0);
  }
  /** cx is a context table { i: Uint8Array, mps: Uint8Array }. */
  encode(cx, index, d) {
    const [qe, nmps, nlps, sw] = QE[cx.i[index]];
    this.a -= qe;
    if (d === cx.mps[index]) {
      if ((this.a & 0x8000) === 0) {
        if (this.a < qe) this.a = qe;
        else this.c += qe;
        cx.i[index] = nmps;
        this.#renorm();
      } else this.c += qe;
    } else {
      if (this.a < qe) this.c += qe;
      else this.a = qe;
      if (sw) cx.mps[index] = 1 - cx.mps[index];
      cx.i[index] = nlps;
      this.#renorm();
    }
  }
  flush() {
    const tempc = this.c + this.a;
    this.c = this.c - (this.c % 65536) + 0xffff; // C |= 0xFFFF
    if (this.c >= tempc) this.c -= 0x8000;
    this.c *= 2 ** this.ct;
    this.#byteOut();
    this.c *= 2 ** this.ct;
    this.#byteOut();
    if (this.buf[this.bp] !== 0xff) {
      this.bp += 1;
      this.buf[this.bp] = 0xff;
    }
    this.bp += 1;
    this.buf[this.bp] = 0xac;
    return Uint8Array.from(this.buf.slice(1, this.bp + 1));
  }
}

export const contexts = (n) => ({ i: new Uint8Array(n), mps: new Uint8Array(n) });

// ---- generic region -----------------------------------------------------------------------------------------------

export const DEFAULT_AT = {
  0: [3, -1, -3, -1, 2, -2, -2, -2],
  1: [3, -1],
  2: [2, -1],
  3: [2, -1],
};
const GB_BITS = [16, 13, 10, 10];
const GB_LTP = [0x9b25, 0x0795, 0x00e5, 0x0195];

// The context numbering is the standard's: the pixel read first (top row, leftmost) is the most significant bit, so
// the pixel left of the current one is bit 0. The typical-prediction decision uses a context of this numbering.
function genericContext(b, template, at, x, y) {
  const p = (dx, dy) => getPixel(b, x + dx, y + dy);
  switch (template) {
    case 0:
      return (
        p(-1, 0) | (p(-2, 0) << 1) | (p(-3, 0) << 2) | (p(-4, 0) << 3) | (p(at[0], at[1]) << 4) |
        (p(2, -1) << 5) | (p(1, -1) << 6) | (p(0, -1) << 7) | (p(-1, -1) << 8) | (p(-2, -1) << 9) |
        (p(at[2], at[3]) << 10) | (p(at[4], at[5]) << 11) | (p(1, -2) << 12) | (p(0, -2) << 13) | (p(-1, -2) << 14) |
        (p(at[6], at[7]) << 15)
      );
    case 1:
      return (
        p(-1, 0) | (p(-2, 0) << 1) | (p(-3, 0) << 2) | (p(at[0], at[1]) << 3) | (p(2, -1) << 4) | (p(1, -1) << 5) |
        (p(0, -1) << 6) | (p(-1, -1) << 7) | (p(-2, -1) << 8) | (p(2, -2) << 9) | (p(1, -2) << 10) | (p(0, -2) << 11) |
        (p(-1, -2) << 12)
      );
    case 2:
      return (
        p(-1, 0) | (p(-2, 0) << 1) | (p(at[0], at[1]) << 2) | (p(1, -1) << 3) | (p(0, -1) << 4) | (p(-1, -1) << 5) |
        (p(-2, -1) << 6) | (p(1, -2) << 7) | (p(0, -2) << 8) | (p(-1, -2) << 9)
      );
    default:
      return (
        p(-1, 0) | (p(-2, 0) << 1) | (p(-3, 0) << 2) | (p(-4, 0) << 3) | (p(at[0], at[1]) << 4) | (p(1, -1) << 5) |
        (p(0, -1) << 6) | (p(-1, -1) << 7) | (p(-2, -1) << 8) | (p(-3, -1) << 9)
      );
  }
}

/** Arithmetic coded generic region data (the bytes after the segment's AT bytes), ending in the 0xFF 0xAC marker. */
export function encodeGeneric(b, { template = 0, tpgdon = false, at = DEFAULT_AT[template], skip = null } = {}) {
  const enc = new MqEncoder();
  const cx = contexts(1 << GB_BITS[template]);
  let ltp = 0;
  for (let y = 0; y < b.height; y += 1) {
    if (tpgdon) {
      let same = 1;
      for (let x = 0; x < b.width; x += 1) if (b.data[y * b.width + x] !== getPixel(b, x, y - 1)) same = 0;
      enc.encode(cx, GB_LTP[template], same ^ ltp);
      ltp = same;
      if (ltp) continue;
    }
    for (let x = 0; x < b.width; x += 1) {
      if (skip && getPixel(skip, x, y)) continue;
      enc.encode(cx, genericContext(b, template, at, x, y), b.data[y * b.width + x]);
    }
  }
  return enc.flush();
}

// ---- generic refinement region ----------------------------------------------------------------------------------

export const DEFAULT_RAT = [-1, -1, -1, -1];

function refineContext(b, ref, template, rat, x, y, dx, dy) {
  const p = (ox, oy) => getPixel(b, x + ox, y + oy);
  const r = (ox, oy) => getPixel(ref, x - dx + ox, y - dy + oy);
  if (template === 0) {
    return (
      r(1, 1) | (r(0, 1) << 1) | (r(-1, 1) << 2) | (r(1, 0) << 3) | (r(0, 0) << 4) | (r(-1, 0) << 5) | (r(1, -1) << 6) |
      (r(0, -1) << 7) | (r(rat[2], rat[3]) << 8) | (p(-1, 0) << 9) | (p(1, -1) << 10) | (p(0, -1) << 11) |
      (p(rat[0], rat[1]) << 12)
    );
  }
  return (
    r(1, 1) | (r(0, 1) << 1) | (r(1, 0) << 2) | (r(0, 0) << 3) | (r(-1, 0) << 4) | (r(0, -1) << 5) | (p(-1, 0) << 6) |
    (p(1, -1) << 7) | (p(0, -1) << 8) | (p(-1, -1) << 9)
  );
}

const uniformNeighbourhood = (ref, x, y) => {
  const v = getPixel(ref, x, y);
  for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) if (getPixel(ref, x + ox, y + oy) !== v) return false;
  return true;
};

export function encodeRefinement(b, ref, { template = 0, tpgron = false, at = DEFAULT_RAT, dx = 0, dy = 0 } = {}) {
  const enc = new MqEncoder();
  const cx = contexts(template === 0 ? 1 << 13 : 1 << 10);
  const ltpCtx = template === 0 ? 0x0010 : 0x0008;
  let ltp = 0;
  for (let y = 0; y < b.height; y += 1) {
    if (tpgron) {
      let typical = 1;
      for (let x = 0; x < b.width; x += 1) {
        if (uniformNeighbourhood(ref, x, y) && b.data[y * b.width + x] !== getPixel(ref, x, y)) typical = 0;
      }
      enc.encode(cx, ltpCtx, typical ^ ltp);
      ltp = typical;
    }
    for (let x = 0; x < b.width; x += 1) {
      if (ltp && uniformNeighbourhood(ref, x, y)) continue;
      enc.encode(cx, refineContext(b, ref, template, at, x, y, dx, dy), b.data[y * b.width + x]);
    }
  }
  return enc.flush();
}

// ---- integers (T.88 Annex A) -----------------------------------------------------------------------------------

const INT_RANGES = [[0, 2], [4, 4], [20, 6], [84, 8], [340, 12], [4436, 32]];

/** The IAx procedure: `value` null codes OOB. cx is a contexts(512) table shared by all values of one decoder. */
export function encodeInteger(enc, cx, value) {
  let prev = 1;
  const bit = (d) => {
    enc.encode(cx, prev, d);
    prev = prev < 256 ? (prev << 1) | d : (((prev << 1) | d) & 511) | 256;
  };
  const s = value === null || value < 0 ? 1 : 0;
  const v = value === null ? 0 : Math.abs(value);
  bit(s);
  let range = 0;
  while (range + 1 < INT_RANGES.length && v >= INT_RANGES[range + 1][0]) range += 1;
  for (let i = 0; i < range; i += 1) bit(1);
  if (range < INT_RANGES.length - 1) bit(0);
  const [base, bits] = INT_RANGES[range];
  const rest = v - base;
  for (let i = bits - 1; i >= 0; i -= 1) bit(Math.floor(rest / 2 ** i) % 2);
}

/** The IAID procedure for symbol ids of `length` bits; cx is contexts(2 ** length). */
export function encodeIaid(enc, cx, length, value) {
  let prev = 1;
  for (let i = length - 1; i >= 0; i -= 1) {
    const d = (value >> i) & 1;
    enc.encode(cx, prev, d);
    prev = (prev << 1) | d;
  }
}

// ---- CCITT ------------------------------------------------------------------------------------------------------

export class BitWriter {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.n = 0;
  }
  bit(v) {
    this.cur = (this.cur << 1) | v;
    this.n += 1;
    if (this.n === 8) {
      this.bytes.push(this.cur);
      this.cur = 0;
      this.n = 0;
    }
  }
  code(str) {
    for (const ch of str) this.bit(ch === '1' ? 1 : 0);
  }
  align() {
    while (this.n !== 0) this.bit(0);
  }
  finish() {
    this.align();
    return Uint8Array.from(this.bytes);
  }
}

/** { white, black } run code maps from the T.4 code list [[bits, run], ...]. */
export function faxTables(json) {
  const make = (list) => {
    const term = new Map();
    const makeup = new Map();
    for (const [code, run] of list) (run < 64 ? term : makeup).set(run, code);
    return { term, makeup };
  };
  return { white: make(json.white), black: make(json.black) };
}

function writeRun(w, table, run) {
  while (run >= 2560) {
    w.code(table.makeup.get(2560));
    run -= 2560;
  }
  if (run >= 64) {
    w.code(table.makeup.get(run - (run % 64)));
    run %= 64;
  }
  w.code(table.term.get(run));
}

/** One row as 1-D runs. row: Uint8Array of 0/1 (1 = black). */
export function encodeRow1d(w, tables, row) {
  let x = 0;
  let color = 0;
  while (x < row.length) {
    let n = 0;
    while (x + n < row.length && row[x + n] === color) n += 1;
    writeRun(w, color ? tables.black : tables.white, n);
    x += n;
    color ^= 1;
  }
}

const firstOther = (row, from, value) => {
  let x = from;
  while (x < row.length && row[x] === value) x += 1;
  return x;
};

/** One row against its reference row, T.6 two-dimensional coding. */
export function encodeRow2d(w, tables, row, ref) {
  const n = row.length;
  let a0 = -1;
  let color = 0;
  while (a0 < n) {
    const a1 = firstOther(row, Math.max(a0, 0), color);
    let b1 = a0 + 1;
    while (b1 < n && !((b1 === 0 ? 0 : ref[b1 - 1]) !== ref[b1] && ref[b1] !== color)) b1 += 1;
    const b2 = b1 >= n ? n : firstOther(ref, b1, ref[b1]);
    if (b2 < a1) {
      w.code('0001');
      a0 = b2;
    } else if (Math.abs(a1 - b1) <= 3) {
      w.code({ 0: '1', 1: '011', 2: '000011', 3: '0000011', '-1': '010', '-2': '000010', '-3': '0000010' }[a1 - b1]);
      a0 = a1;
      color ^= 1;
    } else {
      const a2 = firstOther(row, a1, color ^ 1);
      w.code('001');
      writeRun(w, color ? tables.black : tables.white, a1 - Math.max(a0, 0));
      writeRun(w, color ? tables.white : tables.black, a2 - a1);
      a0 = a2;
    }
  }
}

/**
 * A whole CCITT stream. opts: k (<0 G4, 0 G3 1-D, >0 G3 2-D with that K), eol (an EOL before every row), align
 * (EncodedByteAlign), eofb (end-of-block codes).
 */
export function encodeCcitt(tables, bm, { k = -1, eol = false, align = false, eofb = true } = {}) {
  const w = new BitWriter();
  let ref = new Uint8Array(bm.width);
  for (let y = 0; y < bm.height; y += 1) {
    const row = bm.data.subarray(y * bm.width, (y + 1) * bm.width);
    if (k < 0) {
      encodeRow2d(w, tables, row, ref);
    } else {
      if (eol) w.code('000000000001');
      if (k === 0) encodeRow1d(w, tables, row);
      else if (y % k === 0) {
        w.bit(1);
        encodeRow1d(w, tables, row);
      } else {
        w.bit(0);
        encodeRow2d(w, tables, row, ref);
      }
    }
    if (align) w.align();
    ref = row;
  }
  if (eofb) {
    if (k < 0) w.code('000000000001000000000001');
    else if (eol) for (let i = 0; i < 6; i += 1) w.code(k > 0 ? '0000000000011' : '000000000001');
  }
  return w.finish();
}

// ---- segments -----------------------------------------------------------------------------------------------------

const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = (v) => [(v >>> 8) & 255, v & 255];
export const s8 = (v) => v & 255;

export function regionInfo(width, height, x, y, op = 0) {
  return [...u32(width), ...u32(height), ...u32(x), ...u32(y), op];
}

export function pageInfo({ width, height, flags = 0, striping = 0 }) {
  return [...u32(width), ...u32(height), ...u32(0), ...u32(0), flags, ...u16(striping)];
}

/** One segment: number, type, referred-to segment numbers, page association, data (array or Uint8Array). */
export function segment({ number, type, refs = [], page = 1, data, length = data.length, longPage = false }) {
  const out = [...u32(number), type | (longPage ? 0x40 : 0)];
  if (refs.length <= 4) out.push(refs.length << 5);
  else {
    out.push(...u32((7 << 29) | refs.length));
    for (let i = 0; i < Math.ceil((refs.length + 1) / 8); i += 1) out.push(0);
  }
  for (const r of refs) {
    if (number <= 256) out.push(r);
    else if (number <= 65536) out.push(...u16(r));
    else out.push(...u32(r));
  }
  if (longPage) out.push(...u32(page));
  else out.push(page);
  out.push(...u32(length));
  return Uint8Array.from([...out, ...data]);
}

export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Generic region segment data. */
export function genericRegionData({ region, template = 0, mmr = false, tpgdon = false, at, payload }) {
  const flags = (mmr ? 1 : 0) | (template << 1) | (tpgdon ? 8 : 0);
  const atBytes = mmr ? [] : (at ?? DEFAULT_AT[template]).map(s8);
  return Uint8Array.from([...region, flags, ...atBytes, ...payload]);
}

export function refinementRegionData({ region, template = 0, tpgron = false, at = DEFAULT_RAT, payload }) {
  return Uint8Array.from([...region, template | (tpgron ? 2 : 0), ...(template === 0 ? at.map(s8) : []), ...payload]);
}


// ---- the reference decoder --------------------------------------------------------------------------------------

const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** Collects what is printed on stdout and stderr (pdf.js reports through the console) until `stop()`. */
function captureOutput() {
  const lines = [];
  const originals = [process.stdout, process.stderr].map((stream) => [stream, stream.write]);
  for (const [stream] of originals) {
    stream.write = (chunk, ...rest) => {
      lines.push(String(chunk));
      const callback = rest.find((r) => typeof r === 'function');
      if (callback) callback();
      return true;
    };
  }
  return {
    lines,
    stop() {
      for (const [stream, write] of originals) stream.write = write;
    },
  };
}

/** The T.4 run codes (white and black terminating, make-up and extended make-up), from the standard's tables. */
const FAX_CODES = JSON.parse(`{"black":[["0000110111",0],["010",1],["11",2],["10",3],["011",4],["0011",5],["0010",6],["00011",7],["000101",8],["000100",9],["0000100",10],["0000101",11],["0000111",12],["00000100",13],["00000111",14],["000011000",15],["0000010111",16],["0000011000",17],["0000001000",18],["00001100111",19],["00001101000",20],["00001101100",21],["00000110111",22],["00000101000",23],["00000010111",24],["00000011000",25],["000011001010",26],["000011001011",27],["000011001100",28],["000011001101",29],["000001101000",30],["000001101001",31],["000001101010",32],["000001101011",33],["000011010010",34],["000011010011",35],["000011010100",36],["000011010101",37],["000011010110",38],["000011010111",39],["000001101100",40],["000001101101",41],["000011011010",42],["000011011011",43],["000001010100",44],["000001010101",45],["000001010110",46],["000001010111",47],["000001100100",48],["000001100101",49],["000001010010",50],["000001010011",51],["000000100100",52],["000000110111",53],["000000111000",54],["000000100111",55],["000000101000",56],["000001011000",57],["000001011001",58],["000000101011",59],["000000101100",60],["000001011010",61],["000001100110",62],["000001100111",63],["0000001111",64],["000011001000",128],["000011001001",192],["000001011011",256],["000000110011",320],["000000110100",384],["000000110101",448],["0000001101100",512],["0000001101101",576],["0000001001010",640],["0000001001011",704],["0000001001100",768],["0000001001101",832],["0000001110010",896],["0000001110011",960],["0000001110100",1024],["0000001110101",1088],["0000001110110",1152],["0000001110111",1216],["0000001010010",1280],["0000001010011",1344],["0000001010100",1408],["0000001010101",1472],["0000001011010",1536],["0000001011011",1600],["0000001100100",1664],["0000001100101",1728],["00000001000",1792],["00000001100",1856],["00000001101",1920],["000000010010",1984],["000000010011",2048],["000000010100",2112],["000000010101",2176],["000000010110",2240],["000000010111",2304],["000000011100",2368],["000000011101",2432],["000000011110",2496],["000000011111",2560]],"white":[["00110101",0],["000111",1],["0111",2],["1000",3],["1011",4],["1100",5],["1110",6],["1111",7],["10011",8],["10100",9],["00111",10],["01000",11],["001000",12],["000011",13],["110100",14],["110101",15],["101010",16],["101011",17],["0100111",18],["0001100",19],["0001000",20],["0010111",21],["0000011",22],["0000100",23],["0101000",24],["0101011",25],["0010011",26],["0100100",27],["0011000",28],["00000010",29],["00000011",30],["00011010",31],["00011011",32],["00010010",33],["00010011",34],["00010100",35],["00010101",36],["00010110",37],["00010111",38],["00101000",39],["00101001",40],["00101010",41],["00101011",42],["00101100",43],["00101101",44],["00000100",45],["00000101",46],["00001010",47],["00001011",48],["01010010",49],["01010011",50],["01010100",51],["01010101",52],["00100100",53],["00100101",54],["01011000",55],["01011001",56],["01011010",57],["01011011",58],["01001010",59],["01001011",60],["00110010",61],["00110011",62],["00110100",63],["11011",64],["10010",128],["010111",192],["0110111",256],["00110110",320],["00110111",384],["01100100",448],["01100101",512],["01101000",576],["01100111",640],["011001100",704],["011001101",768],["011010010",832],["011010011",896],["011010100",960],["011010101",1024],["011010110",1088],["011010111",1152],["011011000",1216],["011011001",1280],["011011010",1344],["011011011",1408],["010011000",1472],["010011001",1536],["010011010",1600],["011000",1664],["010011011",1728],["00000001000",1792],["00000001100",1856],["00000001101",1920],["000000010010",1984],["000000010011",2048],["000000010100",2112],["000000010101",2176],["000000010110",2240],["000000010111",2304],["000000011100",2368],["000000011101",2432],["000000011110",2496],["000000011111",2560]]}`);
const FAX = faxTables(FAX_CODES);

/**
 * The decoder: pdfjs-dist's image_decoders loaded from `tree` (the legacy build the product uses ships the same
 * module), the wasm module handed over as the worker hands it. A warning that the module could not be instantiated
 * (and the asm.js fallback loaded instead) is an error here.
 */
async function loadReference(tree) {
  const root = join(tree, 'node_modules', 'pdfjs-dist');
  const decoders = await import(pathToFileURL(join(root, 'image_decoders', 'pdf.image_decoders.mjs')).href);
  const wasm = readFileSync(join(root, 'wasm', 'jbig2.wasm'));
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const Jbig2 = decoders.Jbig2Image;
  Jbig2.setOptions({ handler: { sendWithPromise: async () => wasm }, useWasm: true, useWorkerFetch: false, wasmUrl: '' });
  const capture = captureOutput();
  const warnings = capture.lines;
  const attempt = async (call) => {
    try {
      const data = await call();
      return { ok: true, hex: hex(data) };
    } catch (error) {
      Jbig2.cleanup();
      return { ok: false, message: String(error.message) };
    }
  };
  const reference = {
    version,
    wasmSha256: createHash('sha256').update(wasm).digest('hex'),
    jbig2: (c) => attempt(() => Jbig2.instance.decode(Uint8Array.from(c.data), c.width, c.height, c.globals ? Uint8Array.from(c.globals) : null)),
    ccitt: (c) =>
      attempt(() =>
        Jbig2.instance.decode(Uint8Array.from(c.data), c.width, c.height, null, {
          K: c.k,
          EndOfLine: c.eol,
          EncodedByteAlign: c.align,
          BlackIs1: c.black,
          Columns: c.columns,
          Rows: c.rows,
        }),
      ),
    restore() {
      capture.stop();
      const fallback = warnings.filter((w) => /instantiateWasm|getJsModule/.test(w));
      if (fallback.length) throw new Error(`the wasm module was not used: ${fallback[0]}`);
    },
  };
  return reference;
}

/** What the product's own Node configuration does with a JBIG2 image: a PDF opened without `wasmUrl`. */
async function productConfiguration(tree) {
  const root = join(tree, 'node_modules', 'pdfjs-dist');
  const pdfjs = await import(pathToFileURL(join(root, 'legacy', 'build', 'pdf.mjs')).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(root, 'legacy', 'build', 'pdf.worker.mjs')).href;
  const [w, h] = [21, 9];
  const picture = scene(w, h, 5, 0.1);
  const stream = concat(
    segment({ number: 0, type: 48, data: pageInfo({ width: w, height: h }) }),
    segment({ number: 1, type: 38, data: genericRegionData({ region: regionInfo(w, h, 0, 0), payload: encodeGeneric(picture) }) }),
  );
  const parts = [];
  let length = 0;
  const add = (b) => {
    const buffer = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    parts.push(buffer);
    length += buffer.length;
  };
  const offsets = [];
  const object = (n, body, data) => {
    offsets[n] = length;
    add(`${n} 0 obj\n${body}`);
    if (data) {
      add('\nstream\n');
      add(Buffer.from(data));
      add('\nendstream');
    }
    add('\nendobj\n');
  };
  add('%PDF-1.5\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
  object(4, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode /Length ${stream.length} >>`, stream);
  const content = 'q 100 0 0 100 0 0 cm /Im0 Do Q';
  object(5, `<< /Length ${content.length} >>`, content);
  const xref = length;
  add('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i += 1) add(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const capture = captureOutput();
  const warnings = capture.lines;
  let decoded;
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(Buffer.concat(parts)),
      disableWorker: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: pdfjs.VerbosityLevel.INFOS,
    });
    const document = await task.promise;
    const page = await document.getPage(1);
    const ops = await page.getOperatorList();
    const at = ops.fnArray.indexOf(pdfjs.OPS.paintImageXObject);
    const image = await new Promise((done) => page.objs.get(ops.argsArray[at][0], done));
    decoded = image !== null && image !== undefined;
    await new Promise((done) => setTimeout(done, 200));
    await task.destroy();
  } finally {
    capture.stop();
  }
  const failure = warnings.find((line) => /Unable to decode image/.test(line));
  return { wasmUrlGiven: false, imageDecoded: decoded, warning: failure ? failure.replace(/"img_p\d+_\d+"/, '"<image>"').trim() : null };
}

// ---- case builders ------------------------------------------------------------------------------------------------

const cases = [];
let nameCounts = new Map();
function add(name, fields) {
  if (nameCounts.has(name)) throw new Error(`case name ${name} is used twice`);
  nameCounts.set(name, true);
  cases.push({ name, ...fields });
}
const jbig2Case = (name, data, width, height, globals = null) => add(name, { kind: 'jbig2', data, width, height, globals });
const ccittCase = (name, data, width, height, o = {}) =>
  add(name, { kind: 'ccitt', data, width, height, k: o.k ?? -1, eol: !!o.eol, align: !!o.align, black: !!o.black, columns: o.columns ?? width, rows: o.rows ?? height });

const page = (w, h, { flags = 0, striping = 0, number = 0 } = {}) => segment({ number, type: 48, data: pageInfo({ width: w, height: h, flags, striping }) });

/** A generic region segment (an immediate one unless `type` says otherwise). */
function region(number, bm, o = {}) {
  const { type = 38, template = 0, tpgdon = false, at, x = 0, y = 0, op = 0, mmr = false, refs = [], pageNumber = 1, unknown = false } = o;
  const payload = mmr ? encodeCcitt(FAX, bm, { k: -1, eofb: o.eofb ?? true }) : encodeGeneric(bm, { template, tpgdon, at });
  const info = regionInfo(bm.width, bm.height, x, y, op);
  let data = genericRegionData({ region: info, template, mmr, tpgdon, at, payload });
  if (unknown) data = concat(data, Uint8Array.from([0, 0, 0, bm.height]));
  return segment({ number, type, refs, page: pageNumber, data, length: unknown ? 0xffffffff : data.length });
}

function refinement(number, bm, ref, o = {}) {
  const { type = 42, template = 0, tpgron = false, at, x = 0, y = 0, op = 4, refs = [] } = o;
  const payload = encodeRefinement(bm, ref, { template, tpgron, at });
  return segment({ number, type, refs, data: refinementRegionData({ region: regionInfo(bm.width, bm.height, x, y, op), template, tpgron, at, payload }) });
}

const crop = (bm, x, y, w, h) => {
  const out = bitmap(w, h);
  for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) out.data[j * w + i] = getPixel(bm, x + i, y + j);
  return out;
};

/** Rows copied from the row above now and then: typical rows for the prediction. */
function withTypicalRows(bm, every = 3) {
  const out = { ...bm, data: Uint8Array.from(bm.data) };
  for (let y = 1; y < bm.height; y += every) for (let x = 0; x < bm.width; x += 1) out.data[y * bm.width + x] = out.data[(y - 1) * bm.width + x];
  return out;
}

const MOVED_AT = {
  0: [-5, -3, 4, -1, -3, -1, 2, -2],
  1: [-4, -2],
  2: [-3, -1],
  3: [-6, 0],
};

function genericCases() {
  const small = scene(37, 21, 7, 0.03);
  const big = withTypicalRows(scene(100, 60, 11, 0.01));
  for (const template of [0, 1, 2, 3]) {
    for (const tpgdon of [false, true]) {
      for (const moved of [false, true]) {
        const at = moved ? MOVED_AT[template] : undefined;
        const label = `generic-t${template}${tpgdon ? '-tpgdon' : ''}${moved ? '-at' : ''}`;
        jbig2Case(`${label}-37x21`, concat(page(37, 21), region(1, small, { template, tpgdon, at })), 37, 21);
        jbig2Case(`${label}-100x60`, concat(page(100, 60), region(1, big, { template, tpgdon, at })), 100, 60);
      }
    }
  }
  jbig2Case('generic-t0-at-in-row-above-left', concat(page(37, 21), region(1, small, { at: [-128, -128, 127, -1, 0, -1, -1, -1] })), 37, 21);
  const tiny = [bitmap(1, 1, 1), bitmap(1, 9, 1), bitmap(9, 1, 1), bitmap(8, 8, 0), bitmap(7, 3, 1), bitmap(33, 2, 1)];
  tiny.forEach((bm, i) => jbig2Case(`generic-solid-${bm.width}x${bm.height}-${i}`, concat(page(bm.width, bm.height), region(1, bm, { tpgdon: i % 2 === 1 })), bm.width, bm.height));
}

function composeCases() {
  const a = scene(16, 6, 11, 0.3);
  const b = scene(16, 6, 12, 0.3);
  for (const op of [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 0x80, 0xff]) {
    jbig2Case(`compose-op-${op}`, concat(page(16, 6), region(1, a), region(2, b, { op })), 16, 6);
  }
  for (const op of [0, 1, 2, 3, 4]) {
    jbig2Case(`compose-black-page-op-${op}`, concat(page(16, 6, { flags: 4 }), region(1, a, { op })), 16, 6);
  }
  jbig2Case('compose-page-flags-other-bits', concat(page(16, 6, { flags: 0x7b }), region(1, a)), 16, 6);
  jbig2Case('compose-black-page-odd-width', concat(page(13, 3, { flags: 4 }), region(1, bitmap(5, 2, 1), { x: 10, y: 1, op: 2 })), 13, 3);
  const s = bitmap(4, 3, 1);
  const place = (name, x, y, w = 10, h = 6) => jbig2Case(`place-${name}`, concat(page(w, h), region(1, s, { x, y })), w, h);
  place('inside', 3, 2);
  place('clipped-right-bottom', 6, 2);
  place('negative', 0xfffffffe, 0xffffffff);
  place('negative-x-only', 0xfffffffd, 1);
  place('beyond', 20, 20);
  place('huge-x', 0x7fffffff, 0);
  place('huge-y', 0, 0x7fffffff);
  place('min-int', 0x80000000, 0x80000000);
  jbig2Case('page-info-smaller-than-pdf', concat(page(5, 3), region(1, s)), 10, 6);
  jbig2Case('page-info-larger-than-pdf', concat(page(20, 12), region(1, s, { x: 8, y: 4 })), 10, 6);
  jbig2Case('page-info-black-smaller-than-pdf', concat(page(5, 3, { flags: 4 }), region(1, s)), 10, 6);
  jbig2Case('page-info-striped-unknown-height', concat(page(10, 0xffffffff, { striping: 0x8010 }), region(1, s), segment({ number: 2, type: 50, data: [0, 0, 0, 5] })), 10, 6);
  jbig2Case('page-info-striped', concat(page(10, 6, { striping: 0x8004 }), region(1, s, { y: 4 }), segment({ number: 2, type: 50, data: [0, 0, 0, 3] })), 10, 6);
  jbig2Case('two-page-infos', concat(page(10, 6, { flags: 4 }), page(10, 6, { number: 1 }), region(2, s, { x: 1, y: 1 })), 10, 6);
  jbig2Case('only-page-info', page(10, 6), 10, 6);
  jbig2Case('only-black-page-info', page(10, 6, { flags: 4 }), 10, 6);
  jbig2Case('no-page-info', region(1, s), 10, 6);
  jbig2Case('region-size-zero', concat(page(10, 6), segment({ number: 1, type: 38, data: genericRegionData({ region: regionInfo(0, 5, 0, 0), payload: [0xff, 0xac] }) })), 10, 6);
  jbig2Case('region-width-65536', concat(page(10, 6), segment({ number: 1, type: 38, data: genericRegionData({ region: regionInfo(65536, 1, 0, 0), payload: [0xff, 0xac] }) })), 10, 6);
  jbig2Case('region-height-70000', concat(page(10, 6), segment({ number: 1, type: 38, data: genericRegionData({ region: regionInfo(1, 70000, 0, 0), payload: [0xff, 0xac] }) })), 10, 6);
  const wide = bitmap(300, 2);
  for (let x = 0; x < 300; x += 7) wide.data[x] = 1;
  jbig2Case('region-wider-than-page', concat(page(40, 2), region(1, wide, { x: 20 })), 40, 2);
}

function structureCases() {
  const s = scene(12, 8, 5, 0.1);
  const base = concat(page(12, 8), region(1, s));
  jbig2Case('structure-base', base, 12, 8);
  jbig2Case('trailing-5-bytes', concat(base, Uint8Array.from([1, 2, 3, 4, 5])), 12, 8);
  jbig2Case('trailing-30-0xff', concat(base, new Uint8Array(30).fill(255)), 12, 8);
  jbig2Case('empty-stream', new Uint8Array(0), 12, 8);
  jbig2Case('three-bytes', Uint8Array.from([1, 2, 3]), 12, 8);
  jbig2Case('end-of-page-then-region', concat(page(12, 8), segment({ number: 1, type: 49, data: [] }), region(2, s)), 12, 8);
  jbig2Case('end-of-file-then-region', concat(page(12, 8), segment({ number: 1, type: 51, data: [] }), region(2, s)), 12, 8);
  jbig2Case('end-of-stripe-then-region', concat(page(12, 8), segment({ number: 1, type: 50, data: [0, 0, 0, 3] }), region(2, s)), 12, 8);
  jbig2Case('profile-segment-skipped', concat(page(12, 8), segment({ number: 1, type: 52, data: [1, 2, 3, 4] }), region(2, s)), 12, 8);
  jbig2Case('extension-segment-skipped', concat(page(12, 8), segment({ number: 1, type: 62, data: [1, 2, 3] }), region(2, s)), 12, 8);
  jbig2Case('unknown-type-skipped', concat(page(12, 8), segment({ number: 1, type: 33, data: [1, 2, 3] }), region(2, s)), 12, 8);
  jbig2Case('unknown-type-63-skipped', concat(page(12, 8), segment({ number: 1, type: 63, data: [] }), region(2, s)), 12, 8);
  jbig2Case('short-page-info-data-length', concat(segment({ number: 0, type: 48, data: [0, 0, 0, 12] }), region(1, s)), 12, 8);
  jbig2Case('file-header-not-stripped', concat(Uint8Array.from([0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a, 1, 0, 0, 0, 1]), base), 12, 8);
  jbig2Case('data-length-too-long', concat(page(12, 8), segment({ number: 1, type: 38, data: genericRegionData({ region: regionInfo(12, 8, 0, 0), payload: encodeGeneric(s) }), length: 5000 })), 12, 8);
  jbig2Case('data-length-too-short', concat(page(12, 8), segment({ number: 1, type: 38, data: genericRegionData({ region: regionInfo(12, 8, 0, 0), payload: encodeGeneric(s) }), length: 20 }), region(2, bitmap(3, 3, 1), { x: 9, y: 5 })), 12, 8);
  jbig2Case('deferred-non-retain-flag', concat(page(12, 8), (() => { const seg = region(1, s); seg[4] |= 0x80; return seg; })()), 12, 8);
  jbig2Case('four-byte-page-association', concat(page(12, 8), segment({ number: 1, type: 38, longPage: true, data: genericRegionData({ region: regionInfo(12, 8, 0, 0), payload: encodeGeneric(s) }) })), 12, 8);
  // header forms
  for (const n of [0, 1, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 64, 65]) {
    jbig2Case(`header-refs-${n}`, concat(page(12, 8), segment({ number: 300, type: 38, refs: Array.from({ length: n }, (_, i) => i + 1), data: genericRegionData({ region: regionInfo(12, 8, 0, 0), payload: encodeGeneric(s) }) })), 12, 8);
  }
  jbig2Case('header-number-70000-refs-2', concat(page(12, 8), segment({ number: 70000, type: 38, refs: [1, 70001], data: genericRegionData({ region: regionInfo(12, 8, 0, 0), payload: encodeGeneric(s) }) })), 12, 8);
  jbig2Case('header-number-256-refs-1', concat(page(12, 8), segment({ number: 256, type: 38, refs: [1], data: genericRegionData({ region: regionInfo(12, 8, 0, 0), payload: encodeGeneric(s) }) })), 12, 8);
  jbig2Case('header-number-257-refs-1', concat(page(12, 8), segment({ number: 257, type: 38, refs: [1], data: genericRegionData({ region: regionInfo(12, 8, 0, 0), payload: encodeGeneric(s) }) })), 12, 8);
  jbig2Case('header-number-65537-refs-1', concat(page(12, 8), segment({ number: 65537, type: 38, refs: [1], data: genericRegionData({ region: regionInfo(12, 8, 0, 0), payload: encodeGeneric(s) }) })), 12, 8);
  jbig2Case('header-cut-short', base.subarray(0, 40), 12, 8);
  jbig2Case('header-cut-in-page-info', base.subarray(0, 20), 12, 8);
  // unknown length regions
  for (const [template, tpgdon] of [[0, false], [1, true], [2, false], [3, false]]) {
    const img = scene(30, 14, 20 + template, 0.05);
    jbig2Case(`unknown-length-t${template}${tpgdon ? '-tpgdon' : ''}`, concat(page(30, 14), region(1, img, { template, tpgdon, unknown: true }), region(2, scene(8, 4, 3, 0), { y: 10, op: 2 })), 30, 14);
  }
  // end of data in unusual places
  const half = region(1, scene(30, 14, 21, 0.05), { unknown: true });
  jbig2Case('unknown-length-truncated', concat(page(30, 14), half.subarray(0, half.length - 9)), 30, 14);
  // globals
  jbig2Case('globals-3-bytes', base, 12, 8, Uint8Array.from([1, 2, 3]));
  jbig2Case('globals-empty', base, 12, 8, new Uint8Array(0));
  jbig2Case('globals-extension-segments', base, 12, 8, concat(segment({ number: 9, type: 62, data: [1, 2, 3, 4] }), segment({ number: 10, type: 62, data: [] })));
  jbig2Case('globals-with-page-info', base, 12, 8, concat(page(12, 8), segment({ number: 9, type: 62, data: [1, 2] })));
  jbig2Case('globals-region-without-page', base, 12, 8, region(7, s));
  jbig2Case('globals-end-of-file', base, 12, 8, concat(segment({ number: 9, type: 51, data: [] }), segment({ number: 10, type: 62, data: [] })));
  jbig2Case('globals-bad-header', base, 12, 8, new Uint8Array(30).fill(255));
  jbig2Case('globals-unallocatable-page', base, 12, 8, concat(segment({ number: 0, type: 48, data: pageInfo({ width: 0, height: 5 }) }), segment({ number: 9, type: 62, data: [] })));
  // image sizes
  const stream = page(8, 1);
  for (const [w, h] of [[1, 1], [8, 1], [1, 8], [0, 5], [5, 0], [0, 0], [-1, 5], [5, -1], [0, -1], [65535, 1], [65536, 1], [1, 65536], [70000, 2], [8192, 262144], [100000, 100000], [2147483647, 1], [1, 2147483647], [33, 3], [31, 3], [32, 3]]) {
    jbig2Case(`size-${w}x${h}`, stream, w, h);
  }
}

function refinementCases() {
  const ref = scene(40, 24, 31, 0.02);
  const near = (seed, rate) => {
    const bm = { ...ref, data: Uint8Array.from(ref.data) };
    const r = rng(seed);
    for (let i = 0; i < bm.data.length * rate; i += 1) bm.data[Math.floor(r() * bm.data.length)] ^= 1;
    return bm;
  };
  const intermediate = region(1, ref, { type: 36, pageNumber: 1 });
  for (const template of [0, 1]) {
    for (const tpgron of [false, true]) {
      for (const moved of [false, true]) {
        if (template === 1 && moved) continue;
        const at = moved ? [-2, -1, -3, -2] : undefined;
        const target = near(40 + template, 0.04);
        jbig2Case(`refine-intermediate-t${template}${tpgron ? '-tpgron' : ''}${moved ? '-at' : ''}`, concat(page(40, 24), intermediate, refinement(2, target, ref, { template, tpgron, at, refs: [1] })), 40, 24);
      }
    }
  }
  // the page as reference, at offsets
  const drawn = concat(page(40, 24), region(1, ref));
  for (const [x, y] of [[0, 0], [3, 2], [30, 10], [0xffffffff, 0xfffffffe], [35, 20], [100, 100]]) {
    const refPart = crop(ref, (x | 0), (y | 0), 12, 9);
    const target = scene(12, 9, 5, 0.2);
    for (const template of [0, 1]) {
      jbig2Case(`refine-page-t${template}-at-${x | 0}-${y | 0}`, concat(drawn, refinement(2, target, refPart, { template, x, y, op: 0 })), 40, 24);
    }
  }
  jbig2Case('refine-page-tpgron', concat(drawn, refinement(2, near(50, 0.03), ref, { tpgron: true })), 40, 24);
  jbig2Case('refine-page-xor', concat(drawn, refinement(2, near(51, 0.1), ref, { op: 2 })), 40, 24);
  jbig2Case('refine-lossless-type-43', concat(drawn, refinement(2, near(52, 0.1), ref, { type: 43 })), 40, 24);
  // chains
  const mid = near(60, 0.05);
  jbig2Case('refine-chain-40-then-42', concat(page(40, 24), intermediate, refinement(2, mid, ref, { type: 40, refs: [1] }), refinement(3, near(61, 0.05), mid, { refs: [2] })), 40, 24);
  jbig2Case('refine-reference-smaller', concat(page(40, 24), region(1, crop(ref, 0, 0, 20, 12), { type: 36 }), refinement(2, near(62, 0.05), crop(ref, 0, 0, 20, 12), { refs: [1] })), 40, 24);
  jbig2Case('refine-region-smaller-than-reference', concat(page(40, 24), intermediate, refinement(2, crop(near(63, 0.05), 0, 0, 30, 20), ref, { refs: [1] })), 40, 24);
  // failures
  jbig2Case('refine-missing-reference', concat(drawn, refinement(2, near(64, 0.05), ref, { refs: [9] })), 40, 24);
  jbig2Case('refine-reference-wrong-type', concat(drawn, refinement(2, near(65, 0.05), ref, { refs: [1] })), 40, 24);
  jbig2Case('refine-width-zero', concat(drawn, segment({ number: 2, type: 42, data: refinementRegionData({ region: regionInfo(0, 5, 0, 0, 4), payload: [0xff, 0xac] }) })), 40, 24);
  jbig2Case('refine-width-70000', concat(drawn, segment({ number: 2, type: 42, data: refinementRegionData({ region: regionInfo(70000, 2, 0, 0, 4), payload: [0xff, 0xac] }) })), 40, 24);
  jbig2Case('refine-before-page', refinement(2, near(66, 0.05), ref), 40, 24);
  jbig2Case('refine-second-referred-is-usable', concat(page(40, 24), intermediate, refinement(2, near(67, 0.05), ref, { refs: [1, 1] })), 40, 24);
}

function mmrCases() {
  for (const [w, h, seed] of [[1, 1, 1], [8, 8, 2], [23, 11, 21], [64, 40, 3], [100, 7, 4], [9, 33, 5], [1728, 5, 6]]) {
    const bm = scene(w, h, seed, 0.05);
    for (const eofb of [true, false]) {
      jbig2Case(`mmr-${w}x${h}${eofb ? '' : '-no-eofb'}`, concat(page(w, h), region(1, bm, { mmr: true, eofb })), w, h);
    }
  }
  const a = scene(30, 10, 8, 0.1);
  const b = scene(30, 10, 9, 0.1);
  jbig2Case('mmr-two-regions-xor', concat(page(30, 10), region(1, a, { mmr: true }), region(2, b, { mmr: true, op: 2 })), 30, 10);
  jbig2Case('mmr-then-arithmetic', concat(page(30, 10), region(1, a, { mmr: true }), region(2, b, { op: 1 })), 30, 10);
  jbig2Case('mmr-at-offset-clipped', concat(page(20, 8), region(1, a, { mmr: true, x: 10, y: 3 })), 20, 8);
  jbig2Case('mmr-intermediate-then-refine', concat(page(30, 10), region(1, a, { mmr: true, type: 36 }), refinement(2, b, a, { refs: [1] })), 30, 10);
  const full = concat(page(30, 10), region(1, a, { mmr: true }));
  for (const cut of [1, 2, 4, 7, 12, 25]) jbig2Case(`mmr-cut-${cut}`, full.subarray(0, full.length - cut), 30, 10);
}

/** Streams cut off at several places: the regions decode as far as the data goes. */
function truncationCases() {
  const img = withTypicalRows(scene(37, 21, 77, 0.03));
  const cuts = [1, 2, 3, 4, 6, 9, 14, 22];
  for (const template of [0, 1, 2, 3]) {
    for (const moved of [false, true]) {
      const at = moved ? MOVED_AT[template] : undefined;
      for (const tpgdon of template === 0 || template === 2 ? [false, true] : [false]) {
        const full = concat(page(37, 21), region(1, img, { template, tpgdon, at }));
        for (const cut of cuts) {
          jbig2Case(`cut-t${template}${tpgdon ? '-tpgdon' : ''}${moved ? '-at' : ''}-${cut}`, full.subarray(0, full.length - cut), 37, 21);
        }
      }
    }
  }
  const black = concat(page(37, 21, { flags: 4 }), region(1, img, { op: 4 }));
  for (const cut of [2, 5, 9]) jbig2Case(`cut-replace-on-black-${cut}`, black.subarray(0, black.length - cut), 37, 21);
  const target = scene(37, 21, 78, 0.1);
  for (const template of [0, 1]) {
    const full = concat(page(37, 21), region(1, img, { type: 36 }), refinement(2, target, img, { template, refs: [1] }));
    for (const cut of [1, 3, 6, 10, 20]) jbig2Case(`cut-refine-t${template}-${cut}`, full.subarray(0, full.length - cut), 37, 21);
  }
  const intermediateCut = concat(page(37, 21), region(1, img, { type: 36 }));
  for (const cut of [3, 8]) jbig2Case(`cut-intermediate-${cut}`, concat(intermediateCut.subarray(0, intermediateCut.length - cut), segment({ number: 2, type: 42, refs: [1], data: refinementRegionData({ region: regionInfo(37, 21, 0, 0, 4), payload: encodeRefinement(target, img) }) })), 37, 21);
}

/** Valid streams with bytes changed in the region data (flags, adaptive pixels, coded data): damaged data. */
function damagedCases() {
  const r = rng(2024);
  const img = withTypicalRows(scene(37, 21, 91, 0.03));
  const pageLength = page(37, 21).length;
  const bases = [];
  const base = (label, bytes, from, to) => bases.push([label, bytes, from, to]);
  for (const template of [0, 1, 2, 3]) {
    const first = region(1, img, { template });
    base(`t${template}`, concat(page(37, 21), first), pageLength + 11 + 17, pageLength + first.length);
  }
  const typical = region(1, img, { tpgdon: true });
  base('tpgdon', concat(page(37, 21), typical), pageLength + 11 + 17, pageLength + typical.length);
  const mmr = region(1, img, { mmr: true });
  base('mmr', concat(page(37, 21), mmr), pageLength + 11 + 17, pageLength + mmr.length);
  const unknown = region(1, img, { unknown: true });
  base('unknown', concat(page(37, 21), unknown), pageLength + 11 + 17, pageLength + unknown.length);
  const intermediate = region(1, img, { type: 36 });
  const refined = refinement(2, scene(37, 21, 92, 0.1), img, { refs: [1] });
  base('refine', concat(page(37, 21), intermediate, refined), pageLength + intermediate.length + 12 + 17, pageLength + intermediate.length + refined.length);
  for (const [label, bytes, from, to] of bases) {
    for (let i = 0; i < 6; i += 1) {
      const copy = Uint8Array.from(bytes);
      const edits = 1 + Math.floor(r() * 3);
      for (let e = 0; e < edits; e += 1) {
        const at = from + Math.floor(r() * (to - from));
        copy[at] = Math.floor(r() * 256);
      }
      jbig2Case(`damaged-${label}-${i}`, copy, 37, 21);
    }
  }
}

function ccittCases() {
  const shapes = [[1, 5], [7, 6], [8, 4], [9, 7], [31, 5], [32, 5], [33, 5], [64, 12], [100, 9], [1728, 6], [2600, 3]];
  shapes.forEach(([w, h], i) => {
    const bm = scene(w, h, 300 + i, 0.05);
    for (const k of [-1, 0, 4]) {
      ccittCase(`ccitt-${w}x${h}-k${k}`, encodeCcitt(FAX, bm, { k }), w, h, { k });
      ccittCase(`ccitt-${w}x${h}-k${k}-black`, encodeCcitt(FAX, bm, { k }), w, h, { k, black: true });
    }
  });
  const bm = scene(33, 7, 401, 0.1);
  for (const k of [-1, 0, 1, 3]) {
    for (const eol of [false, true]) {
      for (const align of [false, true]) {
        for (const eofb of [true, false]) {
          for (const black of [false, true]) {
            ccittCase(`ccitt-options-k${k}${eol ? '-eol' : ''}${align ? '-align' : ''}${eofb ? '-eofb' : ''}${black ? '-black' : ''}`, encodeCcitt(FAX, bm, { k, eol, align, eofb }), 33, 7, { k, eol, align, black });
          }
        }
      }
    }
  }
  // parameters that disagree with the stream
  const stream = encodeCcitt(FAX, scene(40, 10, 402, 0.1), { k: -1 });
  const pars = (name, w, h, o) => ccittCase(`ccitt-params-${name}`, stream, w, h, o);
  pars('same', 40, 10, {});
  pars('columns-smaller', 40, 10, { columns: 33 });
  pars('columns-larger', 40, 10, { columns: 48 });
  pars('columns-zero', 40, 10, { columns: 0 });
  pars('columns-70000', 40, 10, { columns: 70000 });
  pars('columns-65535', 5, 3, { columns: 65535 });
  pars('columns-65536', 5, 3, { columns: 65536 });
  pars('columns-negative', 40, 10, { columns: -1 });
  pars('rows-smaller', 40, 10, { rows: 3 });
  pars('rows-larger', 40, 10, { rows: 70 });
  pars('rows-zero', 40, 10, { rows: 0 });
  pars('rows-70000', 40, 10, { rows: 70000 });
  pars('rows-negative', 40, 10, { rows: -1 });
  pars('height-larger', 40, 25, { rows: 0 });
  pars('height-larger-than-rows', 40, 25, { rows: 10 });
  pars('height-65536-with-rows', 8, 65536, { rows: 10, columns: 8 });
  pars('height-70000-without-rows', 40, 70000, { rows: 0 });
  pars('height-zero', 40, 0, { rows: 0 });
  pars('height-zero-with-rows', 40, 0, { rows: 10 });
  pars('height-negative', 40, -1, {});
  pars('height-negative-with-rows', 40, -1, { rows: 10 });
  pars('width-zero', 0, 10, { columns: 40 });
  pars('width-zero-columns-zero', 0, 10, { columns: 0 });
  pars('width-negative', -1, 10, {});
  pars('width-negative-with-columns', -1, 10, { columns: 40 });
  pars('width-negative-7-with-columns', -7, 10, { columns: 40 });
  pars('width-wider-than-columns-by-bytes', 48, 4, { columns: 40 });
  pars('width-narrower', 20, 10, { columns: 40 });
  pars('width-17', 17, 10, { columns: 17 });
  pars('k-large', 40, 10, { k: 2147483647 });
  pars('k-very-negative', 40, 10, { k: -2147483648 });
  // every run length, white and black, in 1-D and 2-D
  const runs = [];
  for (let n = 1; n <= 70; n += 1) runs.push(n);
  for (const n of [127, 128, 129, 191, 192, 193, 255, 256, 320, 448, 576, 640, 704, 1000, 1727, 1728, 1729, 1791, 1792, 1793, 1856, 1920, 1984, 2047, 2048, 2111, 2112, 2176, 2240, 2304, 2368, 2432, 2496, 2559, 2560, 2561, 2623, 2624, 2688]) runs.push(n);
  const widthRuns = 2700;
  const white = bitmap(widthRuns, runs.length);
  const black = bitmap(widthRuns, runs.length);
  runs.forEach((n, y) => {
    for (let x = 0; x < widthRuns; x += 1) {
      white.data[y * widthRuns + x] = x >= n && x < n + 9 ? 1 : 0; // a white run of n, then 9 black
      black.data[y * widthRuns + x] = x < n ? 1 : x >= n + 5 && x < n + 6 ? 1 : 0; // a black run of n
    }
  });
  ccittCase('ccitt-runs-white-1d', encodeCcitt(FAX, white, { k: 0 }), widthRuns, runs.length, { k: 0 });
  ccittCase('ccitt-runs-black-1d', encodeCcitt(FAX, black, { k: 0 }), widthRuns, runs.length, { k: 0 });
  ccittCase('ccitt-runs-black-g4', encodeCcitt(FAX, black, { k: -1 }), widthRuns, runs.length, { k: -1 });
  ccittCase('ccitt-runs-white-g4', encodeCcitt(FAX, white, { k: -1 }), widthRuns, runs.length, { k: -1 });
  // structure of rows that exercise the 2-D modes
  const modes = bitmap(64, 8);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 64; x += 1) modes.data[y * 64 + x] = ((x * (y + 3) + y * y) >> 2) % 3 === 0 ? 1 : 0;
  ccittCase('ccitt-modes-g4', encodeCcitt(FAX, modes, { k: -1 }), 64, 8, { k: -1 });
  ccittCase('ccitt-all-white-g4', encodeCcitt(FAX, bitmap(40, 6, 0), { k: -1 }), 40, 6, { k: -1 });
  ccittCase('ccitt-all-black-g4', encodeCcitt(FAX, bitmap(40, 6, 1), { k: -1 }), 40, 6, { k: -1 });
  ccittCase('ccitt-all-black-1d', encodeCcitt(FAX, bitmap(40, 6, 1), { k: 0 }), 40, 6, { k: 0 });
  ccittCase('ccitt-empty-data', new Uint8Array(0), 16, 4);
  ccittCase('ccitt-one-byte', Uint8Array.from([0x80]), 16, 4);
  ccittCase('ccitt-extension-code', Uint8Array.from([0b0000_0011, 0b1100_0000, 0x80]), 16, 3);
  ccittCase('ccitt-eol-only', Uint8Array.from([0, 1, 0, 1, 0, 1]), 16, 3);
  // truncated streams
  for (const k of [-1, 0, 4]) {
    const full = encodeCcitt(FAX, scene(40, 10, 403 + k, 0.1), { k, eofb: false });
    for (const cut of [1, 2, 3, 4, 6, 9, 15]) ccittCase(`ccitt-cut-k${k}-${cut}`, full.subarray(0, Math.max(0, full.length - cut)), 40, 10, { k });
  }
  // random bytes
  const r = rng(515);
  for (let i = 0; i < 48; i += 1) {
    const len = 1 + Math.floor(r() * 70);
    const data = Uint8Array.from({ length: len }, () => Math.floor(r() * 256));
    const k = [-1, 0, 2][Math.floor(r() * 3)];
    ccittCase(`ccitt-random-${i}`, data, 1 + Math.floor(r() * 90), 1 + Math.floor(r() * 12), { k, eol: r() < 0.3, align: r() < 0.3, black: r() < 0.3 });
  }
  // valid streams with bytes changed
  const valid = encodeCcitt(FAX, scene(50, 12, 404, 0.08), { k: -1 });
  const valid1d = encodeCcitt(FAX, scene(50, 12, 405, 0.08), { k: 0 });
  for (let i = 0; i < 24; i += 1) {
    const source = i % 2 ? valid1d : valid;
    const copy = Uint8Array.from(source);
    for (let e = 0; e < 1 + Math.floor(r() * 3); e += 1) copy[Math.floor(r() * copy.length)] = Math.floor(r() * 256);
    ccittCase(`ccitt-damaged-${i}`, copy, 50, 12, { k: i % 2 ? 0 : -1 });
  }
}

/** The integers and symbol ids the arithmetic decoder tests decode, written with the IAx and IAID encoders. */
function arithmeticVectors() {
  const values = [0, 1, -1, 2, 3, -3, 4, 5, 19, 20, 21, 83, 84, 85, -84, 339, 340, -340, 4435, 4436, 4437, -5000, 70000, null, 0, 7, null, -2];
  const enc = new MqEncoder();
  const cx = contexts(512);
  for (const v of values) encodeInteger(enc, cx, v);
  const ids = [0, 31, 5, 5, 17, 2, 30, 1, 0, 9];
  const idEnc = new MqEncoder();
  const idCx = contexts(32);
  for (const v of ids) encodeIaid(idEnc, idCx, 5, v);
  return [
    `integers ${hex(enc.flush())} ${values.map((v) => (v === null ? 'oob' : v)).join(',')}`,
    `ids 5 ${hex(idEnc.flush())} ${ids.join(',')}`,
  ].join('\n');
}

function buildCases() {
  cases.length = 0;
  nameCounts = new Map();
  genericCases();
  composeCases();
  structureCases();
  refinementCases();
  mmrCases();
  truncationCases();
  damagedCases();
  ccittCases();
  return cases;
}

// ---- the recording ------------------------------------------------------------------------------------------------

const bit = (v) => (v ? 1 : 0);

function renderCase(c, expected) {
  const lines = [`case ${c.name}`, `kind ${c.kind}`, `width ${c.width}`, `height ${c.height}`];
  if (c.kind === 'ccitt') lines.push(`k ${c.k}`, `eol ${bit(c.eol)}`, `align ${bit(c.align)}`, `black ${bit(c.black)}`, `columns ${c.columns}`, `rows ${c.rows}`);
  lines.push(`data ${hex(c.data)}`);
  if (c.globals) lines.push(`globals ${hex(c.globals)}`);
  lines.push(expected.ok ? `ok ${expected.hex}` : `error ${expected.message}`);
  return lines.join('\n');
}

/** Pixels the clean streams must decode to: 0 = black, rows of whole bytes, padding bits 1. */
const packWhite1 = (b) => {
  const pitch = (b.width + 7) >> 3;
  const out = new Uint8Array(pitch * b.height).fill(0xff);
  for (let y = 0; y < b.height; y += 1) for (let x = 0; x < b.width; x += 1) if (b.data[y * b.width + x]) out[y * pitch + (x >> 3)] &= ~(0x80 >> (x & 7));
  return out;
};

async function main() {
  const { FIXTURES_ROOT, commitStage, parseArgs, productIdentity, resolveTree, stageSet, writeSetManifest } = await import('./lib/common.mjs');
  const { recorderProvenance } = await import('./lib/provenance.mjs');
  const args = parseArgs();
  const tree = resolveTree(args);
  const identity = productIdentity(tree);
  const reference = await loadReference(tree);
  const built = buildCases();
  const results = [];
  for (const c of built) results.push(c.kind === 'ccitt' ? await reference.ccitt(c) : await reference.jbig2(c));
  reference.restore();
  // the encoders are checked against the decoder: the clean streams decode to the picture they encode
  const clean = [
    ['generic-t0-37x21', scene(37, 21, 7, 0.03)],
    ['mmr-23x11', scene(23, 11, 21, 0.05)],
  ];
  for (const [name, picture] of clean) {
    const at = built.findIndex((c) => c.name === name);
    if (at < 0 || !results[at].ok || results[at].hex !== hex(packWhite1(picture))) throw new Error(`${name} does not decode to the picture it encodes`);
  }
  const wrong = built.filter((c, i) => /^(generic-t|mmr-\d|compose-op|refine-intermediate|ccitt-\d)/.test(c.name) && !results[i].ok);
  if (wrong.length) throw new Error(`the decoder refused clean streams: ${wrong.slice(0, 5).map((c) => c.name).join(', ')}`);
  const product = await productConfiguration(tree);
  const finalDir = join(FIXTURES_ROOT, SET);
  const stage = stageSet(finalDir, null);
  mkdirSync(stage, { recursive: true });
  const vectors = arithmeticVectors();
  const text = `${built.map((c, i) => renderCase(c, results[i])).join('\n\n')}\n`;
  writeFileSync(join(stage, 'cases.txt'), text);
  writeFileSync(join(stage, 'arith-vectors.txt'), `${vectors}\n`);
  const outcomes = { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  writeSetManifest(stage, {
    set: SET,
    recorder: RECORDER,
    command: `node ${RECORDER} --tree <Node product tree with node_modules>`,
    extra: {
      cases: built.length,
      outcomes,
      failureMessages: [...new Set(results.filter((r) => !r.ok).map((r) => r.message))].sort(),
      reference: { pdfjsDist: reference.version, module: 'wasm/jbig2.wasm', sha256: reference.wasmSha256, suppliedBy: 'Jbig2Image.setOptions({ handler, useWasm: true, useWorkerFetch: false })' },
      productConfiguration: product,
      ...recorderProvenance(import.meta.url),
    },
    identity,
  });
  commitStage(stage, finalDir);
  console.log(`recorded ${SET}: ${built.length} cases (${outcomes.ok} decoded, ${outcomes.failed} failed), cases.txt`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
