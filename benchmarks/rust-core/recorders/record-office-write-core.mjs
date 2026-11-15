#!/usr/bin/env node
// What pdf-lib 1.17.1 does to a document the way the Node office PDF code drives it (src/runtime/office/pdf/
// pdf-edit-document.mjs loads with updateMetadata:false and ignoreEncryption, pdf-writer.mjs applies document
// properties, pdf-draw.mjs saves with useObjectStreams:true), for the Rust crate mixdog-pdf
// (crates/mixdog-pdf/tests/twin_write_core.rs replays it):
//   cases  a document (made by pdf-lib, or written by hand: a page tree that inherits its boxes and rotation, a file
//          without an Info dictionary, one with a Producer, an RC4-encrypted file locked by an owner password), the
//          operations applied to it (add a page, set the document properties) and, for each of the two save forms
//          (classic table, object streams with a cross-reference stream), the bytes pdf-lib wrote and a structural
//          summary pdf-lib reads back from them: page count, the five boxes and the rotation of every page, the Info
//          strings, the number of objects and whether the file is encrypted.
//
//   node benchmarks/rust-core/recorders/record-office-write-core.mjs --tree <product tree with node_modules>
//   node benchmarks/rust-core/recorders/record-office-write-core.mjs --tree <tree> --verify <dir>
//
// Output: native/core/fixtures/office-write-core/golden.json (and its MANIFEST.json). With --verify the recorder only
// prints, as JSON on standard output, the summary pdf-lib reads from every .pdf file in <dir> (the live test has
// pdf-lib open what the Rust writer wrote). The product tree is only read.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const require = createRequire(join(tree, 'package.json'));
const { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, degrees } = require('pdf-lib');

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const rect = ({ x, y, width, height }) => [x, y, width, height];

const infoText = (document, key) => {
  const info = document.context.lookup(document.context.trailerInfo.Info);
  if (!(info instanceof PDFDict)) return null;
  const value = info.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : null;
};

// The facts the office code observes, read from a document pdf-lib has open.
const summarize = (document) => ({
  pageCount: document.getPageCount(),
  pages: document.getPages().map((page) => ({
    mediaBox: rect(page.getMediaBox()),
    cropBox: rect(page.getCropBox()),
    bleedBox: rect(page.getBleedBox()),
    trimBox: rect(page.getTrimBox()),
    artBox: rect(page.getArtBox()),
    rotation: page.getRotation().angle,
  })),
  info: {
    title: infoText(document, 'Title'),
    author: infoText(document, 'Author'),
    subject: infoText(document, 'Subject'),
    keywords: infoText(document, 'Keywords'),
  },
  objectCount: document.context.enumerateIndirectObjects().length,
  encrypted: document.isEncrypted,
});

const openedForReading = (bytes) => PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });

if (args.has('verify')) {
  const directory = args.get('verify');
  const summaries = {};
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.pdf')).sort()) {
    summaries[name] = summarize(await openedForReading(readFileSync(join(directory, name))));
  }
  process.stdout.write(`${JSON.stringify(summaries)}\n`);
  process.exit(0);
}

const recorder = 'benchmarks/rust-core/recorders/record-office-write-core.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-write-core');
const stage = stageSet(finalDir);
const { applyDocumentProperties } = await importFrom(tree, 'src/runtime/office/pdf/pdf-writer.mjs');

