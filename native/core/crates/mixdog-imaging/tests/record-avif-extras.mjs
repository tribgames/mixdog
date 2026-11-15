// Record only against the original read-only Node product (node record-avif-extras.mjs C:/Project/mixdog).
// What sharp (libvips + libheif) answers to AVIF inputs the main image corpus does not hold: the box properties irot,
// imir, clap and colr, an HEIC (HEVC) buffer, corrupt AVIF files, and the AVIF that sharp writes back for a resized
// AVIF. Inputs are built here: sharp writes the plain AVIF files, and the property boxes are patched into the HEIF
// container by `addProperties` (sharp writes none of them itself). Output stays beside this script.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const tree = process.argv[2] || 'C:/Project/mixdog';
const require = createRequire(`${tree}/package.json`);
const sharp = require('sharp');
sharp.cache(false);
const { resizeImageBuffer } = await import(pathToFileURL(`${tree}/src/runtime/shared/read-image-resize.mjs`));

const W = 40;
const H = 30;

function picture(channels) {
  const raw = Buffer.alloc(W * H * channels);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * channels;
      raw[i] = x * 4;
      raw[i + 1] = y * 5;
      raw[i + 2] = (x * 7 + y * 3) & 255;
      if (channels === 4) raw[i + 3] = 40 + ((x * 3 + y * 2) % 200);
    }
  }
  return raw;
}

const fromRaw = (channels) => sharp(picture(channels), { raw: { width: W, height: H, channels } });

// ---- the container ---------------------------------------------------------------------------------------------
function child(buffer, start, end, type) {
  for (let at = start; at + 8 <= end;) {
    let size = buffer.readUInt32BE(at);
    if (size === 0) size = end - at;
    if (buffer.toString('latin1', at + 4, at + 8) === type) return { at, size };
    at += size;
  }
  throw new Error(`no ${type} box`);
}

/** Adds property boxes (each already a whole box) to the primary item: ipco gets them, ipma associates them, and
 *  every iloc offset moves by what the meta box grew. `essential` marks the transformative ones. */
