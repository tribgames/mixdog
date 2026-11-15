#!/usr/bin/env node
// JBIG2 symbol, text, table, pattern and halftone goldens (track nr-office, task nr-office-pdf-jbig2-symbols): what
// pdf.js 6.4.299's jbig2.wasm (PDFium's fxcodec JBIG2 decoder) makes of streams this script writes, in the way
// `record-office-jbig2.mjs` records the generic part (it uses that recorder's encoders and its way of loading the wasm
// decoder). Writes native/core/fixtures/office-jbig2-symbols/{cases.txt,MANIFEST.json} of the checkout this script is in.
//
//   node native/core/crates/mixdog-pdf/tests/record_jbig2_symbols.mjs --tree <tree with node_modules> [--recorders <dir>]
//
// Streams: symbol dictionaries (arithmetic with every template, Huffman with every standard table choice, refinement and
// aggregation, retained contexts, exports), text regions (arithmetic and Huffman, every reference corner, transposed,
// strips, offsets, refinement, every combination operator), custom Huffman tables, pattern dictionaries and halftone
// regions (arithmetic, skip, every combination operator, grid vectors), globals, intermediate regions, and
// damaged or random payloads behind valid headers for every one of these. A stream the decoder fails with anything but
// its own error ("Unknown error") is not kept: such a failure is a trap of the wasm module, not behaviour to copy.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const SET = 'office-jbig2-symbols';
const RECORDER = 'native/core/crates/mixdog-pdf/tests/record_jbig2_symbols.mjs';

const argv = process.argv.slice(2);
const arg = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const tree = resolve(arg('tree') ?? REPO_ROOT);
const recorders = resolve(arg('recorders') ?? join(REPO_ROOT, 'benchmarks', 'rust-core', 'recorders'));
const base = await import(pathToFileURL(join(recorders, 'record-office-jbig2.mjs')).href);
const { bitmap, getPixel, rng, scene, MqEncoder, contexts, DEFAULT_AT, DEFAULT_RAT, encodeInteger, encodeIaid, BitWriter, regionInfo, pageInfo, segment, concat, s8 } = base;

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = (v) => [(v >>> 8) & 255, v & 255];

// ---- the reference decoder (as record-office-jbig2.mjs loads it) -----------------------------------------------------

async function loadReference() {
  const root = join(tree, 'node_modules', 'pdfjs-dist');
  const decoders = await import(pathToFileURL(join(root, 'image_decoders', 'pdf.image_decoders.mjs')).href);
  const wasm = readFileSync(join(root, 'wasm', 'jbig2.wasm'));
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const Jbig2 = decoders.Jbig2Image;
  Jbig2.setOptions({ handler: { sendWithPromise: async () => wasm }, useWasm: true, useWorkerFetch: false, wasmUrl: '' });
  const decode = async (c) => {
    try {
      const data = await Jbig2.instance.decode(Uint8Array.from(c.data), c.width, c.height, c.globals ? Uint8Array.from(c.globals) : null);
      return { ok: true, hex: hex(data) };
    } catch (error) {
      Jbig2.cleanup();
      return { ok: false, message: String(error.message) };
    }
  };
  return { version, wasmSha256: createHash('sha256').update(wasm).digest('hex'), decode };
}

// ---- encoders ------------------------------------------------------------------------------------------------------

const GB_BITS = [16, 13, 10, 10];

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

/** A generic region into a running encoder with shared contexts (no typical prediction). */
function encodeGenericInto(enc, cx, b, { template = 0, at = DEFAULT_AT[template], skip = null } = {}) {
  for (let y = 0; y < b.height; y += 1) {
    for (let x = 0; x < b.width; x += 1) {
      if (skip && getPixel(skip, x, y)) continue;
      enc.encode(cx, genericContext(b, template, at, x, y), b.data[y * b.width + x]);
    }
  }
}

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

function encodeRefinementInto(enc, cx, b, ref, { template = 0, at = DEFAULT_RAT, dx = 0, dy = 0 } = {}) {
  for (let y = 0; y < b.height; y += 1) {
    for (let x = 0; x < b.width; x += 1) enc.encode(cx, refineContext(b, ref, template, at, x, y, dx, dy), b.data[y * b.width + x]);
  }
}

const crop = (bm, x, y, w, h) => {
  const out = bitmap(w, h);
  for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) out.data[j * w + i] = getPixel(bm, x + i, y + j);
  return out;
};

/** A glyph-like bitmap: a blob with some holes. */
const glyph = (w, h, seed) => {
  const r = rng(seed);
  const b = bitmap(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      b.data[y * w + x] = r() < (edge ? 0.35 : 0.6) ? 1 : 0;
    }
  }
  return b;
};

/** A copy of a bitmap with a few pixels flipped, and a size changed by (dw, dh). */
const variant = (b, dw, dh, seed) => {
  const r = rng(seed);
  const out = bitmap(b.width + dw, b.height + dh);
  for (let y = 0; y < out.height; y += 1) {
    for (let x = 0; x < out.width; x += 1) out.data[y * out.width + x] = r() < 0.08 ? 1 - getPixel(b, x, y) : getPixel(b, x, y);
  }
  return out;
};

// ---- Huffman encoding with the standard tables (T.88 Annex B): [low, prefix length, range length, code, kind] -------