// ---- files written by hand ------------------------------------------------------------------------------------------
// objects: [[number, body]] where a body is a string or a Buffer; the file gets a classic table over them.
const handWritten = (objects, trailerEntries) => {
  const parts = [Buffer.from('%PDF-1.4\n')];
  let length = parts[0].length;
  const offsets = new Map();
  for (const [number, body] of objects) {
    offsets.set(number, length);
    const piece = Buffer.concat([Buffer.from(`${number} 0 obj\n`), Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n')]);
    parts.push(piece);
    length += piece.length;
  }
  const size = Math.max(...offsets.keys()) + 1;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let number = 1; number < size; number += 1) {
    table += offsets.has(number) ? `${String(offsets.get(number)).padStart(10, '0')} 00000 n \n` : '0000000000 00000 f \n';
  }
  parts.push(Buffer.from(`${table}trailer\n<< /Size ${size} ${trailerEntries} >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
};

const inheriting = () =>
  handWritten(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 3 /MediaBox [0 0 300 400] /Rotate 180 >>'],
      [3, '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R 6 0 R] /Count 2 /CropBox [5 5 295 395] >>'],
      [4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] >>'],
      [5, '<< /Type /Page /Parent 3 0 R >>'],
      [6, '<< /Type /Page /Parent 3 0 R /Rotate 270 /MediaBox 7 0 R /BleedBox [1 2 49 58] >>'],
      [7, '[0 0 50 60]'],
    ],
    '/Root 1 0 R'
  );

const withProducer = () =>
  handWritten(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'],
      [4, '<< /Title (Plain \\(title\\)) /Producer (Tool 1.0) /CreationDate (D:20200101000000Z) /Author <FEFF00420062> >>'],
    ],
    '/Root 1 0 R /Info 4 0 R'
  );

// RC4 with a 40-bit key (V 1, R 2), an empty user password and an owner password: the file opens without a password
// and carries permission flags that lock editing.
const md5 = (...chunks) => createHash('md5').update(Buffer.concat(chunks)).digest();
const rc4 = (key, data) => {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + key[i % key.length]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let at = 0; at < data.length; at += 1) {
    a = (a + 1) & 255;
    b = (b + state[a]) & 255;
    [state[a], state[b]] = [state[b], state[a]];
    out[at] = data[at] ^ state[(state[a] + state[b]) & 255];
  }
  return out;
};
const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const ownerLocked = () => {
  const padded = (password) => Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);
  const fileId = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const permissions = -3904;
  const O = rc4(md5(padded('owner')).subarray(0, 5), padded(''));
  const P = Buffer.alloc(4);
  P.writeInt32LE(permissions);
  const key = md5(padded(''), O, P, fileId).subarray(0, 5);
  const U = rc4(key, PAD);
  const objectKey = (number) => md5(key, Buffer.from([number & 255, (number >> 8) & 255, (number >> 16) & 255, 0, 0])).subarray(0, 10);
  const seal = (number, bytes) => rc4(objectKey(number), bytes);
  const hex = (bytes) => bytes.toString('hex');
  const content = seal(6, Buffer.from('BT /F1 12 Tf 72 720 Td (Locked) Tj ET', 'latin1'));
  const title = seal(4, Buffer.from('Sealed title', 'latin1'));
  const author = seal(4, Buffer.from('Sealed author', 'latin1'));
  return handWritten(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Contents 6 0 R >>'],
      [4, `<< /Title <${hex(title)}> /Author <${hex(author)}> >>`],
      [5, `<< /Filter /Standard /V 1 /R 2 /O <${hex(O)}> /U <${hex(U)}> /P ${permissions} >>`],
      [6, Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]).toString('latin1')],
    ],
    `/Root 1 0 R /Info 4 0 R /Encrypt 5 0 R /ID [<${hex(fileId)}> <${hex(fileId)}>]`
  );
};

// ---- documents made by pdf-lib ---------------------------------------------------------------------------------------
const FIXED_TIME = new Date(0);
const made = async () => {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.addPage([612, 792]);
  const second = document.addPage([595.5, 842]);
  second.setRotation(degrees(90));
  const third = document.addPage([200, 300]);
  third.setCropBox(10, 10, 150, 250);
  third.setTrimBox(20, 20, 100, 200);
  document.setTitle('Quarterly 보고서');
  document.setAuthor('Ada');
  document.setSubject('Numbers');
  document.setKeywords(['alpha', 'beta']);
  return document;
};
const madeClassic = async () => Buffer.from(await (await made()).save({ useObjectStreams: false, addDefaultPage: false }));
const madeCompact = async () => Buffer.from(await (await made()).save({ useObjectStreams: true, addDefaultPage: false }));

// ---- cases -----------------------------------------------------------------------------------------------------------
const PROPERTIES = { title: 'Report — 한글 😀', author: 'Grace H.', subject: 'S (1) \\ 2', keywords: ['one', 'two words', 'three'] };
const cases = [
  { name: 'classic-unchanged', input: await madeClassic(), ops: [] },
  { name: 'classic-properties', input: await madeClassic(), ops: [{ op: 'properties', properties: PROPERTIES }] },
  { name: 'compact-properties', input: await madeCompact(), ops: [{ op: 'properties', properties: PROPERTIES }] },
  { name: 'compact-keywords-only', input: await madeCompact(), ops: [{ op: 'properties', properties: { keywords: ['solo'] } }] },
  { name: 'compact-creator', input: await madeCompact(), ops: [{ op: 'creator', value: 'Maker' }] },
  { name: 'compact-add-page', input: await madeCompact(), ops: [{ op: 'addPage', width: 300, height: 144 }] },
  { name: 'inherited-unchanged', input: inheriting(), ops: [] },
  { name: 'inherited-title-makes-info', input: inheriting(), ops: [{ op: 'properties', properties: { title: 'Made' } }] },
  { name: 'producer-kept', input: withProducer(), ops: [{ op: 'properties', properties: { author: 'New author' } }] },
  { name: 'created-empty', create: true, ops: [] },
  {
    name: 'created-with-pages',
    create: true,
    ops: [
      { op: 'addPage', width: 612, height: 792 },
      { op: 'addPage', width: 100, height: 50.5 },
      { op: 'properties', properties: PROPERTIES },
    ],
  },
  { name: 'encrypted-refused', input: ownerLocked(), ignoreEncryption: false, ops: [] },
  { name: 'encrypted-structure', input: ownerLocked(), ignoreEncryption: true, ops: [] },
  { name: 'encrypted-properties', input: ownerLocked(), ignoreEncryption: true, ops: [{ op: 'properties', properties: { title: 'Replaced' } }] },
];

const apply = (document, op) => {
  if (op.op === 'properties') applyDocumentProperties(document, op.properties);
  else if (op.op === 'creator') document.setCreator(op.value);
  else if (op.op === 'addPage') document.addPage([op.width, op.height]);
  else throw new Error(`unknown operation ${op.op}`);
};

const records = [];
for (const entry of cases) {
  const ignoreEncryption = entry.ignoreEncryption ?? false;
  const record = { name: entry.name, create: entry.create === true, ignoreEncryption, input: entry.input ? b64(entry.input) : null, ops: entry.ops };
  let document;
  if (entry.create) {
    document = await PDFDocument.create();
    document.setCreationDate(FIXED_TIME);
    document.setModificationDate(FIXED_TIME);
  } else {
    try {
      document = await PDFDocument.load(entry.input, { ignoreEncryption, updateMetadata: false });
    } catch (error) {
      if (!/is encrypted/i.test(String(error.message))) throw error;
      record.loadError = 'encrypted';
      records.push(record);
      continue;
    }
    record.inputSummary = summarize(document);
  }
  for (const op of entry.ops) apply(document, op);
  record.saves = {};
  for (const [form, useObjectStreams] of [['classic', false], ['objectStreams', true]]) {
    const bytes = Buffer.from(await document.save({ useObjectStreams, addDefaultPage: false }));
    record.saves[form] = {
      pdf: b64(bytes),
      packsObjects: bytes.includes('/ObjStm'),
      summary: summarize(await openedForReading(bytes)),
    };
  }
  records.push(record);
}

writeJson(join(stage, 'golden.json'), { cases: records });
writeSetManifest(stage, { set: 'office-write-core', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