function addProperties(file, boxes) {
  const meta = child(file, 0, file.length, 'meta');
  const metaBody = meta.at + 12;
  const iprp = child(file, metaBody, meta.at + meta.size, 'iprp');
  const ipco = child(file, iprp.at + 8, iprp.at + iprp.size, 'ipco');
  const ipma = child(file, iprp.at + 8, iprp.at + iprp.size, 'ipma');
  const pitm = child(file, metaBody, meta.at + meta.size, 'pitm');
  const primary = file.readUInt8(pitm.at + 8) === 0 ? file.readUInt16BE(pitm.at + 12) : file.readUInt32BE(pitm.at + 12);
  // The property count already in ipco.
  let existing = 0;
  for (let at = ipco.at + 8; at < ipco.at + ipco.size; at += file.readUInt32BE(at)) existing += 1;
  const added = Buffer.concat(boxes);
  // ipma
  const version = file.readUInt8(ipma.at + 8);
  const flags = file.readUIntBE(ipma.at + 9, 3);
  const wide = (flags & 1) === 1;
  const entries = file.readUInt32BE(ipma.at + 12);
  let at = ipma.at + 16;
  const pieces = [file.subarray(ipma.at, ipma.at + 16)];
  let grown = 0;
  for (let n = 0; n < entries; n += 1) {
    const idSize = version < 1 ? 2 : 4;
    const id = version < 1 ? file.readUInt16BE(at) : file.readUInt32BE(at);
    const count = file.readUInt8(at + idSize);
    const length = idSize + 1 + count * (wide ? 2 : 1);
    let entry = file.subarray(at, at + length);
    if (id === primary) {
      const extra = Buffer.alloc(boxes.length * (wide ? 2 : 1));
      boxes.forEach((box, index) => {
        const essential = ['irot', 'imir', 'clap'].includes(box.toString('latin1', 4, 8)) ? 1 : 0;
        const value = existing + 1 + index;
        if (wide) extra.writeUInt16BE((essential << 15) | value, index * 2);
        else extra.writeUInt8((essential << 7) | value, index);
      });
      entry = Buffer.concat([entry, extra]);
      entry.writeUInt8(count + boxes.length, idSize);
      grown += extra.length;
    }
    pieces.push(entry);
    at += length;
  }
  const newIpma = Buffer.concat(pieces);
  newIpma.writeUInt32BE(newIpma.length, 0);
  const newIpco = Buffer.concat([file.subarray(ipco.at, ipco.at + ipco.size), added]);
  newIpco.writeUInt32BE(newIpco.length, 0);
  const delta = added.length + grown;
  const iprpBody = Buffer.concat([file.subarray(iprp.at + 8, ipco.at), newIpco, file.subarray(ipco.at + ipco.size, ipma.at), newIpma, file.subarray(ipma.at + ipma.size, iprp.at + iprp.size)]);
  const newIprp = Buffer.concat([Buffer.alloc(8), iprpBody]);
  newIprp.write('iprp', 4, 'latin1');
  newIprp.writeUInt32BE(newIprp.length, 0);
  const metaPieces = [file.subarray(meta.at, iprp.at), newIprp, file.subarray(iprp.at + iprp.size, meta.at + meta.size)];
  let newMeta = Buffer.concat(metaPieces);
  newMeta.writeUInt32BE(newMeta.length, 0);
  // iloc: every extent offset moves by `delta` (the data lies after meta).
  const iloc = child(newMeta, 12, newMeta.length, 'iloc');
  let p = iloc.at + 8;
  const ilocVersion = newMeta.readUInt8(p);
  p += 4;
  const sizes = newMeta.readUInt16BE(p);
  p += 2;
  const [offsetSize, lengthSize, baseSize] = [(sizes >> 12) & 15, (sizes >> 8) & 15, (sizes >> 4) & 15];
  const indexSize = ilocVersion === 1 || ilocVersion === 2 ? sizes & 15 : 0;
  let itemCount;
  if (ilocVersion < 2) {
    itemCount = newMeta.readUInt16BE(p);
    p += 2;
  } else {
    itemCount = newMeta.readUInt32BE(p);
    p += 4;
  }
  const readN = (size, position) => (size === 0 ? 0 : size === 4 ? newMeta.readUInt32BE(position) : Number(newMeta.readBigUInt64BE(position)));
  const writeN = (size, position, value) => {
    if (size === 4) newMeta.writeUInt32BE(value, position);
    else if (size === 8) newMeta.writeBigUInt64BE(BigInt(value), position);
  };
  for (let item = 0; item < itemCount; item += 1) {
    p += ilocVersion < 2 ? 2 : 4;
    const method = ilocVersion === 1 || ilocVersion === 2 ? newMeta.readUInt16BE(p) & 15 : 0;
    if (ilocVersion === 1 || ilocVersion === 2) p += 2;
    p += 2;
    const base = readN(baseSize, p);
    if (baseSize > 0 && method === 0) writeN(baseSize, p, base + delta);
    p += baseSize;
    const extents = newMeta.readUInt16BE(p);
    p += 2;
    for (let e = 0; e < extents; e += 1) {
      p += indexSize;
      if (baseSize === 0 && method === 0) writeN(offsetSize, p, readN(offsetSize, p) + delta);
      p += offsetSize + lengthSize;
    }
  }
  return Buffer.concat([file.subarray(0, meta.at), newMeta, file.subarray(meta.at + meta.size)]);
}