const STD = {
  1: [[0, 1, 4, 0x0], [16, 2, 8, 0x2], [272, 3, 16, 0x6], [65808, 3, 32, 0x7, 'u']],
  2: [[0, 1, 0, 0x0], [1, 2, 0, 0x2], [2, 3, 0, 0x6], [3, 4, 3, 0xe], [11, 5, 6, 0x1e], [75, 6, 32, 0x3e, 'u'], [0, 6, 0, 0x3f, 'o']],
  3: [[-256, 8, 8, 0xfe], [0, 1, 0, 0x0], [1, 2, 0, 0x2], [2, 3, 0, 0x6], [3, 4, 3, 0xe], [11, 5, 6, 0x1e], [-257, 8, 32, 0xff, 'l'], [75, 7, 32, 0x7e, 'u'], [0, 6, 0, 0x3e, 'o']],
  4: [[1, 1, 0, 0x0], [2, 2, 0, 0x2], [3, 3, 0, 0x6], [4, 4, 3, 0xe], [12, 5, 6, 0x1e], [76, 5, 32, 0x1f, 'u']],
  5: [[-255, 7, 8, 0x7e], [1, 1, 0, 0x0], [2, 2, 0, 0x2], [3, 3, 0, 0x6], [4, 4, 3, 0xe], [12, 5, 6, 0x1e], [-256, 7, 32, 0x7f, 'l'], [76, 6, 32, 0x3e, 'u']],
  6: [[-2048, 5, 10, 0x1c], [-1024, 4, 9, 0x8], [-512, 4, 8, 0x9], [-256, 4, 7, 0xa], [-128, 5, 6, 0x1d], [-64, 5, 5, 0x1e], [-32, 4, 5, 0xb], [0, 2, 7, 0x0], [128, 3, 7, 0x2], [256, 3, 8, 0x3], [512, 4, 9, 0xc], [1024, 4, 10, 0xd], [-2049, 6, 32, 0x3e, 'l'], [2048, 6, 32, 0x3f, 'u']],
  7: [[-1024, 4, 9, 0x8], [-512, 3, 8, 0x0], [-256, 4, 7, 0x9], [-128, 5, 6, 0x1a], [-64, 5, 5, 0x1b], [-32, 4, 5, 0xa], [0, 4, 5, 0xb], [32, 5, 5, 0x1c], [64, 5, 6, 0x1d], [128, 4, 7, 0xc], [256, 3, 8, 0x1], [512, 3, 9, 0x2], [1024, 3, 10, 0x3], [-1025, 5, 32, 0x1e, 'l'], [2048, 5, 32, 0x1f, 'u']],
  8: [[-15, 8, 3, 0xfc], [-7, 9, 1, 0x1fc], [-5, 8, 1, 0xfd], [-3, 9, 0, 0x1fd], [-2, 7, 0, 0x7c], [-1, 4, 0, 0xa], [0, 2, 1, 0x0], [2, 5, 0, 0x1a], [3, 6, 0, 0x3a], [4, 3, 4, 0x4], [20, 6, 1, 0x3b], [22, 4, 4, 0xb], [38, 4, 5, 0xc], [70, 5, 6, 0x1b], [134, 5, 7, 0x1c], [262, 6, 7, 0x3c], [390, 7, 8, 0x7d], [646, 6, 10, 0x3d], [-16, 9, 32, 0x1fe, 'l'], [1670, 9, 32, 0x1ff, 'u'], [0, 2, 0, 0x1, 'o']],
  11: [[1, 1, 0, 0x0], [2, 2, 1, 0x2], [4, 4, 0, 0xc], [5, 4, 1, 0xd], [7, 5, 1, 0x1c], [9, 5, 2, 0x1d], [13, 6, 2, 0x3c], [17, 7, 2, 0x7a], [21, 7, 3, 0x7b], [29, 7, 4, 0x7c], [45, 7, 5, 0x7d], [77, 7, 6, 0x7e], [141, 7, 32, 0x7f, 'u']],
  14: [[-2, 3, 0, 0x4], [-1, 3, 0, 0x5], [0, 1, 0, 0x0], [1, 3, 0, 0x6], [2, 3, 0, 0x7]],
  9:[[-31,8,4,0xfc],[-15,9,2,0x1fc],[-11,8,2,0xfd],[-7,9,1,0x1fd],[-5,7,1,0x7c],[-3,4,1,0xa],[-1,3,1,0x2],[1,3,1,0x3],[3,5,1,0x1a],[5,6,1,0x3a],[7,3,5,0x4],[39,6,2,0x3b],[43,4,5,0xb],[75,4,6,0xc],[139,5,7,0x1b],[267,5,8,0x1c],[523,6,8,0x3c],[779,7,9,0x7d],[1291,6,11,0x3d],[-32,9,32,0x1fe,'l'],[3339,9,32,0x1ff,'u'],[0,2,0,0x0,'o']],
  10:[[-21,7,4,0x7a],[-5,8,0,0xfc],[-4,7,0,0x7b],[-3,5,0,0x18],[-2,2,2,0x0],[2,5,0,0x19],[3,6,0,0x36],[4,7,0,0x7c],[5,8,0,0xfd],[6,2,6,0x1],[70,5,5,0x1a],[102,6,5,0x37],[134,6,6,0x38],[198,6,7,0x39],[326,6,8,0x3a],[582,6,9,0x3b],[1094,6,10,0x3c],[2118,7,11,0x7d],[-22,8,32,0xfe,'l'],[4166,8,32,0xff,'u'],[0,2,0,0x2,'o']],
  12:[[1,1,0,0x0],[2,2,0,0x2],[3,3,1,0x6],[5,5,0,0x1c],[6,5,1,0x1d],[8,6,1,0x3c],[10,7,0,0x7a],[11,7,1,0x7b],[13,7,2,0x7c],[17,7,3,0x7d],[25,7,4,0x7e],[41,8,5,0xfe],[73,8,32,0xff,'u']],
  13:[[1,1,0,0x0],[2,3,0,0x4],[3,4,0,0xc],[4,5,0,0x1c],[5,4,1,0xd],[7,3,3,0x5],[15,6,1,0x3a],[17,6,2,0x3b],[21,6,3,0x3c],[29,6,4,0x3d],[45,6,5,0x3e],[77,7,6,0x7e],[141,7,32,0x7f,'u']],
  15: [[-24, 7, 4, 0x7c], [-8, 6, 2, 0x3c], [-4, 5, 1, 0x1c], [-2, 4, 0, 0xc], [-1, 3, 0, 0x4], [0, 1, 0, 0x0], [1, 3, 0, 0x5], [2, 4, 0, 0xd], [3, 5, 1, 0x1d], [5, 6, 2, 0x3d], [9, 7, 4, 0x7d], [-25, 7, 32, 0x7e, 'l'], [25, 7, 32, 0x7f, 'u']],
};

function putBits(bw, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bw.bit(Math.floor(value / 2 ** i) % 2);
}

/** `value` (null = out of band) in standard table B.`table`. */
function huffPut(bw, table, value) {
  const lines = STD[table];
  const emit = (line, offset) => {
    putBits(bw, line[3], line[1]);
    putBits(bw, offset, line[2]);
  };
  if (value === null) return emit(lines.find((l) => l[4] === 'o'), 0);
  const normal = lines.filter((l) => !l[4]);
  for (const line of normal) {
    if (value >= line[0] && value < line[0] + 2 ** line[2]) return emit(line, value - line[0]);
  }
  const lower = lines.find((l) => l[4] === 'l');
  if (lower && value <= lower[0]) return emit(lower, lower[0] - value);
  const upper = lines.find((l) => l[4] === 'u');
  return emit(upper, value - upper[0]);
}

// ---- segment data --------------------------------------------------------------------------------------------------

const bytesOf = (...parts) => Uint8Array.from(parts.flatMap((part) => (typeof part === 'number' ? [part] : Array.from(part))));

/** A symbol dictionary coded arithmetically from `symbols` sorted by height. Returns the segment data and its contexts. */
function symbolDictArith({ symbols, template = 0, at, numIn = 0, retain = false, useContexts = false, gb = null }) {
  const atBytes = (at ?? DEFAULT_AT[template]).map(s8);
  const enc = new MqEncoder();
  const iadh = contexts(512);
  const iadw = contexts(512);
  const iaex = contexts(512);
  const cx = gb ?? contexts(1 << GB_BITS[template]);
  let height = 0;
  let i = 0;
  while (i < symbols.length) {
    const h = symbols[i].height;
    encodeInteger(enc, iadh, h - height);
    height = h;
    let width = 0;
    while (i < symbols.length && symbols[i].height === h) {
      encodeInteger(enc, iadw, symbols[i].width - width);
      width = symbols[i].width;
      encodeGenericInto(enc, cx, symbols[i], { template, at });
      i += 1;
    }
    encodeInteger(enc, iadw, null);
  }
  encodeInteger(enc, iaex, 0);
  encodeInteger(enc, iaex, numIn + symbols.length);
  const flags = (template << 10) | (useContexts ? 0x100 : 0) | (retain ? 0x200 : 0);
  const data = bytesOf(u16(flags), atBytes, u32(numIn + symbols.length), u32(symbols.length), enc.flush());
  return { data, gb: cx };
}

/** A custom table of one range of 16 bits (0 to 65535) with an out-of-band value: prefix lengths 1, 3, 3 and 2. */
const customPut = (bw, value) => {
  if (value === null) return putBits(bw, 2, 2);
  bw.bit(0);
  putBits(bw, value, 16);
};

/** The table segment that `customPut` writes. */
function customTable(number) {
  const bw = new BitWriter();
  putBits(bw, 1, 3);
  putBits(bw, 16, 5);
  putBits(bw, 3, 3);
  putBits(bw, 3, 3);
  putBits(bw, 2, 3);
  return segment({ number, type: 53, data: [((5 - 1) << 4) | ((3 - 1) << 1) | 1, ...u32(0), ...u32(65536), ...bw.finish()] });
}

/** Writes `value` with a symbol dictionary's table choice: 0 and 1 the standard tables of `standard`, 'c' the custom one. */
const choicePut = (bw, choice, standard, value) => (choice === 'c' ? customPut(bw, value) : huffPut(bw, standard[choice], value));

/**
 * A symbol dictionary coded with Huffman tables: the symbols' bitmaps stored uncompressed per class. `tables` chooses
 * the tables of the delta height (B.4, B.5), delta width (B.2, B.3) and bitmap size (B.1) ('c' = the custom table
 * `customTable` writes, referred to in the order of the choices).
 */
function symbolDictHuffman({ symbols, numIn = 0, tables = {} }) {
  const { dh = 0, dw = 0, bm = 0 } = tables;
  const bw = new BitWriter();
  let height = 0;
  let i = 0;
  while (i < symbols.length) {
    const h = symbols[i].height;
    choicePut(bw, dh, [4, 5], h - height);
    height = h;
    let width = 0;
    const row = [];
    while (i < symbols.length && symbols[i].height === h) {
      choicePut(bw, dw, [2, 3], symbols[i].width - width);
      width = symbols[i].width;
      row.push(symbols[i]);
      i += 1;
    }
    choicePut(bw, dw, [2, 3], null);
    if (bm === 'c') customPut(bw, 0);
    else huffPut(bw, 1, 0);
    bw.align();
    for (let y = 0; y < h; y += 1) {
      for (const sym of row) for (let k = 0; k < sym.width; k += 1) bw.bit(sym.data[y * sym.width + k]);
      bw.align();
    }
  }
  huffPut(bw, 1, 0);
  huffPut(bw, 1, numIn + symbols.length);
  const flags = 1 | ((dh === 'c' ? 3 : dh) << 2) | ((dw === 'c' ? 3 : dw) << 4) | (bm === 'c' ? 0x40 : 0);
  return bytesOf(u16(flags), u32(numIn + symbols.length), u32(symbols.length), bw.finish());
}

