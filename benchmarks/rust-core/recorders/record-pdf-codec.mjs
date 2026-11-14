#!/usr/bin/env node
// PDF codec goldens (track nr-exthost): what pdf.js, opened exactly as `attachments/pdf-extract.mjs` opens it (see
// record-pdf-reader.mjs, whose `pdfEngine` is used here), makes of content streams stored through every stream filter and
// predictor, and of files encrypted by the standard security handler.
//
// Filters and predictors: each case is a one-page pdf-lib document (Helvetica, standard security off) whose content
// stream the recorder replaces with the same text operators encoded by its own encoders: FlateDecode, LZWDecode (early
// change 1 and 0), ASCII85Decode, ASCIIHexDecode, RunLengthDecode, their abbreviated names, chains of them, and the TIFF
// (2) and PNG (10..15, every row tag) predictors over Flate and LZW with several Colors / BitsPerComponent / Columns.
// The recorder asserts that pdf.js reads back exactly the lines that were encoded, so a broken encoder cannot be recorded.
//
// Encryption: a small standard-security-handler writer (written here, from ISO 32000-1 7.6 and ISO 32000-2 7.6.4:
// algorithms 2 to 5, 2.A and 2.B) produces RC4-40 (V1 R2), RC4-128 (V2 R3), AESV2 (V4 R4), AESV3 (V5 R6 and the
// deprecated R5), each with an empty user password and with a non-empty one. Every file is opened without a password,
// with the user password, with the owner password and with a wrong one; pdf.js opening each file (the recorder asserts
// the empty-password files open by themselves and read the expected text with the right passwords) validates the writer.
//
// Recorded per file (native/core/fixtures/pdf-codec/goldens/<name>.json): for each open attempt the outcome of
// getDocument ({numPages} or the exception {name, code, message}) and, when it opened, the first page's getTextContent
// strings. Keys are sorted, nothing carries a date, every random value (IV, salts, file key) is a constant.
//
//   node benchmarks/rust-core/recorders/record-pdf-codec.mjs --tree C:\Project\mixdog
import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { pdfEngine, rawPdf } from './record-pdf-reader.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-pdf-codec.mjs';
const SET = 'pdf-codec';

const lat = (s) => Buffer.from(s, 'latin1');

// ---------------------------------------------------------------------------------------------------------------------
// Stream encoders (decoding order is the order of /Filter; a chain is encoded from the last filter to the first)

const flate = (data) => deflateSync(data, { level: 6 });

/** PDF's LZW: MSB-first codes of 9 to 12 bits, clear code 256, end code 257, `early` = the EarlyChange parameter. */
function lzw(data, early = 1) {
  const out = [];
  let bits = 0;
  let count = 0;
  const emit = (code, width) => {
    bits = (bits << width) | code;
    count += width;
    while (count >= 8) {
      out.push((bits >>> (count - 8)) & 0xff);
      count -= 8;
    }
    bits &= (1 << count) - 1;
  };
  let table = new Map();
  let next = 258;
  let width = 9;
  emit(256, width);
  if (data.length) {
    let current = data[0];
    for (let i = 1; i < data.length; i += 1) {
      const key = current * 256 + data[i];
      const found = table.get(key);
      if (found !== undefined) {
        current = found;
        continue;
      }
      emit(current, width);
      table.set(key, next);
      next += 1;
      if (next + early > 1 << width && width < 12) width += 1;
      if (next >= 4094) {
        emit(256, width);
        table = new Map();
        next = 258;
        width = 9;
      }
      current = data[i];
    }
    emit(current, width);
    // the decoder adds one entry for this last code too
    next += 1;
    if (next + early > 1 << width && width < 12) width += 1;
  }
  emit(257, width);
  if (count > 0) out.push((bits << (8 - count)) & 0xff);
  return Buffer.from(out);
}

