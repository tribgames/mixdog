#!/usr/bin/env node
// What src/runtime/office/pdf/pdf-draw.mjs does, for the Rust module mixdog_pdf::author (crates/mixdog-pdf/tests/twin_author_draw.rs
// replays it):
//   wrap       wrapText over text, a width and a measure: the lines, or the refusal. The measures are the Helvetica of pdf-lib and two
//              fixed ones (every code point one unit wide; code points above U+2E7F two units wide), so a line break never depends on
//              a font file
//   colors     color(value): the three channels, or the refusal
//   pageSizes  pageSize(properties): the size in points, or the refusal
//   rounding   round2(value)
//   images     embedImage(document, path) for PNG (RGB, grey, palette, with and without see-through pixels), JPEG (RGB, grey, CMYK), SVG
//              (sizes in several units, a viewBox only, a size nowhere, broken XML) and files that are neither, sniffed by extension and by
//              their first bytes: the size the page places the image at, the image object pdf-lib writes (its dictionary, and the decoded
//              bytes by hash) and its soft mask, or the refusal. `exact: false` marks a refusal whose text is a decoder's own (upng, libvips),
//              which the replay only requires to be a refusal (the SVG ones that name libxml or the root element, and a PNG that has its signature and nothing else).
// The fonts of the machine take no part: the SVG cases draw no text, and the font choice itself is the recording of office-embed.
//
//   node benchmarks/rust-core/recorders/record-office-author-draw.mjs --tree <product tree with node_modules>
//
// Output: native/core/fixtures/office-author-draw/golden.json (and MANIFEST.json). The product tree is only read.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const recorder = 'benchmarks/rust-core/recorders/record-office-author-draw.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-author-draw');
const stage = stageSet(finalDir, ['golden.json']);
const require = createRequire(join(tree, 'package.json'));
const { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream } = require('pdf-lib');
const sharp = require('sharp');
const draw = await importFrom(tree, 'src/runtime/office/pdf/pdf-draw.mjs');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const attempt = async (run) => {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// ---- wrapText ---------------------------------------------------------------------------------------------------------------

const MEASURES = {
  chars: { widthOfTextAtSize: (text, size) => [...text].length * size },
  wide: { widthOfTextAtSize: (text, size) => [...text].reduce((units, char) => units + (char.codePointAt(0) > 0x2e7f ? 2 : 1), 0) * size },
};
const helvetica = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);

const WRAPS = [
  ['supplementary', 'chars', 'A😀B𠀀C', 10, 20],
  ['spaces', 'chars', 'aa bb cc dd ee', 10, 50],
  ['newlines', 'chars', 'aa bb cc\r\n\r\ndd\nee', 10, 50],
  ['empty', 'chars', '', 10, 50],
  ['blank-lines', 'chars', '\n\n', 10, 50],
  ['tabs-and-runs', 'chars', 'a \t  b\t\tc', 10, 100],
  ['unspaced-run', 'chars', 'abcdefgh', 10, 30],
  ['long-word-after-words', 'chars', 'ab abcdefghij cd', 10, 40],
  ['narrower-than-a-character', 'chars', 'abc', 10, 5],
  ['units-sum', 'chars', '예산은 24억 원', 10, 90],
  ['units-date', 'chars', '결정은 10월 14일 투자심의에서 한다', 10, 120],
  ['units-fraction', 'chars', '전체의 3분의 1 이다', 10, 100],
  ['units-time', 'chars', '모임은 14시 30분 시작', 10, 90],
  ['units-sum-groups', 'chars', '절감 12만 6천 원 규모', 10, 100],
  ['runt-moves-a-word', 'chars', 'aaaa bbbb cccc dddd eeee ffff', 10, 190],
  ['runt-kept', 'chars', 'aaaa bbbb cccc dd', 10, 180],
  ['wide-prose', 'wide', '다음 분기 부산 허브 증설이 필요합니다', 10, 150],
  ['wide-cjk-run', 'wide', '東京都千代田区千代田一丁目一番一号', 10, 100],
  ['wide-url', 'wide', 'see https://example.com/a/very/long/path/that/never/ends now', 10, 120],
  ['helvetica-sentence', 'helvetica', 'The quick brown fox jumps over the lazy dog and keeps running', 12, 120],
  ['helvetica-run', 'helvetica', 'Supercalifragilisticexpialidocious_and_more', 12, 80],
  ['helvetica-uncovered', 'helvetica', 'Ω sign', 12, 80],
  ['helvetica-size', 'helvetica', 'one two three four five six', 8, 60],
];
const wrap = [];
for (const [name, measure, text, size, width] of WRAPS) {
  const font = measure === 'helvetica' ? helvetica : MEASURES[measure];
  const result = await attempt(() => draw.wrapText(text, font, size, width));
  wrap.push({ name, measure, text, size, width, ...(result.error === undefined ? { lines: result.value } : { error: result.error }) });
}