/** A bitmap of `w` x `h` sampled from `source` with a few pixels flipped. */
const resample = (source, w, h, seed) => {
  const r = rng(seed);
  const out = bitmap(w, h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) out.data[y * w + x] = r() < 0.1 ? 1 - getPixel(source, x, y) : getPixel(source, x, y);
  return out;
};

/**
 * The symbols a refinement/aggregate dictionary defines: per symbol its size and how it is coded ('ref1' one refined
 * symbol, 'agg' several instances, 'null' none). `known` holds the bitmaps the encoder knows (null for the others).
 */
function planRefAgg(r, inSyms, count) {
  const known = inSyms.map((b) => b);
  const specs = [];
  for (let k = 0; k < count; k += 1) {
    const h = 3 + Math.floor(k / 3);
    const w = 3 + (k % 3) * 2;
    const mode = ['ref1', 'agg', 'ref1', 'agg', 'ref1', 'null'][Math.floor(r() * 6)];
    const exactIds = known.map((b, id) => (b ? id : -1)).filter((id) => id >= 0);
    const spec = { w, h, mode, seed: Math.floor(r() * 1e6), dx: Math.floor(r() * 3) - 1, dy: Math.floor(r() * 3) - 1 };
    if (mode === 'ref1') {
      spec.ref = exactIds[Math.floor(r() * exactIds.length)];
      spec.target = resample(known[spec.ref], w, h, spec.seed);
      known.push(spec.target);
    } else if (mode === 'agg') {
      spec.instances = Array.from({ length: 2 + Math.floor(r() * 3) }, () => {
        const id = exactIds[Math.floor(r() * exactIds.length)];
        const refined = r() < 0.5;
        const dw = Math.floor(r() * 3) - 1;
        const dh = Math.floor(r() * 3) - 1;
        return { id, refined, dw, dh, dx: Math.floor(r() * 3) - 1, dy: Math.floor(r() * 3) - 1, gap: Math.floor(r() * 4), seed: Math.floor(r() * 1e6) };
      });
      known.push(null);
    } else known.push(null);
    specs.push(spec);
  }
  return { specs, known };
}

const codeLen = (n) => Math.max(0, Math.ceil(Math.log2(n)));

/** A refinement/aggregate symbol dictionary coded arithmetically. */
function symbolDictRefAggArith({ inSyms, specs, known, rtemplate = 0, rat = DEFAULT_RAT, template = 0, retain = false }) {
  const enc = new MqEncoder();
  const [iadh, iadw, iaai, iaex, iadt, iafs, iads, , iari, iardw, iardh, iardx, iardy] = Array.from({ length: 13 }, () => contexts(512));
  const total = inSyms.length + specs.length;
  const iaid = contexts(2 ** codeLen(total));
  const grcx = contexts(rtemplate === 0 ? 1 << 13 : 1 << 10);
  let height = 0;
  let i = 0;
  while (i < specs.length) {
    const h = specs[i].h;
    encodeInteger(enc, iadh, h - height);
    height = h;
    let width = 0;
    while (i < specs.length && specs[i].h === h) {
      const spec = specs[i];
      encodeInteger(enc, iadw, spec.w - width);
      width = spec.w;
      if (spec.mode === 'ref1') {
        encodeInteger(enc, iaai, 1);
        encodeIaid(enc, iaid, codeLen(total), spec.ref);
        encodeInteger(enc, iardx, spec.dx);
        encodeInteger(enc, iardy, spec.dy);
        encodeRefinementInto(enc, grcx, spec.target, known[spec.ref], { template: rtemplate, at: rat, dx: spec.dx, dy: spec.dy });
      } else if (spec.mode === 'agg') {
        encodeInteger(enc, iaai, spec.instances.length);
        encodeInteger(enc, iadt, 1);
        encodeInteger(enc, iadt, 1);
        encodeInteger(enc, iafs, 1);
        spec.instances.forEach((inst, k) => {
          if (k > 0) encodeInteger(enc, iads, inst.gap);
          encodeIaid(enc, iaid, codeLen(total), inst.id);
          encodeInteger(enc, iari, inst.refined ? 1 : 0);
          if (inst.refined) {
            const original = known[inst.id];
            encodeInteger(enc, iardw, inst.dw);
            encodeInteger(enc, iardh, inst.dh);
            encodeInteger(enc, iardx, inst.dx);
            encodeInteger(enc, iardy, inst.dy);
            const target = resample(original, original.width + inst.dw, original.height + inst.dh, inst.seed);
            encodeRefinementInto(enc, grcx, target, original, { template: rtemplate, at: rat, dx: (inst.dw >> 1) + inst.dx, dy: (inst.dh >> 1) + inst.dy });
          }
        });
        encodeInteger(enc, iads, null);
      } else encodeInteger(enc, iaai, 0);
      i += 1;
    }
    encodeInteger(enc, iadw, null);
  }
  encodeInteger(enc, iaex, 0);
  encodeInteger(enc, iaex, total);
  const flags = 2 | (template << 10) | (rtemplate << 12) | (retain ? 0x200 : 0);
  return bytesOf(u16(flags), DEFAULT_AT[template].map(s8), rtemplate === 0 ? rat.map(s8) : [], u32(total), u32(specs.length), enc.flush());
}

/** A refinement/aggregate symbol dictionary coded with Huffman tables (the standard ones, B.4 B.2 B.1 B.1). */
function symbolDictRefAggHuffman({ inSyms, specs, known, rtemplate = 0, rat = DEFAULT_RAT }) {
  const bw = new BitWriter();
  const total = inSyms.length + specs.length;
  const grcx = contexts(rtemplate === 0 ? 1 << 13 : 1 << 10);
  const refinement = (target, reference, dx, dy) => {
    const enc = new MqEncoder();
    encodeRefinementInto(enc, grcx, target, reference, { template: rtemplate, at: rat, dx, dy });
    return enc.flush();
  };
  let height = 0;
  let i = 0;
  while (i < specs.length) {
    const h = specs[i].h;
    huffPut(bw, 4, h - height);
    height = h;
    let width = 0;
    while (i < specs.length && specs[i].h === h) {
      const spec = specs[i];
      huffPut(bw, 2, spec.w - width);
      width = spec.w;
      if (spec.mode === 'ref1') {
        huffPut(bw, 1, 1);
        let n = 1;
        while (1 << n < total) n += 1;
        putBits(bw, spec.ref, n);
        const coded = refinement(spec.target, known[spec.ref], spec.dx, spec.dy);
        huffPut(bw, 15, spec.dx);
        huffPut(bw, 15, spec.dy);
        huffPut(bw, 1, coded.length);
        bw.align();
        for (const byte of coded) putBits(bw, byte, 8);
      } else if (spec.mode === 'agg') {
        huffPut(bw, 1, spec.instances.length);
        // the codes of the symbols decoded so far have the length the whole dictionary's symbol count needs
        let n = 1;
        while (1 << n < total) n += 1;
        huffPut(bw, 11, 1);
        huffPut(bw, 11, 1);
        huffPut(bw, 6, 1);
        spec.instances.forEach((inst, k) => {
          if (k > 0) huffPut(bw, 8, inst.gap);
          putBits(bw, inst.id, n);
          bw.bit(inst.refined ? 1 : 0);
          if (inst.refined) {
            const original = known[inst.id];
            const target = resample(original, original.width + inst.dw, original.height + inst.dh, inst.seed);
            const coded = refinement(target, original, (inst.dw >> 2) + inst.dx, (inst.dh >> 2) + inst.dy);
            huffPut(bw, 15, inst.dw);
            huffPut(bw, 15, inst.dh);
            huffPut(bw, 15, inst.dx);
            huffPut(bw, 15, inst.dy);
            huffPut(bw, 1, coded.length);
            bw.align();
            for (const byte of coded) putBits(bw, byte, 8);
          }
        });
        huffPut(bw, 8, null);
      } else huffPut(bw, 1, 0);
      i += 1;
    }
    huffPut(bw, 2, null);
  }
  huffPut(bw, 1, 0);
  huffPut(bw, 1, total);
  bw.align();
  const flags = 1 | 2 | (rtemplate << 12);
  return bytesOf(u16(flags), rtemplate === 0 ? rat.map(s8) : [], u32(total), u32(specs.length), bw.finish());
}