function ascii85(data) {
  let text = '';
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    let value = 0;
    for (let k = 0; k < 4; k += 1) value = value * 256 + (chunk[k] ?? 0);
    if (chunk.length === 4 && value === 0) {
      text += 'z';
      continue;
    }
    const digits = [];
    for (let k = 0; k < 5; k += 1) {
      digits.unshift(String.fromCharCode((value % 85) + 33));
      value = Math.floor(value / 85);
    }
    text += digits.slice(0, chunk.length + 1).join('');
  }
  // a line break every 64 characters, which the filter ignores as white space
  return lat(`${text.replace(/(.{64})/g, '$1\n')}~>`);
}

const asciiHex = (data) => lat(`${data.toString('hex').replace(/(.{64})/g, '$1\n')}>`);

function runLength(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    let run = 1;
    while (i + run < data.length && run < 128 && data[i + run] === data[i]) run += 1;
    if (run >= 2) {
      out.push(257 - run, data[i]);
      i += run;
      continue;
    }
    let end = i + 1;
    while (end < data.length && end - i < 128 && !(end + 1 < data.length && data[end] === data[end + 1])) end += 1;
    out.push(end - i - 1, ...data.subarray(i, end));
    i = end;
  }
  out.push(128);
  return Buffer.from(out);
}

const ENCODERS = {
  FlateDecode: { name: 'FlateDecode', abbreviation: 'Fl', encode: flate },
  LZWDecode: { name: 'LZWDecode', abbreviation: 'LZW', encode: (d, parms) => lzw(d, parms?.EarlyChange ?? 1) },
  ASCII85Decode: { name: 'ASCII85Decode', abbreviation: 'A85', encode: ascii85 },
  ASCIIHexDecode: { name: 'ASCIIHexDecode', abbreviation: 'AHx', encode: asciiHex },
  RunLengthDecode: { name: 'RunLengthDecode', abbreviation: 'RL', encode: runLength },
};

// ---------------------------------------------------------------------------------------------------------------------
// Predictors (applied to the data before the compression filter)

const rowBytes = ({ Columns = 1, Colors = 1, BitsPerComponent = 8 }) => Math.ceil((Columns * Colors * BitsPerComponent) / 8);

function tiffPredictor(data, parms) {
  const { Columns = 1, Colors = 1, BitsPerComponent: bpc = 8 } = parms;
  const row = rowBytes(parms);
  const out = Buffer.alloc(data.length);
  const mask = (1 << bpc) - 1;
  const samples = Columns * Colors;
  const read = (buf, at, index) => {
    if (bpc === 8) return buf[at + index];
    if (bpc === 16) return (buf[at + index * 2] << 8) | buf[at + index * 2 + 1];
    const bit = index * bpc;
    return (buf[at + (bit >> 3)] >> (8 - bpc - (bit & 7))) & mask;
  };
  const write = (buf, at, index, value) => {
    if (bpc === 8) buf[at + index] = value;
    else if (bpc === 16) {
      buf[at + index * 2] = value >> 8;
      buf[at + index * 2 + 1] = value & 0xff;
    } else {
      const bit = index * bpc;
      buf[at + (bit >> 3)] |= value << (8 - bpc - (bit & 7));
    }
  };
  for (let at = 0; at < data.length; at += row) {
    for (let s = 0; s < samples; s += 1) {
      const value = read(data, at, s);
      const left = s >= Colors ? read(data, at, s - Colors) : 0;
      write(out, at, s, (value - left) & (bpc === 16 ? 0xffff : mask));
    }
  }
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** PNG predictor: tag byte + filtered row. Predictor 10..14 use tag 0..4 for every row, 15 cycles through all five. */
function pngPredictor(data, parms, predictor) {
  const row = rowBytes(parms);
  const bpp = Math.max(1, Math.ceil(((parms.Colors ?? 1) * (parms.BitsPerComponent ?? 8)) / 8));
  const rows = data.length / row;
  const out = Buffer.alloc(rows * (row + 1));
  for (let r = 0; r < rows; r += 1) {
    const tag = predictor === 15 ? r % 5 : predictor - 10;
    out[r * (row + 1)] = tag;
    for (let i = 0; i < row; i += 1) {
      const x = data[r * row + i];
      const a = i >= bpp ? data[r * row + i - bpp] : 0;
      const b = r > 0 ? data[(r - 1) * row + i] : 0;
      const c = r > 0 && i >= bpp ? data[(r - 1) * row + i - bpp] : 0;
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][tag];
      out[r * (row + 1) + 1 + i] = (x - predicted) & 0xff;
    }
  }
  return out;
}