const box = (type, body) => {
  const out = Buffer.alloc(8 + body.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  return out;
};
const irot = (angle) => box('irot', Buffer.from([angle]));
const imir = (axis) => box('imir', Buffer.from([axis]));
const clap = (...fields) => {
  const body = Buffer.alloc(32);
  fields.forEach((value, index) => body.writeUInt32BE(value, index * 4));
  return box('clap', body);
};
const nclx = (primaries, transfer, matrix, full) => {
  const body = Buffer.alloc(11);
  body.write('nclx', 0, 'latin1');
  body.writeUInt16BE(primaries, 4);
  body.writeUInt16BE(transfer, 6);
  body.writeUInt16BE(matrix, 8);
  body.writeUInt8(full ? 0x80 : 0, 10);
  return box('colr', body);
};
const iccBox = (profile) => box('colr', Buffer.concat([Buffer.from('prof', 'latin1'), profile]));

// ---- HEIC: a HEIF container whose one item is HEVC (sharp's libvips has no HEVC decoder, and none can be written) --
const full = (type, version, body) => box(type, Buffer.concat([Buffer.from([version, 0, 0, 0]), body]));
const u16 = (value) => Buffer.from([value >> 8, value & 255]);
const u32 = (value) => Buffer.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);

function hevcFile(brand, payload) {
  const hvcC = box('hvcC', Buffer.from([1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0]));
  const ispe = full('ispe', 0, Buffer.concat([u32(W), u32(H)]));
  const ipco = box('ipco', Buffer.concat([hvcC, ispe]));
  const ipma = full('ipma', 0, Buffer.concat([u32(1), u16(1), Buffer.from([2, 0x81, 0x02])]));
  const iprp = box('iprp', Buffer.concat([ipco, ipma]));
  const hdlr = full('hdlr', 0, Buffer.concat([u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(12), Buffer.from([0])]));
  const pitm = full('pitm', 0, u16(1));
  const infe = full('infe', 2, Buffer.concat([u16(1), u16(0), Buffer.from('hvc1', 'latin1'), Buffer.from([0])]));
  const iinf = full('iinf', 0, Buffer.concat([u16(1), infe]));
  const ftyp = box('ftyp', Buffer.concat([Buffer.from(brand, 'latin1'), u32(0), Buffer.from(brand, 'latin1'), Buffer.from('mif1', 'latin1')]));
  const ilocOf = (offset) => full('iloc', 0, Buffer.concat([Buffer.from([0x44, 0x00]), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(payload.length)]));
  const metaOf = (offset) => full('meta', 0, Buffer.concat([hdlr, pitm, ilocOf(offset), iinf, iprp]));
  const offset = ftyp.length + metaOf(0).length + 8;
  return Buffer.concat([ftyp, metaOf(offset), box('mdat', payload)]);
}