const textFlags = ({ huff = false, refine = false, logStrips = 0, corner = 1, transposed = false, op = 0, def = 0, offset = 0, rtemplate = 0 }) =>
  (huff ? 1 : 0) | (refine ? 2 : 0) | (logStrips << 2) | (corner << 4) | (transposed ? 0x40 : 0) | (op << 7) | (def << 9) | ((offset & 31) << 10) | (rtemplate << 15);

/** The instances of a text region: strips of [{ id, t }] with the gaps between them chosen from `r`. */
function plan(r, symbols, { strips = 1, count = 20, refine = false, grow = 0 }) {
  const perStrip = [];
  let left = count;
  while (left > 0) {
    const n = Math.min(left, 1 + Math.floor(r() * 6));
    perStrip.push(
      Array.from({ length: n }, () => ({
        id: Math.floor(r() * symbols.length),
        t: strips > 1 ? Math.floor(r() * strips) : 0,
        gap: Math.floor(r() * 5),
        refined: refine && r() < 0.4,
        dw: Math.floor(r() * 3) - 1 + (grow && r() < 0.6 ? Math.floor(r() * (grow + 1)) : 0),
        dh: Math.floor(r() * 3) - 1 + (grow && r() < 0.6 ? Math.floor(r() * (grow + 1)) : 0),
        dx: Math.floor(r() * 3) - 1,
        dy: Math.floor(r() * 3) - 1,
        seed: Math.floor(r() * 1e6),
      })),
    );
    left -= n;
  }
  return perStrip;
}

/** An arithmetic coded text region segment. */
function textRegionArith({ width, height, x = 0, y = 0, symbols, refs, strips = 1, count = 20, refine = false, rtemplate = 0, rat = DEFAULT_RAT, corner = 1, transposed = false, op = 0, def = 0, offset = 0, seed = 1, number, type = 6, regionOp = 0, grow = 0 }) {
  const r = rng(seed);
  const planned = plan(r, symbols, { strips, count, refine, grow });
  const enc = new MqEncoder();
  const [iadt, iafs, iads, iait, iari, iardw, iardh, iardx, iardy] = Array.from({ length: 9 }, () => contexts(512));
  const codeLength = Math.max(0, Math.ceil(Math.log2(symbols.length)));
  const iaid = contexts(2 ** codeLength);
  const grcx = contexts(rtemplate === 0 ? 1 << 13 : 1 << 10);
  encodeInteger(enc, iadt, 1);
  let first = 0;
  for (const strip of planned) {
    encodeInteger(enc, iadt, 1);
    const dfs = Math.floor(r() * 6);
    encodeInteger(enc, iafs, dfs);
    first += dfs;
    strip.forEach((inst, k) => {
      if (k > 0) encodeInteger(enc, iads, inst.gap - (offset > 15 ? offset - 32 : offset));
      if (strips > 1) encodeInteger(enc, iait, inst.t);
      encodeIaid(enc, iaid, codeLength, inst.id);
      if (refine) {
        encodeInteger(enc, iari, inst.refined ? 1 : 0);
        if (inst.refined) {
          const original = symbols[inst.id];
          const target = variant(original, inst.dw, inst.dh, inst.seed);
          encodeInteger(enc, iardw, inst.dw);
          encodeInteger(enc, iardh, inst.dh);
          encodeInteger(enc, iardx, inst.dx);
          encodeInteger(enc, iardy, inst.dy);
          encodeRefinementInto(enc, grcx, target, original, { template: rtemplate, at: rat, dx: (inst.dw >> 1) + inst.dx, dy: (inst.dh >> 1) + inst.dy });
        }
      }
    });
    encodeInteger(enc, iads, null);
  }
  const flags = textFlags({ refine, logStrips: Math.log2(strips), corner, transposed, op, def, offset, rtemplate });
  const data = bytesOf(regionInfo(width, height, x, y, regionOp), u16(flags), refine && rtemplate === 0 ? rat.map(s8) : [], u32(count), enc.flush());
  return segment({ number, type, refs, data });
}

/** The symbol-id table of a Huffman text region whose `count` symbols all have codes of `length` bits. */
function symbolCodeTable(bw, count) {
  const length = Math.max(1, Math.ceil(Math.log2(count)));
  for (let i = 0; i < 35; i += 1) putBits(bw, i === length ? 1 : 0, 4);
  for (let i = 0; i < count; i += 1) bw.bit(0);
  bw.align();
  return length;
}

/** A Huffman coded text region segment with the standard tables B.6, B.8, B.11 and B.14 / B.1 for refinements. */
function textRegionHuffman({ width, height, x = 0, y = 0, symbols, refs, strips = 1, count = 12, refine = false, rtemplate = 0, rat = DEFAULT_RAT, corner = 1, transposed = false, op = 0, def = 0, offset = 0, seed = 1, number, type = 6, fs = 6, ds = 8, dt = 11, rd = 14, fsValues = null, grow = 0 }) {
  const r = rng(seed);
  const planned = plan(r, symbols, { strips, count, refine, grow });
  const bw = new BitWriter();
  const length = symbolCodeTable(bw, symbols.length);
  const grcx = contexts(rtemplate === 0 ? 1 << 13 : 1 << 10);
  huffPut(bw, dt, 1);
  for (const strip of planned) {
    huffPut(bw, dt, 1);
    if (fsValues) smallCustomPut(bw, fsValues[Math.floor(r() * fsValues.length)]);
    else huffPut(bw, fs, Math.floor(r() * 6));
    strip.forEach((inst, k) => {
      if (k > 0) huffPut(bw, ds, inst.gap - (offset > 15 ? offset - 32 : offset));
      if (strips > 1) putBits(bw, inst.t, Math.log2(strips));
      putBits(bw, inst.id, length);
      if (refine) {
        bw.bit(inst.refined ? 1 : 0);
        if (inst.refined) {
          const original = symbols[inst.id];
          const target = variant(original, inst.dw, inst.dh, inst.seed);
          const enc = new MqEncoder();
          encodeRefinementInto(enc, grcx, target, original, { template: rtemplate, at: rat, dx: (inst.dw >> 2) + inst.dx, dy: (inst.dh >> 2) + inst.dy });
          const coded = enc.flush();
          huffPut(bw, rd, inst.dw);
          huffPut(bw, rd, inst.dh);
          huffPut(bw, rd, inst.dx);
          huffPut(bw, rd, inst.dy);
          huffPut(bw, 1, coded.length);
          bw.align();
          for (const byte of coded) putBits(bw, byte, 8);
        }
      }
    });
    huffPut(bw, ds, null);
  }
  bw.align();
  const flags = textFlags({ huff: true, refine, logStrips: Math.log2(strips), corner, transposed, op, def, offset, rtemplate });
  // the symbol-id table is part of the coded data: it comes after the counts
  const coded = bw.finish();
  const data = bytesOf(regionInfo(width, height, x, y, 0), u16(flags), u16((fsValues ? 3 : [6, 7].indexOf(fs)) | ([8, 9, 10].indexOf(ds) << 2) | ([11, 12, 13].indexOf(dt) << 4) | ([14, 15].indexOf(rd) * 0x1540)), refine && rtemplate === 0 ? rat.map(s8) : [], u32(count), coded);
  return segment({ number, type, refs, data });
}

/** `value` in the custom table `tableSegment(.., { low: 0, high: 8, ranges [[1, 3]], lower 2, upper 3, oob 3 })` defines. */
function smallCustomPut(bw, value) {
  if (value === null) return putBits(bw, 7, 3);
  if (value < 0) {
    putBits(bw, 2, 2);
    return putBits(bw, -1 - value, 32);
  }
  if (value >= 8) {
    putBits(bw, 6, 3);
    return putBits(bw, value - 8, 32);
  }
  bw.bit(0);
  return putBits(bw, value, 3);
}

function patternDictArith({ patterns, template = 0 }) {
  const w = patterns[0].width;
  const h = patterns[0].height;
  const collective = bitmap(w * patterns.length, h);
  patterns.forEach((p, k) => {
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) collective.data[y * collective.width + k * w + x] = p.data[y * w + x];
  });
  const enc = new MqEncoder();
  const at = [...DEFAULT_AT[template]];
  at[0] = -w;
  encodeGenericInto(enc, contexts(1 << GB_BITS[template]), collective, { template, at });
  return bytesOf(template << 1, w, h, u32(patterns.length - 1), enc.flush());
}