// ---- colours, page sizes, rounding --------------------------------------------------------------------------------------------

const colors = [];
for (const value of ['#FF8000', '00ff00', '', undefined, null, '#abc', 'zzzzzz', '##000000', ' 000000', '#0000000', 'AbCdEf', '#000']) {
  const result = await attempt(() => {
    const colour = draw.color(value);
    return [colour.red, colour.green, colour.blue];
  });
  colors.push({ value: value === undefined ? { undefined: true } : value, ...(result.error === undefined ? { rgb: result.value } : { error: result.error }) });
}

const pageSizes = [];
for (const properties of [
  {}, { pageSize: 'a4' }, { pageSize: 'A3' }, { pageSize: 'Letter', orientation: 'Landscape' }, { pageSize: 'legal', orientation: 'portrait' },
  { pageSize: 'tabloid', orientation: 'LANDSCAPE' }, { pageSize: [300, 200], orientation: 'landscape' }, { pageSize: [200, 300], orientation: 'landscape' },
  { pageSize: ['200', '300'] }, { pageSize: 'b5' }, { pageSize: [0, 5] }, { pageSize: [1, 2, 3] }, { pageSize: '' }, { pageSize: 0 }, { orientation: 'landscape' },
  { pageSize: 'a5', orientation: 5 },
]) {
  const result = await attempt(() => draw.pageSize(properties));
  pageSizes.push({ properties, ...(result.error === undefined ? { size: result.value } : { error: result.error }) });
}

const rounding = [1.005, 2.675, -0.004, 1.5, 0.125, 3, 1e-7, 123456.789, -1.995, 0.1 + 0.2].map((value) => ({ value, rounded: draw.round2(value) }));