// ---- the recording ---------------------------------------------------------------------------------------------
async function raw(buffer) {
  try {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { ok: { width: info.width, height: info.height, rgba: data.toString('base64') } };
  } catch (error) {
    return { error: String(error.message) };
  }
}
/** The 32x32 area-averaged RGBA thumbnail of raw RGBA pixels, rounded: the rule of the main corpus's recorder. */
function thumbnail(rgba, width, height) {
  const size = 32;
  const out = Buffer.alloc(size * size * 4);
  for (let cy = 0; cy < size; cy += 1) {
    const y0 = Math.floor((cy * height) / size);
    const y1 = Math.min(height, Math.max(Math.floor(((cy + 1) * height) / size), y0 + 1));
    for (let cx = 0; cx < size; cx += 1) {
      const x0 = Math.floor((cx * width) / size);
      const x1 = Math.min(width, Math.max(Math.floor(((cx + 1) * width) / size), x0 + 1));
      const sums = [0, 0, 0, 0];
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) for (let c = 0; c < 4; c += 1) sums[c] += rgba[(y * width + x) * 4 + c];
      const count = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < 4; c += 1) out[(cy * size + cx) * 4 + c] = Math.round(sums[c] / count);
    }
  }
  return out;
}
async function meta(buffer) {
  try {
    const m = await sharp(buffer).metadata();
    return { ok: { format: m.format, width: m.width, height: m.height, hasAlpha: m.hasAlpha, orientation: m.orientation ?? null, hasProfile: m.hasProfile, space: m.space, depth: m.depth } };
  } catch (error) {
    return { error: String(error.message) };
  }
}
async function resized(buffer) {
  try {
    const r = await resizeImageBuffer(buffer, 'avif');
    if (!r) return { none: true };
    const bytes = Buffer.from(r.data, 'base64');
    const { data: pixels, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const m = await meta(bytes);
    return { ok: { mime: r.mimeType, dimensions: r.dimensions, byteLength: bytes.length, outputFormat: m.ok?.format, outputWidth: m.ok?.width, outputHeight: m.ok?.height, outputHasAlpha: m.ok?.hasAlpha, outputThumbnail: thumbnail(pixels, info.width, info.height).toString('base64') } };
  } catch (error) {
    return { error: String(error.message) };
  }
}

const opaque = await fromRaw(3).avif({ quality: 50 }).toBuffer();
const translucent = await fromRaw(4).avif({ quality: 50 }).toBuffer();
const p3 = await fromRaw(3).withIccProfile('p3').avif({ quality: 50 }).toBuffer();

const specimens = [
  ['plain', opaque],
  ['alpha', translucent],
  ['rotate90', addProperties(opaque, [irot(1)])],
  ['rotate180', addProperties(opaque, [irot(2)])],
  ['rotate270', addProperties(opaque, [irot(3)])],
  ['mirrorVertical', addProperties(opaque, [imir(0)])],
  ['mirrorHorizontal', addProperties(opaque, [imir(1)])],
  ['rotate90Mirror', addProperties(opaque, [irot(1), imir(0)])],
  ['rotate90Alpha', addProperties(translucent, [irot(1)])],
  ['crop', addProperties(opaque, [clap(32, 1, 24, 1, 0, 1, 0, 1)])],
  ['cropOffset', addProperties(opaque, [clap(30, 1, 20, 1, 2, 1, 0xfffffffd, 1)])],
  ['nclxBt709Full', addProperties(opaque, [nclx(1, 13, 1, true)])],
  ['nclxBt709Limited', addProperties(opaque, [nclx(1, 13, 1, false)])],
  ['nclxBt601Full', addProperties(opaque, [nclx(1, 13, 6, true)])],
  ['nclxBt2020', addProperties(opaque, [nclx(9, 16, 9, true)])],
  ['nclxIdentity', addProperties(opaque, [nclx(1, 13, 0, true)])],
  ['nclxDisplayP3Primaries', addProperties(opaque, [nclx(12, 13, 6, true)])],
  ['iccProfile', p3],
  ['heic', hevcFile('heic', Buffer.from('00000001402a00', 'hex'))],
  ['heicWithPayload', hevcFile('heic', Buffer.alloc(300, 0x41))],
  ['heix', hevcFile('heix', Buffer.alloc(300, 0x41))],
  ['truncatedHalf', opaque.subarray(0, Math.floor(opaque.length / 2))],
  ['truncatedPayload', opaque.subarray(0, opaque.length - 10)],
  ['truncatedInsideMeta', opaque.subarray(0, 100)],
  ['ftypOnly', opaque.subarray(0, 28)],
  ['ftypShort', opaque.subarray(0, 12)],
  ['noMdat', opaque.subarray(0, 242)],
  ['payloadDamaged', Buffer.concat([opaque.subarray(0, 250), Buffer.alloc(opaque.length - 250, 0xa5)])],
  ['payloadZero', Buffer.concat([opaque.subarray(0, 242), Buffer.alloc(8), Buffer.alloc(opaque.length - 250)])],
  ['brandOnlyMif1', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmif1\0\0\0\0mif1heic', 'latin1')])],
];

const rows = [];
for (const [name, bytes] of specimens) {
  rows.push({ name, input: bytes.toString('base64'), meta: await meta(bytes), raw: await raw(bytes), resize: await resized(bytes) });
}
const sizedUp = await sharp(picture(4), { raw: { width: W, height: H, channels: 4 } }).resize(120, 90).avif({ quality: 50 }).toBuffer();
rows.push({ name: 'alphaLarger', input: sizedUp.toString('base64'), meta: await meta(sizedUp), raw: await raw(sizedUp), resize: await resized(sizedUp) });
await writeFile(new URL('./avif-reference.json', import.meta.url), JSON.stringify({ sharp: sharp.versions, rows }, null, 1) + '\n');