/** A halftone region segment data: gray values (rows of cells) coded as Gray-coded arithmetic bitplanes. */
function halftoneArith({ width, height, x = 0, y = 0, gray, patternCount, template = 0, skip = false, op = 0, def = 0, gx = 0, gy = 0, rx, ry, regionOp = 0 }) {
  const gh = gray.length;
  const gw = gray[0].length;
  const bits = Math.max(1, Math.ceil(Math.log2(patternCount)));
  const enc = new MqEncoder();
  const cx = contexts(1 << GB_BITS[template]);
  for (let j = bits - 1; j >= 0; j -= 1) {
    const plane = bitmap(gw, gh);
    for (let m = 0; m < gh; m += 1) {
      for (let n = 0; n < gw; n += 1) {
        const bit = (gray[m][n] >> j) & 1;
        const above = j < bits - 1 ? (gray[m][n] >> (j + 1)) & 1 : 0;
        plane.data[m * gw + n] = bit ^ above;
      }
    }
    encodeGenericInto(enc, cx, plane, { template });
  }
  const flags = (template << 1) | (skip ? 8 : 0) | (op << 4) | (def << 7);
  return bytesOf(regionInfo(width, height, x, y, regionOp), flags, u32(gw), u32(gh), u32(gx), u32(gy), u16(rx), u16(ry), enc.flush());
}

// ---- cases ---------------------------------------------------------------------------------------------------------

const cases = [];
const names = new Set();
const jbig2Case = (name, data, width, height, globals = null) => {
  if (names.has(name)) throw new Error(`case name ${name} is used twice`);
  names.add(name);
  cases.push({ name, data, width, height, globals });
};
const page = (w, h, flags = 0) => segment({ number: 0, type: 48, data: pageInfo({ width: w, height: h, flags }) });
const sortedByHeight = (list) => [...list].sort((a, b) => a.height - b.height || a.width - b.width);

/** A set of `n` glyphs (sorted by height, then width). */
const glyphSet = (n, seed) => {
  const r = rng(seed);
  return sortedByHeight(Array.from({ length: n }, (_, k) => glyph(3 + Math.floor(r() * 6), 4 + Math.floor(r() * 7), seed * 100 + k)));
};

function dictionaryCases() {
  const glyphs = glyphSet(9, 3);
  for (const template of [0, 1, 2, 3]) {
    const dict = symbolDictArith({ symbols: glyphs, template });
    jbig2Case(`sdd-arith-only-t${template}`, concat(page(60, 30), segment({ number: 1, type: 0, data: dict.data })), 60, 30);
    const text = textRegionArith({ width: 60, height: 30, symbols: glyphs, refs: [1], number: 2, seed: template + 1 });
    jbig2Case(`sdd-arith-t${template}`, concat(page(60, 30), segment({ number: 1, type: 0, data: dict.data }), text), 60, 30);
  }
  const moved = symbolDictArith({ symbols: glyphs, template: 0, at: [-5, -3, 4, -1, -3, -1, 2, -2] });
  jbig2Case('sdd-arith-moved-at', concat(page(60, 30), segment({ number: 1, type: 0, data: moved.data }), textRegionArith({ width: 60, height: 30, symbols: glyphs, refs: [1], number: 2 })), 60, 30);
  const huff = symbolDictHuffman({ symbols: glyphs });
  jbig2Case('sdd-huffman', concat(page(60, 30), segment({ number: 1, type: 0, data: huff }), textRegionArith({ width: 60, height: 30, symbols: glyphs, refs: [1], number: 2 })), 60, 30);
  jbig2Case('sdd-huffman-text-huffman', concat(page(60, 30), segment({ number: 1, type: 0, data: huff }), textRegionHuffman({ width: 60, height: 30, symbols: glyphs, refs: [1], number: 2 })), 60, 30);
  // two dictionaries: the second adds symbols and exports all of both; retained contexts continue
  const first = symbolDictArith({ symbols: glyphs.slice(0, 5), template: 0, retain: true });
  const second = symbolDictArith({ symbols: sortedByHeight(glyphs.slice(5)), template: 0, numIn: 5, useContexts: true, gb: first.gb });
  const all = [...glyphs.slice(0, 5), ...sortedByHeight(glyphs.slice(5))];
  jbig2Case(
    'sdd-retained-contexts',
    concat(page(60, 30), segment({ number: 1, type: 0, data: first.data }), segment({ number: 2, type: 0, refs: [1], data: second.data }), textRegionArith({ width: 60, height: 30, symbols: all, refs: [2], number: 3 })),
    60,
    30,
  );
  const withoutRetention = symbolDictArith({ symbols: glyphs.slice(0, 5), template: 0 });
  jbig2Case(
    'sdd-contexts-not-retained',
    concat(page(60, 30), segment({ number: 1, type: 0, data: withoutRetention.data }), segment({ number: 2, type: 0, refs: [1], data: second.data })),
    60,
    30,
  );
  // dictionaries in the globals stream
  const globals = concat(segment({ number: 1, type: 0, data: symbolDictArith({ symbols: glyphs, template: 0 }).data }));
  jbig2Case('globals-dictionary', concat(page(60, 30), textRegionArith({ width: 60, height: 30, symbols: glyphs, refs: [1], number: 2 })), 60, 30, globals);
}

function refAggCases() {
  const base = glyphSet(5, 21);
  const baseDict = segment({ number: 1, type: 0, data: symbolDictArith({ symbols: base, template: 0 }).data });
  const baseHuffDict = segment({ number: 1, type: 0, data: symbolDictHuffman({ symbols: base }) });
  for (let k = 0; k < 8; k += 1) {
    const r = rng(300 + k);
    const rtemplate = k % 2;
    const rat = k % 4 === 3 ? [-2, -1, 1, 0] : DEFAULT_RAT;
    const { specs, known } = planRefAgg(r, base, 6 + k);
    const arith = symbolDictRefAggArith({ inSyms: base, specs, known, rtemplate, rat, template: k % 4 });
    const withInput = (number, data) => segment({ number, type: 0, refs: [1], data });
    jbig2Case(`sdd-refagg-arith-${k}`, concat(page(60, 30), baseDict, withInput(2, arith)), 60, 30);
    const huffman = symbolDictRefAggHuffman({ inSyms: base, specs, known, rtemplate, rat });
    jbig2Case(`sdd-refagg-huffman-${k}`, concat(page(60, 30), baseHuffDict, withInput(2, huffman)), 60, 30);
    if (k % 2 === 0) {
      // the new symbols used by a text region (the ids of the symbols the dictionary defines, whatever their bitmaps)
      const stand = [...base, ...specs.map((spec, id) => spec.target ?? glyph(3, 3, id))];
      jbig2Case(`sdd-refagg-then-text-${k}`, concat(page(60, 30), baseDict, withInput(2, arith), textRegionArith({ width: 60, height: 30, symbols: stand, refs: [2], number: 3, seed: k, count: 8 })), 60, 30);
    }
  }
  const glyphs = glyphSet(7, 31);
  const custom = customTable(1);
  let n = 0;
  for (const dh of [0, 1, 'c']) {
    for (const dw of [0, 1, 'c']) {
      for (const bm of [0, 'c']) {
        n += 1;
        const refs = [dh, dw, bm].filter((c) => c === 'c').map(() => 1);
        const data = symbolDictHuffman({ symbols: glyphs, tables: { dh, dw, bm } });
        jbig2Case(`sdd-huffman-tables-${dh}-${dw}-${bm}`, concat(page(60, 30), custom, segment({ number: 2, type: 0, refs, data }), textRegionArith({ width: 60, height: 30, symbols: glyphs, refs: [2], number: 3, seed: n })), 60, 30);
      }
    }
  }
}

/** A dictionary of `n` new symbols without pixels (width 0), exporting all of them. */
function nullSymbolDict(n, { numNew = n, numEx = n } = {}) {
  const enc = new MqEncoder();
  const [iadh, iadw, iaex] = Array.from({ length: 3 }, () => contexts(512));
  encodeInteger(enc, iadh, 1);
  for (let i = 0; i < n; i += 1) encodeInteger(enc, iadw, 0);
  encodeInteger(enc, iadw, null);
  encodeInteger(enc, iaex, 0);
  encodeInteger(enc, iaex, n);
  return bytesOf(u16(0), DEFAULT_AT[0].map(s8), u32(numEx), u32(numNew), enc.flush());
}