// ---- images --------------------------------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'author-draw-'));
const grid = (width, height, channels, make) => {
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) for (let c = 0; c < channels; c += 1) data[(y * width + x) * channels + c] = make(x, y, c);
  return data;
};
const rgbGrid = grid(7, 5, 3, (x, y, c) => (x * 37 + y * 11 + c * 83) % 256);
const rgbaGrid = grid(6, 4, 4, (x, y, c) => (c === 3 ? (x + y) % 3 === 0 ? 0 : 128 + x * 20 : (x * 41 + y * 17 + c * 71) % 256));
const opaqueGrid = grid(6, 4, 4, (x, y, c) => (c === 3 ? 255 : (x * 41 + y * 17 + c * 71) % 256));
const greyGrid = grid(5, 5, 1, (x, y) => (x * 50 + y * 7) % 256);
const greyAlphaGrid = grid(4, 3, 2, (x, y, c) => (c === 1 ? 100 + x * 30 : y * 90));
const paletteGrid = grid(8, 8, 3, (x, y, c) => [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]][(x >> 1) % 4][c]);
const svg = (attributes, body = '<rect width="10" height="10" fill="#c00"/>') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`);

const png = (data, width, height, channels, options = {}) => sharp(data, { raw: { width, height, channels } }).png(options).toBuffer();
const jpeg = (data, width, height, channels, options = {}) => sharp(data, { raw: { width, height, channels } }).jpeg(options).toBuffer();

const IMAGES = [
  ['png-rgb', 'logo.png', await png(rgbGrid, 7, 5, 3)],
  ['png-rgba-see-through', 'logo.png', await png(rgbaGrid, 6, 4, 4)],
  ['png-rgba-opaque', 'logo.png', await png(opaqueGrid, 6, 4, 4)],
  ['png-grey', 'grey.png', await png(greyGrid, 5, 5, 1)],
  ['png-grey-alpha', 'grey-alpha.png', await png(greyAlphaGrid, 4, 3, 2)],
  ['png-palette', 'palette.png', await png(paletteGrid, 8, 8, 3, { palette: true, colours: 4 })],
  ['png-upper-extension', 'LOGO.PNG', await png(rgbGrid, 7, 5, 3)],
  ['png-no-extension', 'logo', await png(rgbGrid, 7, 5, 3)],
  ['png-as-dat', 'logo.dat', await png(rgbGrid, 7, 5, 3)],
  ['jpeg-rgb', 'photo.jpg', await jpeg(rgbGrid, 7, 5, 3)],
  ['jpeg-jpeg-extension', 'photo.JPEG', await jpeg(rgbGrid, 7, 5, 3)],
  ['jpeg-grey', 'photo.jpg', await jpeg(greyGrid, 5, 5, 1)],
  ['jpeg-cmyk', 'photo.jpg', await sharp(rgbGrid, { raw: { width: 7, height: 5, channels: 3 } }).toColourspace('cmyk').jpeg().toBuffer()],
  ['jpeg-no-extension', 'photo', await jpeg(rgbGrid, 7, 5, 3)],
  ['jpeg-progressive', 'photo.jpg', await jpeg(rgbGrid, 7, 5, 3, { progressive: true })],
  ['svg-px', 'logo.svg', svg('width="40" height="20"')],
  ['svg-view-box-only', 'logo.svg', svg('viewBox="0 0 24 12"')],
  ['svg-inches', 'logo.svg', svg('width="1in" height="0.5in"')],
  ['svg-points', 'logo.svg', svg('width="100pt" height="50pt"')],
  ['svg-large', 'logo.svg', svg('width="3000" height="1500"')],
  ['svg-huge-density-cap', 'logo.svg', svg('width="1200" height="800"')],
  ['svg-tiny', 'logo.svg', svg('width="1" height="1"')],
  ['svg-sniffed', 'logo.dat', svg('width="16" height="8"')],
  ['svg-sniffed-upper', 'logo.dat', Buffer.from('<?xml version="1.0"?><SVG xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="4" height="4"/></SVG>'), false],
  ['svg-no-size', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
  ['svg-broken', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect'), false],
  ['svg-not-svg', 'logo.svg', Buffer.from('hello')],
  ['text-file', 'notes.txt', Buffer.from('hello world')],
  ['empty-txt', 'empty.txt', Buffer.alloc(0)],
  ['gif-file', 'anim.gif', Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;', 'latin1')],
  ['empty-png', 'empty.png', Buffer.alloc(0)],
  ['garbage-png', 'garbage.png', Buffer.from('this is not a png at all')],
  ['jpeg-as-png', 'photo.png', await jpeg(rgbGrid, 7, 5, 3)],
  ['png-signature-only', 'signature.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), false],
  ['png-as-jpg', 'logo.jpg', await png(rgbGrid, 7, 5, 3)],
  ['garbage-jpg', 'garbage.jpg', Buffer.from('this is not a jpeg at all')],
  ['truncated-jpg', 'cut.jpg', Buffer.from([0xff, 0xd8, 0xff])],
  ['soi-only-jpg', 'soi.jpg', Buffer.from([0xff, 0xd8])],
  ['no-frame-jpg', 'noframe.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9])],
  ['two-channel-jpg', 'two.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x02, 0, 0, 0, 0, 0, 0, 0, 0])],
  ['cut-frame-jpg', 'cutframe.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01])],
];

const streamOf = (context, object) => {
  const stream = object instanceof PDFRef ? context.lookup(object) : object;
  const filter = stream.dict.get(PDFName.of('Filter'));
  const bytes = filter?.toString() === '/DCTDecode' ? stream.contents : decodePDFRawStream(stream).decode();
  const dict = {};
  for (const [key, value] of stream.dict.entries()) {
    const name = key.decodeText();
    if (name === 'Length' || name === 'SMask') continue;
    dict[name] = value instanceof PDFNumber ? value.asNumber() : value.toString().replace(/^\//, '');
  }
  return { dict, length: bytes.length, sha256: sha(bytes) };
};

const images = [];
for (const [name, file, data, exact = true] of IMAGES) {
  const path = join(scratch, file);
  writeFileSync(path, data);
  const document = await PDFDocument.create();
  const result = await attempt(async () => {
    const embedded = await draw.embedImage(document, path);
    await embedded.image.embed();
    const context = document.context;
    const object = context.lookup(embedded.image.ref);
    const smask = object.dict.get(PDFName.of('SMask'));
    return { width: embedded.width, height: embedded.height, image: streamOf(context, object), smask: smask ? streamOf(context, smask) : null };
  });
  images.push({
    name,
    file,
    data: data.toString('base64'),
    ...(result.error === undefined ? result.value : { error: result.error.split(path).join('<file>'), exact }),
  });
}
rmSync(scratch, { recursive: true, force: true });

writeJson(join(stage, 'golden.json'), {
  note: 'Recorded from src/runtime/office/pdf/pdf-draw.mjs (pdf-lib 1.17.1, sharp); tests/twin_author_draw.rs replays it.',
  wrap,
  colors,
  pageSizes,
  rounding,
  images,
});
writeSetManifest(stage, { set: 'office-author-draw', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