const withPredictor = (data, parms) => {
  if (!parms?.Predictor || parms.Predictor === 1) return data;
  const padded = Buffer.concat([data, Buffer.alloc((rowBytes(parms) - (data.length % rowBytes(parms))) % rowBytes(parms), 0x20)]);
  return parms.Predictor === 2 ? tiffPredictor(padded, parms) : pngPredictor(padded, parms, parms.Predictor);
};

// ---------------------------------------------------------------------------------------------------------------------
// The text every case carries

const LINES = [
  'Codec check line one: the quick brown fox',
  'Line two 0123456789 (parentheses) and a \\ backslash',
  'Third line ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz',
  'Fourth line with repeated words words words words words words',
  'Fifth line: sequence 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18',
  'Sixth and last line of the short document',
];
const escapeText = (line) => line.replace(/([()\\])/g, '\\$1');
// Text off the page is not extracted, so the page is as tall as its lines need.
const pageHeightFor = (lines) => Math.max(792, 40 + lines.length * 14);
const contentFor = (lines) => lat(lines.map((line, i) => `BT /F1 12 Tf 40 ${pageHeightFor(lines) - 32 - i * 14} Td (${escapeText(line)}) Tj ET`).join('\n') + '\n');

// A long text (words from a fixed generator) so LZW fills its table and clears it.
function longLines() {
  let seed = 20260304;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed >>> 8;
  };
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa'];
  return Array.from({ length: 700 }, (_, i) => `line ${i + 1}: ${Array.from({ length: 9 }, () => words[next() % words.length]).join(' ')} ${next() % 100000}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Cases: filters and predictors

async function filterCases(tree) {
  const PDFLib = createRequire(join(tree, 'package.json'))('pdf-lib');
  const { PDFDocument, StandardFonts, PDFName, PDFRawStream } = PDFLib;
  const cases = [];
  const build = async (name, lines, chain, group) => {
    // chain: [{filter: key, abbreviated?: bool, parms?: {...}}] in decoding order
    let bytes = contentFor(lines);
    for (const link of [...chain].reverse()) bytes = ENCODERS[link.filter].encode(withPredictor(bytes, link.parms), link.parms);
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, pageHeightFor(lines)]);
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    const names = chain.map((link) => (link.abbreviated ? ENCODERS[link.filter].abbreviation : ENCODERS[link.filter].name));
    const parms = chain.map((link) => (link.parms ? { ...link.parms } : null));
    const spec = { Filter: names.length === 1 ? names[0] : names };
    if (parms.some(Boolean)) spec.DecodeParms = parms.length === 1 ? parms[0] : parms;
    page.node.set(PDFName.of('Contents'), doc.context.register(PDFRawStream.of(doc.context.obj(spec), bytes)));
    cases.push({ name, group, bytes: Buffer.from(await doc.save({ useObjectStreams: false })), expected: lines, filters: chain.map((l) => ({ filter: l.abbreviated ? ENCODERS[l.filter].abbreviation : l.filter, parms: l.parms ?? null })) });
  };
  const one = (filter, extra = {}) => ({ filter, ...extra });
  await build('identity-no-filter', LINES, [], 'filter');
  for (const filter of Object.keys(ENCODERS)) {
    await build(`filter-${filter}`, LINES, [one(filter)], 'filter');
    await build(`filter-${filter}-abbreviated`, LINES, [one(filter, { abbreviated: true })], 'filter');
  }
  await build('filter-LZWDecode-early-change-0', LINES, [one('LZWDecode', { parms: { EarlyChange: 0 } })], 'filter');
  await build('filter-LZWDecode-early-change-1-explicit', LINES, [one('LZWDecode', { parms: { EarlyChange: 1 } })], 'filter');
  const chains = [
    ['ASCII85Decode', 'FlateDecode'],
    ['ASCIIHexDecode', 'FlateDecode'],
    ['ASCII85Decode', 'LZWDecode'],
    ['ASCIIHexDecode', 'LZWDecode'],
    ['ASCII85Decode', 'RunLengthDecode'],
    ['RunLengthDecode', 'FlateDecode'],
    ['ASCII85Decode', 'ASCIIHexDecode', 'FlateDecode'],
  ];
  for (const chain of chains) await build(`chain-${chain.map((c) => c.replace('Decode', '')).join('-')}`, LINES, chain.map((f) => one(f)), 'chain');
  const long = longLines();
  for (const filter of ['FlateDecode', 'LZWDecode', 'RunLengthDecode', 'ASCII85Decode']) await build(`long-${filter}`, long, [one(filter)], 'long');
  await build('long-LZWDecode-early-change-0', long, [one('LZWDecode', { parms: { EarlyChange: 0 } })], 'long');

  const layouts = {
    'c1-b8-w16': { Colors: 1, BitsPerComponent: 8, Columns: 16 },
    'c3-b8-w8': { Colors: 3, BitsPerComponent: 8, Columns: 8 },
    'c1-b16-w8': { Colors: 1, BitsPerComponent: 16, Columns: 8 },
    'c1-b1-w128': { Colors: 1, BitsPerComponent: 1, Columns: 128 },
  };
  for (const [layout, parms] of Object.entries(layouts)) {
    for (const predictor of [10, 11, 12, 13, 14, 15]) await build(`flate-predictor-${predictor}-${layout}`, LINES, [one('FlateDecode', { parms: { Predictor: predictor, ...parms } })], 'predictor');
  }
  for (const [label, parms] of Object.entries({
    'c1-b8-w16': layouts['c1-b8-w16'],
    'c3-b8-w8': layouts['c3-b8-w8'],
    'c1-b16-w8': layouts['c1-b16-w8'],
    'c1-b1-w128': layouts['c1-b1-w128'],
    'c1-b2-w32': { Colors: 1, BitsPerComponent: 2, Columns: 32 },
    'c1-b4-w16': { Colors: 1, BitsPerComponent: 4, Columns: 16 },
  })) {
    await build(`flate-predictor-2-${label}`, LINES, [one('FlateDecode', { parms: { Predictor: 2, ...parms } })], 'predictor');
  }
  await build('flate-predictor-12-default-parms', LINES, [one('FlateDecode', { parms: { Predictor: 12 } })], 'predictor');
  await build('flate-predictor-1-none', LINES, [one('FlateDecode', { parms: { Predictor: 1 } })], 'predictor');
  for (const early of [1, 0]) {
    for (const predictor of [2, 12, 15]) {
      await build(`lzw-early-${early}-predictor-${predictor}-c1-b8-w16`, LINES, [one('LZWDecode', { parms: { EarlyChange: early, Predictor: predictor, ...layouts['c1-b8-w16'] } })], 'predictor');
    }
  }
  await build('long-flate-predictor-15-c3-b8-w64', long, [one('FlateDecode', { parms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 64 } })], 'predictor');
  await build('chain-A85-flate-predictor-14', LINES, [one('ASCII85Decode'), one('FlateDecode', { parms: { Predictor: 14, ...layouts['c1-b8-w16'] } })], 'chain');
  return cases;
}

// ---------------------------------------------------------------------------------------------------------------------
// Standard security handler

const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();
const sha = (algorithm, ...parts) => createHash(algorithm).update(Buffer.concat(parts)).digest();

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const padded = (password) => Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k += 1) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    [s[a], s[b]] = [s[b], s[a]];
    out[k] = data[k] ^ s[(s[a] + s[b]) & 0xff];
  }
  return out;
}

const aesCbc = (size, key, iv, data, { pad = true } = {}) => {
  const cipher = createCipheriv(`aes-${size}-cbc`, key, iv);
  cipher.setAutoPadding(pad);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};
const aesEcb = (key, data) => {
  const cipher = createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

const le32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
};
const IV = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const FILE_ID = Buffer.from('5c6a9d1e2b3f40718293a4b5c6d7e8f9', 'hex');
const PERMISSIONS = -3904;

/** ISO 32000-2 algorithm 2.B (revision 6 hash). */
function hash2B(password, salt, udata) {
  let k = sha('sha256', password, salt, udata);
  for (let round = 0; ; round += 1) {
    const k1 = Buffer.concat(Array.from({ length: 64 }, () => Buffer.concat([password, k, udata])));
    const e = aesCbc(128, k.subarray(0, 16), k.subarray(16, 32), k1, { pad: false });
    const mod = e.subarray(0, 16).reduce((sum, byte) => sum + byte, 0) % 3;
    k = sha(['sha256', 'sha384', 'sha512'][mod], e);
    if (round >= 63 && e[e.length - 1] <= round - 31) break;
  }
  return k.subarray(0, 32);
}

/**
 * The encryption of one file. Returns `{ dict, encryptStream(num, data), trailerExtra }`: `dict` is the Encrypt
 * dictionary body, `encryptStream` encrypts a stream's bytes for object `num` (generation 0).
 */
function securityHandler({ kind, userPassword, ownerPassword }) {
  const user = Buffer.from(userPassword, 'utf8');
  const owner = Buffer.from(ownerPassword, 'utf8');
  const hex = (b) => `<${b.toString('hex')}>`;
  if (kind === 'rc4-40' || kind === 'rc4-128' || kind === 'aesv2') {
    const revision = kind === 'rc4-40' ? 2 : kind === 'rc4-128' ? 3 : 4;
    const length = kind === 'rc4-40' ? 5 : 16;
    // algorithm 3: O
    let ownerKey = md5(padded(ownerPassword));
    if (revision >= 3) for (let i = 0; i < 50; i += 1) ownerKey = md5(ownerKey);
    ownerKey = ownerKey.subarray(0, length);
    let o = rc4(ownerKey, padded(userPassword));
    if (revision >= 3) for (let i = 1; i <= 19; i += 1) o = rc4(Buffer.from(ownerKey.map((byte) => byte ^ i)), o);
    // algorithm 2: the file key
    let key = md5(padded(userPassword), o, le32(PERMISSIONS), FILE_ID);
    if (revision >= 3) for (let i = 0; i < 50; i += 1) key = md5(key.subarray(0, length));
    key = key.subarray(0, length);
    // algorithms 4 and 5: U
    let u;
    if (revision === 2) u = rc4(key, PAD);
    else {
      u = rc4(key, md5(PAD, FILE_ID));
      for (let i = 1; i <= 19; i += 1) u = rc4(Buffer.from(key.map((byte) => byte ^ i)), u);
      u = Buffer.concat([u, Buffer.alloc(16)]);
    }
    const objectKey = (num) => md5(key, Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0]), ...(kind === 'aesv2' ? [Buffer.from('sAlT')] : [])).subarray(0, Math.min(length + 5, 16));
    const base = `/Filter /Standard /O ${hex(o)} /U ${hex(u)} /P ${PERMISSIONS}`;
    const dict =
      kind === 'rc4-40'
        ? `<< ${base} /V 1 /R 2 >>`
        : kind === 'rc4-128'
          ? `<< ${base} /V 2 /R 3 /Length 128 >>`
          : `<< ${base} /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF >>`;
    return {
      dict,
      encryptStream: (num, data) => (kind === 'aesv2' ? Buffer.concat([IV, aesCbc(128, objectKey(num), IV, data)]) : rc4(objectKey(num), data)),
    };
  }
  // AESV3: a constant file key; the user and owner entries wrap it
  const revision = kind === 'aesv3-r5' ? 5 : 6;
  const fileKey = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf', 'hex');
  const hashOf = (password, salt, udata) => (revision === 5 ? sha('sha256', password, salt, udata) : hash2B(password, salt, udata));
  const uValidation = Buffer.from('0102030405060708', 'hex');
  const uKeySalt = Buffer.from('1112131415161718', 'hex');
  const oValidation = Buffer.from('2122232425262728', 'hex');
  const oKeySalt = Buffer.from('3132333435363738', 'hex');
  const u = Buffer.concat([hashOf(user, uValidation, Buffer.alloc(0)), uValidation, uKeySalt]);
  const ue = aesCbc(256, hashOf(user, uKeySalt, Buffer.alloc(0)), Buffer.alloc(16), fileKey, { pad: false });
  const o = Buffer.concat([hashOf(owner, oValidation, u), oValidation, oKeySalt]);
  const oe = aesCbc(256, hashOf(owner, oKeySalt, u), Buffer.alloc(16), fileKey, { pad: false });
  const perms = aesEcb(fileKey, Buffer.concat([le32(PERMISSIONS), Buffer.from('ffffffff', 'hex'), Buffer.from('Tadb'), Buffer.from('01020304', 'hex')]));
  return {
    dict: `<< /Filter /Standard /V 5 /R ${revision} /Length 256 /P ${PERMISSIONS} /O ${hex(o)} /U ${hex(u)} /OE ${hex(oe)} /UE ${hex(ue)} /Perms ${hex(perms)} /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF >>`,
    encryptStream: (_num, data) => Buffer.concat([IV, aesCbc(256, fileKey, IV, data)]),
  };
}

const ENCRYPTION_KINDS = ['rc4-40', 'rc4-128', 'aesv2', 'aesv3-r6', 'aesv3-r5'];

function encryptedPdf(handler) {
  const encrypted = handler.encryptStream(4, flate(contentFor(ENCRYPTED_LINES)));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    Buffer.concat([lat(`<< /Filter /FlateDecode /Length ${encrypted.length} >>\nstream\n`), encrypted, lat('\nendstream')]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    handler.dict,
  ];
  return rawPdf(objects, { trailerExtra: `/Encrypt 6 0 R /ID [<${FILE_ID.toString('hex')}> <${FILE_ID.toString('hex')}>]` }).bytes;
}

const ENCRYPTED_LINES = ['Encrypted content line one', 'Second line: secret (text) 12345', 'Third line of the encrypted page'];

function encryptionCases() {
  const cases = [];
  for (const kind of ENCRYPTION_KINDS) {
    for (const [label, userPassword] of [['empty-user-password', ''], ['user-password', 'open sesame']]) {
      const ownerPassword = 'owner secret';
      const handler = securityHandler({ kind, userPassword, ownerPassword });
      const attempts = [
        { label: 'no-password', password: undefined },
        { label: 'user-password', password: userPassword },
        { label: 'owner-password', password: ownerPassword },
        { label: 'wrong-password', password: 'not the password' },
      ];
      // what the writer must achieve for pdf.js: opens with the user and the owner password, and with none when the user password is empty; a wrong password is refused
      const mustOpen = { 'no-password': userPassword === '', 'user-password': true, 'owner-password': true, 'wrong-password': false };
      cases.push({ name: `encrypted-${kind}-${label}`, group: 'encryption', bytes: encryptedPdf(handler), attempts, mustOpen, expected: ENCRYPTED_LINES });
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------------------------------------------------

const errorOf = (error) => ({ code: error?.code ?? null, message: String(error?.message ?? error), name: error?.name ?? null });

async function attempt(engine, bytes, password) {
  let pdf;
  try {
    pdf = await engine.open(bytes, password === undefined || password === '' ? {} : { password });
  } catch (error) {
    return { opened: false, error: errorOf(error) };
  }
  try {
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    return { opened: true, numPages: pdf.numPages, strings: content.items.map((item) => item.str) };
  } catch (error) {
    return { opened: true, numPages: pdf.numPages, pageError: errorOf(error) };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const readLines = (result) => (result.opened && result.strings ? result.strings.filter((s) => s !== '') : null);
const sameLines = (a, b) => a !== null && a.length === b.length && a.every((line, i) => line === b[i]);

async function main() {
  const { FIXTURES_ROOT, commitStage, parseArgs, productIdentity, resolveTree, stageSet, writeCanonicalJson, writeSetManifest, within } = await import('./lib/common.mjs');
  const { recorderProvenance } = await import('./lib/provenance.mjs');
  const args = parseArgs();
  const tree = resolveTree(args);
  const identity = productIdentity(tree);
  const engine = await pdfEngine(tree);
  const finalDir = join(FIXTURES_ROOT, SET);
  const corpus = [...(await filterCases(tree)), ...encryptionCases()];
  const stage = stageSet(finalDir, ['files', 'goldens']);
  mkdirSync(join(stage, 'files'), { recursive: true });
  mkdirSync(join(stage, 'goldens'), { recursive: true });
  const names = new Set();
  for (const entry of corpus) {
    if (names.has(entry.name)) throw new Error(`corpus name ${entry.name} is used twice`);
    names.add(entry.name);
    const attempts = entry.attempts ?? [{ label: 'no-password', password: undefined }];
    const results = [];
    for (const { label, password } of attempts) {
      const result = await within(`${entry.name} ${label}`, attempt(engine, entry.bytes, password), 300_000);
      if (entry.group !== 'encryption' || entry.mustOpen[label]) {
        if (!sameLines(readLines(result), entry.expected)) throw new Error(`${entry.name} (${label}): pdf.js read ${result.opened ? `${result.strings?.length ?? 0} strings, first ${JSON.stringify(result.strings?.slice(0, 2))}` : JSON.stringify(result).slice(0, 300)}, not the ${entry.expected.length} encoded lines`);
      } else if (label === 'wrong-password' || label === 'no-password') {
        if (result.opened || ![1, 2].includes(result.error?.code)) throw new Error(`${entry.name} (${label}): expected a password exception, got ${JSON.stringify(result).slice(0, 300)}`);
      }
      results.push({ label, ...(password === undefined ? {} : { password }), ...result });
    }
    writeFileSync(join(stage, 'files', `${entry.name}.pdf`), entry.bytes);
    writeCanonicalJson(join(stage, 'goldens', `${entry.name}.json`), {
      name: entry.name,
      group: entry.group,
      file: `files/${entry.name}.pdf`,
      bytes: entry.bytes.length,
      expectedLines: entry.expected,
      ...(entry.filters ? { filters: entry.filters } : {}),
      attempts: results,
    });
  }
  writeSetManifest(stage, {
    set: SET,
    recorder: RECORDER,
    command: `node ${RECORDER} --tree <Node product tree with node_modules>`,
    extra: {
      cases: [...names].sort(),
      pdfEngine: { ...engine.versions, options: engine.options, openedBy: 'unpdf getDocumentProxy(new Uint8Array(buffer), {password?}) as attachments/pdf-extract.mjs inspectLoaded' },
      ...recorderProvenance(import.meta.url),
    },
    identity,
  });
  commitStage(stage, finalDir);
  console.log(`recorded ${SET}: ${corpus.length} files`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