function limitCases() {
  const glyphs = glyphSet(9, 3);
  const dict = symbolDictArith({ symbols: glyphs, template: 0 }).data;
  const withField = (offset, value) => {
    const d = Uint8Array.from(dict);
    d.set(u32(value), offset);
    return d;
  };
  for (const numEx of [9, 65536, 262152, 1 << 20, (1 << 20) + 1, 1 << 24]) {
    jbig2Case(`sdd-export-count-${numEx}`, concat(page(60, 30), segment({ number: 1, type: 0, data: withField(10, numEx) })), 60, 30);
  }
  for (const n of [70000, 1 << 20]) jbig2Case(`sdd-null-symbols-${n}`, concat(page(60, 30), segment({ number: 1, type: 0, data: nullSymbolDict(n) })), 60, 30);
  jbig2Case('sdd-new-symbols-beyond-limit', concat(page(60, 30), segment({ number: 1, type: 0, data: nullSymbolDict(100, { numNew: (1 << 20) + 1 }) })), 60, 30);
  // a generic region that asks for more rows than the data holds, the data ending in its marker
  for (let seed = 0; seed < 12; seed += 1) {
    const bm = scene(16 + (seed % 3) * 5, 3 + (seed % 4), 70 + seed, 0.3);
    const enc = new MqEncoder();
    encodeGenericInto(enc, contexts(1 << 16), bm, { template: 0 });
    const tall = bm.height + 20 + seed * 7;
    const data = base.genericRegionData({ region: regionInfo(bm.width, tall, 0, 0, 0), template: 0, payload: enc.flush() });
    jbig2Case(`generic-more-rows-than-data-${seed}`, concat(page(bm.width, tall), segment({ number: 1, type: 38, data })), bm.width, tall);
  }
}

function textCases() {
  const glyphs = glyphSet(8, 5);
  const dict = segment({ number: 1, type: 0, data: symbolDictArith({ symbols: glyphs, template: 0 }).data });
  const huffDict = segment({ number: 1, type: 0, data: symbolDictHuffman({ symbols: glyphs }) });
  let n = 0;
  for (const corner of [0, 1, 2, 3]) {
    for (const transposed of [false, true]) {
      n += 1;
      jbig2Case(`text-arith-corner${corner}${transposed ? '-transposed' : ''}`, concat(page(64, 40), dict, textRegionArith({ width: 64, height: 40, symbols: glyphs, refs: [1], corner, transposed, count: 18, number: 2, seed: n })), 64, 40);
      jbig2Case(`text-huffman-corner${corner}${transposed ? '-transposed' : ''}`, concat(page(64, 40), huffDict, textRegionHuffman({ width: 64, height: 40, symbols: glyphs, refs: [1], corner, transposed, count: 14, number: 2, seed: n })), 64, 40);
    }
  }
  for (const strips of [1, 2, 4, 8]) {
    jbig2Case(`text-arith-strips${strips}`, concat(page(64, 40), dict, textRegionArith({ width: 64, height: 40, symbols: glyphs, refs: [1], strips, count: 20, number: 2, seed: 30 + strips })), 64, 40);
    jbig2Case(`text-huffman-strips${strips}`, concat(page(64, 40), huffDict, textRegionHuffman({ width: 64, height: 40, symbols: glyphs, refs: [1], strips, count: 14, number: 2, seed: 30 + strips })), 64, 40);
  }
  for (const offset of [0, 1, 7, 15, 16, 31]) {
    jbig2Case(`text-arith-dsoffset${offset}`, concat(page(64, 40), dict, textRegionArith({ width: 64, height: 40, symbols: glyphs, refs: [1], offset, number: 2, seed: 50 + offset })), 64, 40);
  }
  for (const op of [0, 1, 2, 3]) {
    for (const def of [0, 1]) {
      jbig2Case(`text-arith-op${op}-def${def}`, concat(page(64, 40), dict, textRegionArith({ width: 64, height: 40, symbols: glyphs, refs: [1], op, def, number: 2, seed: 60 + op })), 64, 40);
    }
  }
  for (const regionOp of [0, 1, 2, 3, 4, 5, 6, 7]) {
    jbig2Case(`text-region-onto-page-op${regionOp}`, concat(page(64, 40, 4), dict, textRegionArith({ width: 40, height: 30, x: 10, y: 5, symbols: glyphs, refs: [1], regionOp, number: 2, seed: 70 })), 64, 40);
  }
  for (const rtemplate of [0, 1]) {
    for (const corner of [1, 2]) {
      jbig2Case(`text-arith-refine-t${rtemplate}-corner${corner}`, concat(page(64, 40), dict, textRegionArith({ width: 64, height: 40, symbols: glyphs, refs: [1], refine: true, rtemplate, corner, count: 24, number: 2, seed: 80 + rtemplate })), 64, 40);
      jbig2Case(`text-huffman-refine-t${rtemplate}-corner${corner}`, concat(page(64, 40), huffDict, textRegionHuffman({ width: 64, height: 40, symbols: glyphs, refs: [1], refine: true, rtemplate, corner, count: 12, number: 2, seed: 90 + rtemplate })), 64, 40);
    }
  }
  for (const fs of [6, 7]) {
    for (const ds of [8, 9, 10]) {
      for (const dt of [11, 12, 13]) {
        for (const rd of [14, 15]) {
          jbig2Case(`text-huffman-tables-fs${fs}-ds${ds}-dt${dt}-rd${rd}`, concat(page(64, 40), huffDict, textRegionHuffman({ width: 64, height: 40, symbols: glyphs, refs: [1], refine: true, count: 14, number: 2, seed: fs * 100 + ds * 10 + dt, fs, ds, dt, rd, offset: 3 })), 64, 40);
        }
      }
    }
  }
  const smallTable = tableSegment(1, { oob: true, prefixBits: 3, rangeBits: 3, low: 0, high: 8, lengths: { ranges: [[1, 3]], lower: 2, upper: 3, oob: 3 } });
  const customDict = segment({ number: 2, type: 0, data: symbolDictHuffman({ symbols: glyphs }).slice(0) });
  for (const values of [[0, 3, 7], [-1, -9, 2], [8, 30, 1], [-100, 500, 4, 0]]) {
    jbig2Case(`text-huffman-custom-first-s-${values.join('_')}`, concat(page(64, 40), smallTable, customDict, textRegionHuffman({ width: 64, height: 40, symbols: glyphs, refs: [1, 2], count: 16, number: 3, seed: 7, fsValues: values })), 64, 40);
  }
  // refinements that grow the symbol: the arithmetic decoder moves the reference by half the growth, the Huffman one by a quarter (what the decoder does, whatever T.88 says)
  for (const grow of [2, 5]) {
    for (const rtemplate of [0, 1]) {
      jbig2Case(`text-arith-refine-grow${grow}-t${rtemplate}`, concat(page(64, 40), dict, textRegionArith({ width: 64, height: 40, symbols: glyphs, refs: [1], refine: true, rtemplate, count: 24, number: 2, seed: 120 + grow, grow })), 64, 40);
      jbig2Case(`text-huffman-refine-grow${grow}-t${rtemplate}`, concat(page(64, 40), huffDict, textRegionHuffman({ width: 64, height: 40, symbols: glyphs, refs: [1], refine: true, rtemplate, count: 16, number: 2, seed: 130 + grow, grow, rd: 15 })), 64, 40);
    }
  }
  jbig2Case('text-arith-refine-moved-at', concat(page(64, 40), dict, textRegionArith({ width: 64, height: 40, symbols: glyphs, refs: [1], refine: true, rat: [-2, -1, 1, 0], count: 20, number: 2, seed: 95 })), 64, 40);
  // an intermediate text region refined by a refinement region
  const intermediate = textRegionArith({ width: 30, height: 20, symbols: glyphs, refs: [1], type: 4, number: 2, seed: 97 });
  jbig2Case('text-intermediate-region-unused', concat(page(64, 40), dict, intermediate), 64, 40);
  // a page of text: several regions of one dictionary
  jbig2Case(
    'text-page-of-lines',
    concat(page(100, 60), dict, ...[0, 1, 2, 3].map((line) => textRegionArith({ width: 100, height: 12, y: line * 14, symbols: glyphs, refs: [1], count: 30, strips: 4, number: 2 + line, seed: 100 + line }))),
    100,
    60,
  );
}

function patternCases() {
  const r = rng(9);
  for (const template of [0, 1, 2, 3]) {
    const patterns = Array.from({ length: 6 }, (_, k) => glyph(4, 4, 40 + k));
    const gray = Array.from({ length: 5 }, () => Array.from({ length: 9 }, () => Math.floor(r() * 6)));
    const dict = segment({ number: 1, type: 16, data: patternDictArith({ patterns, template }) });
    const region = (op, extra = {}) => segment({ number: 2, type: 22, refs: [1], data: halftoneArith({ width: 40, height: 24, gray, patternCount: 6, template, rx: 4 * 256, ry: 0, op, ...extra }) });
    jbig2Case(`halftone-arith-t${template}`, concat(page(40, 24), dict, region(0)), 40, 24);
    if (template === 0) {
      for (const op of [0, 1, 2, 3, 4, 5, 6, 7]) jbig2Case(`halftone-op${op}`, concat(page(40, 24), dict, region(op, { def: op & 1 })), 40, 24);
      for (const regionOp of [0, 1, 2, 3, 4]) jbig2Case(`halftone-region-op${regionOp}`, concat(page(40, 24, 4), dict, region(0, { regionOp, x: 3, y: 2 })), 40, 24);
      jbig2Case('halftone-rotated-grid', concat(page(40, 24), dict, region(0, { rx: 1000, ry: 300, gx: 256 * 3, gy: 256 })), 40, 24);
      jbig2Case('halftone-negative-origin', concat(page(40, 24), dict, region(0, { gx: -256 * 2, gy: -256 })), 40, 24);
      jbig2Case('halftone-skip', concat(page(40, 24), dict, region(0, { skip: true, rx: 6 * 256 })), 40, 24);
    }
  }
  const two = [glyph(5, 3, 71), glyph(5, 3, 72)];
  jbig2Case('halftone-two-patterns', concat(page(30, 12), segment({ number: 1, type: 16, data: patternDictArith({ patterns: two }) }), segment({ number: 2, type: 22, refs: [1], data: halftoneArith({ width: 30, height: 12, gray: [[0, 1, 1, 0, 1, 0], [1, 0, 0, 1, 1, 1]], patternCount: 2, rx: 5 * 256, ry: 0 }) })), 30, 12);
  const sixteen = Array.from({ length: 16 }, (_, k) => glyph(3, 3, 120 + k));
  jbig2Case('halftone-sixteen-patterns', concat(page(30, 12), segment({ number: 1, type: 16, data: patternDictArith({ patterns: sixteen }) }), segment({ number: 2, type: 23, refs: [1], data: halftoneArith({ width: 30, height: 12, gray: [[0, 5, 9, 15, 3, 7, 11, 2, 13, 1]], patternCount: 16, rx: 3 * 256, ry: 0 }) })), 30, 12);
  jbig2Case('halftone-intermediate-unused', concat(page(30, 12), segment({ number: 1, type: 16, data: patternDictArith({ patterns: two }) }), segment({ number: 2, type: 20, refs: [1], data: halftoneArith({ width: 30, height: 12, gray: [[0, 1]], patternCount: 2, rx: 5 * 256, ry: 0 }) })), 30, 12);
}

// ---- random payloads behind valid headers --------------------------------------------------------------------------

const random = (r, n) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256));

/** Bytes that decode as long runs: low entropy, so that the arithmetic decoder does not fail at once. */
const lowEntropy = (r, n) => Uint8Array.from({ length: n }, () => (r() < 0.7 ? 0x00 : Math.floor(r() * 256)));

function tableSegment(number, { oob, prefixBits, rangeBits, low, high, lengths }) {
  const bw = new BitWriter();
  for (const [prefix, range] of lengths.ranges) {
    putBits(bw, prefix, prefixBits);
    putBits(bw, range, rangeBits);
  }
  putBits(bw, lengths.lower, prefixBits);
  putBits(bw, lengths.upper, prefixBits);
  if (oob) putBits(bw, lengths.oob, prefixBits);
  return segment({ number, type: 53, data: [((rangeBits - 1) << 4) | ((prefixBits - 1) << 1) | (oob ? 1 : 0), ...u32(low >>> 0), ...u32(high >>> 0), ...bw.finish()] });
}

function fuzzCases() {
  const r = rng(2024);
  const glyphs = glyphSet(6, 11);
  const dict = segment({ number: 1, type: 0, data: symbolDictArith({ symbols: glyphs, template: 0 }).data });
  const huffDict = segment({ number: 1, type: 0, data: symbolDictHuffman({ symbols: glyphs }) });
  const regionHeader = (w, h) => regionInfo(w, h, 0, 0, 0);
  for (let k = 0; k < 40; k += 1) {
    const template = k % 4;
    const refagg = k % 3 === 1;
    const rtemplate = k % 2;
    const flags = (template << 10) | (refagg ? 2 : 0) | (rtemplate << 12) | (k % 5 === 0 ? 0x300 : 0);
    const at = template === 0 ? DEFAULT_AT[0].map(s8) : DEFAULT_AT[template].map(s8);
    const rat = refagg && rtemplate === 0 ? [255, 255, 255, 255] : [];
    const numNew = 1 + Math.floor(r() * 8);
    const payload = k % 2 ? lowEntropy(r, 40 + Math.floor(r() * 120)) : random(r, 40 + Math.floor(r() * 120));
    const refs = k % 3 === 0 ? [1] : [];
    jbig2Case(`fuzz-sdd-arith-${k}`, concat(page(40, 20), dict, segment({ number: 2, type: 0, refs, data: bytesOf(u16(flags), at, rat, u32(numNew + (refs.length ? 6 : 0)), u32(numNew), payload) }), textRegionArith({ width: 40, height: 20, symbols: glyphs, refs: [2], number: 3, seed: k })), 40, 20);
  }
  // Huffman dictionaries: every table choice, with custom tables referred to
  const custom = tableSegment(3, { oob: true, prefixBits: 3, rangeBits: 3, low: 0, high: 8, lengths: { ranges: [[1, 3]], lower: 2, upper: 3, oob: 3 } });
  const custom2 = tableSegment(4, { oob: false, prefixBits: 3, rangeBits: 2, low: -4, high: 12, lengths: { ranges: [[2, 2], [2, 2], [2, 2], [2, 2]], lower: 3, upper: 3 } });
  jbig2Case('table-segment-unused', concat(page(8, 8), custom, custom2), 8, 8);
  for (let k = 0; k < 48; k += 1) {
    const dh = k % 4;
    const dw = (k >> 2) % 4;
    const bm = (k >> 1) % 2;
    const agg = (k >> 3) % 2;
    const refagg = k % 5 === 0;
    const flags = 1 | (refagg ? 2 : 0) | (dh << 2) | (dw << 4) | (bm << 6) | (agg << 7) | ((k % 2) << 12);
    const numTables = (dh === 3 ? 1 : 0) + (dw === 3 ? 1 : 0) + bm + agg;
    const refs = [custom, custom2].slice(0, numTables).map((_, i) => 3 + i);
    const rat = refagg && k % 2 === 0 ? [255, 255, 255, 255] : [];
    const payload = lowEntropy(r, 30 + Math.floor(r() * 100));
    jbig2Case(
      `fuzz-sdd-huffman-${k}`,
      concat(page(40, 20), custom, custom2, segment({ number: 10, type: 0, refs: [...refs, ...(k % 3 === 0 ? [1] : [])], data: bytesOf(u16(flags), rat, u32(4), u32(1 + (k % 4)), payload) }), dict),
      40,
      20,
    );
  }
  for (let k = 0; k < 30; k += 1) {
    const huffTables = [0, 1, 3, 0, 1, 3, 2][k % 7];
    const flags2 = huffTables | ((k % 3) << 2) | ((k % 3) << 4) | ((k % 2) << 6) | ((k % 2) << 8) | ((k % 2) << 10) | ((k % 2) << 12) | ((k >> 1) % 2 << 14);
    const text = (huff, refine) => textFlags({ huff, refine, logStrips: k % 4, corner: k % 4, transposed: k % 3 === 0, op: k % 4, def: k % 2, offset: k % 32, rtemplate: k % 2 });
    const refine = k % 3 === 2;
    const huff = k % 2 === 0;
    const tail = huff ? bytesOf(u16(flags2), refine && k % 4 === 0 ? [255, 255, 255, 255] : [], u32(3 + (k % 8)), lowEntropy(r, 60)) : bytesOf(refine && k % 4 === 0 ? [255, 255, 255, 255] : [], u32(3 + (k % 8)), lowEntropy(r, 60));
    const refs = [1, ...(huff ? [3, 4].slice(0, k % 3) : [])];
    jbig2Case(
      `fuzz-text-${huff ? 'huffman' : 'arith'}-${k}`,
      concat(page(30, 20), huff ? huffDict : dict, custom, custom2, segment({ number: 7, type: 6, refs, data: bytesOf(regionHeader(30, 20), u16(text(huff, refine)), tail) })),
      30,
      20,
    );
  }
  const patterns = Array.from({ length: 4 }, (_, k) => glyph(3, 3, 200 + k));
  const patternDict = segment({ number: 1, type: 16, data: patternDictArith({ patterns }) });
  for (let k = 0; k < 16; k += 1) {
    const mmr = k % 4 === 0;
    const flags = (mmr ? 1 : 0) | ((k % 4) << 1);
    jbig2Case(`fuzz-pattern-dict-${k}`, concat(page(20, 10), segment({ number: 1, type: 16, data: bytesOf(flags, 2 + (k % 3), 2 + (k % 2), u32(3 + k), lowEntropy(r, 30)) })), 20, 10);
  }
  for (let k = 0; k < 12; k += 1) {
    const mmr = k % 6 === 0;
    const flags = (mmr ? 1 : 0) | ((k % 4) << 1) | ((k >> 2) % 2 << 3) | (((k % 5) + (k % 3)) << 4) | (k % 2 << 7);
    const body = bytesOf(regionHeader(30, 16), flags, u32(3 + (k % 5)), u32(2 + (k % 4)), u32((k * 300) >>> 0), u32((k * 100) >>> 0), u16(900 + k), u16(k * 50), lowEntropy(r, 50));
    jbig2Case(`fuzz-halftone-${k}`, concat(page(30, 16), patternDict, segment({ number: 2, type: 22, refs: [1], data: body })), 30, 16);
  }
  jbig2Case('halftone-without-patterns', concat(page(30, 16), segment({ number: 2, type: 22, data: bytesOf(regionHeader(30, 16), 0, u32(2), u32(2), u32(0), u32(0), u16(256), u16(0), random(r, 8)) })), 30, 16);
  jbig2Case('halftone-refers-to-non-patterns', concat(page(30, 16), dict, segment({ number: 2, type: 22, refs: [1], data: bytesOf(regionHeader(30, 16), 0, u32(2), u32(2), u32(0), u32(0), u16(256), u16(0), random(r, 8)) })), 30, 16);
  jbig2Case('text-without-dictionary', concat(page(30, 20), segment({ number: 2, type: 6, data: bytesOf(regionHeader(30, 20), u16(0), u32(0), random(r, 8)) })), 30, 20);
  jbig2Case('text-instances-beyond-data', concat(page(30, 20), dict, segment({ number: 2, type: 6, refs: [1], data: bytesOf(regionHeader(30, 20), u16(0), u32(0xffffff), random(r, 8)) })), 30, 20);
  jbig2Case('text-region-before-page', concat(dict, textRegionArith({ width: 30, height: 20, symbols: glyphs, refs: [1], number: 2 })), 30, 20);
  jbig2Case('dictionary-too-many-symbols', concat(page(30, 20), segment({ number: 1, type: 0, data: bytesOf(u16(0), DEFAULT_AT[0].map(s8), u32(70000), u32(10), random(r, 20)) })), 30, 20);
  const announced = Uint8Array.from(symbolDictArith({ symbols: glyphs }).data);
  announced.set(u32(1), 10);
  jbig2Case('dictionary-export-more-than-announced', concat(page(30, 20), segment({ number: 1, type: 0, data: announced })), 30, 20);
}

// ---- damaged copies of the clean streams --------------------------------------------------------------------------

function damagedCases() {
  const glyphs = glyphSet(8, 5);
  const clean = concat(page(64, 40), segment({ number: 1, type: 0, data: symbolDictArith({ symbols: glyphs, template: 0 }).data }), textRegionArith({ width: 64, height: 40, symbols: glyphs, refs: [1], count: 18, number: 2, seed: 4 }));
  const r = rng(77);
  for (const cut of [0.9, 0.75, 0.6, 0.5, 0.4]) jbig2Case(`damaged-truncated-${cut}`, clean.slice(0, Math.floor(clean.length * cut)), 64, 40);
  for (let k = 0; k < 20; k += 1) {
    const copy = Uint8Array.from(clean);
    for (let f = 0; f < 3; f += 1) copy[40 + Math.floor(r() * (copy.length - 40))] ^= 1 << Math.floor(r() * 8);
    jbig2Case(`damaged-bitflips-${k}`, copy, 64, 40);
  }
  const huffman = concat(page(64, 40), segment({ number: 1, type: 0, data: symbolDictHuffman({ symbols: glyphs }) }), textRegionHuffman({ width: 64, height: 40, symbols: glyphs, refs: [1], count: 14, number: 2, seed: 8 }));
  for (const cut of [0.9, 0.7, 0.5]) jbig2Case(`damaged-huffman-truncated-${cut}`, huffman.slice(0, Math.floor(huffman.length * cut)), 64, 40);
  for (let k = 0; k < 20; k += 1) {
    const copy = Uint8Array.from(huffman);
    for (let f = 0; f < 3; f += 1) copy[40 + Math.floor(r() * (copy.length - 40))] ^= 1 << Math.floor(r() * 8);
    jbig2Case(`damaged-huffman-bitflips-${k}`, copy, 64, 40);
  }
}

/** Copies of the clean streams of every kind with a few bits flipped (anywhere after the page information). */
function mutantCases() {
  const sources = cases.filter((c) => /^(sdd-refagg|sdd-huffman-tables|sdd-retained|text-arith-refine|text-huffman-refine|text-huffman-tables|text-huffman-custom|text-arith-strips4|halftone-arith|halftone-skip|halftone-sixteen|halftone-rotated|text-huffman-corner2)/.test(c.name));
  const r = rng(555);
  for (const source of sources) {
    for (let k = 0; k < 12; k += 1) {
      const copy = Uint8Array.from(source.data);
      const flips = 1 + Math.floor(r() * 3);
      for (let f = 0; f < flips; f += 1) copy[30 + Math.floor(r() * (copy.length - 30))] ^= 1 << Math.floor(r() * 8);
      jbig2Case(`mutant-${source.name}-${k}`, copy, source.width, source.height, source.globals);
    }
  }
}

// ---- the recording ------------------------------------------------------------------------------------------------

const renderCase = (c, expected) =>
  [`case ${c.name}`, 'kind jbig2', `width ${c.width}`, `height ${c.height}`, `data ${hex(c.data)}`, ...(c.globals ? [`globals ${hex(c.globals)}`] : []), expected.ok ? `ok ${expected.hex}` : `error ${expected.message}`].join('\n');

const reference = await loadReference();
dictionaryCases();
limitCases();
refAggCases();
textCases();
patternCases();
fuzzCases();
damagedCases();
mutantCases();
const results = [];
for (const c of cases) results.push(await reference.decode(c));
// the clean streams the encoders wrote must decode (the others are whatever the decoder makes of them)
const refusedAll = cases.filter((c, i) => !/^(fuzz|damaged|mutant|sdd-export-count-(1048577|16777216)|sdd-new-symbols-beyond|halftone-without|halftone-refers|text-without|text-instances|text-region-before|dictionary-too|dictionary-export|sdd-contexts-not)/.test(c.name) && !results[i].ok);
const refused = refusedAll;
if (refused.length) throw new Error(`the decoder refused clean streams: ${refused.slice(0, 40).map((c) => `${c.name} (${results[cases.indexOf(c)].message})`).join(', ')}`);
// traps of the wasm module are not behaviour: keep only decoded streams and "Unknown error"
const kept = cases.map((c, i) => [c, results[i]]).filter(([, res]) => res.ok || res.message === 'Unknown error');
const dropped = cases.length - kept.length;
const finalDir = join(REPO_ROOT, 'native', 'core', 'fixtures', SET);
mkdirSync(finalDir, { recursive: true });
const text = `${kept.map(([c, res]) => renderCase(c, res)).join('\n\n')}\n`;
writeFileSync(join(finalDir, 'cases.txt'), text);
const outcomes = { ok: kept.filter(([, res]) => res.ok).length, failed: kept.filter(([, res]) => !res.ok).length };
const manifest = {
  set: SET,
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <Node product tree with node_modules>`,
  cases: kept.length,
  droppedTraps: dropped,
  outcomes,
  reference: { pdfjsDist: reference.version, module: 'wasm/jbig2.wasm', sha256: reference.wasmSha256 },
  files: [{ path: 'cases.txt', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }],
};
writeFileSync(join(finalDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`recorded ${SET}: ${kept.length} cases (${outcomes.ok} decoded, ${outcomes.failed} failed, ${dropped} traps dropped), cases.txt`);
