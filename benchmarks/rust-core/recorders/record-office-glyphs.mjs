#!/usr/bin/env node
// The glyph paths pdf.js draws in Node, for the Rust crate mixdog-pdf (crates/mixdog-pdf/tests/twin_glyphs.rs replays):
// pdf.js 6.4.299 renders with `disableFontFace` (Node's default) and `useSystemFonts: false`, which sends every drawn
// glyph as a `FontPath` (the commands of `font.renderer.getPath`, a Float32Array of operator and coordinate words) and
// keeps the font program it drew from (`fontExtraProperties: true` keeps `font.data`, the sanitised OpenType file the
// renderer reads: glyf outlines for the Liberation Sans substitutes, a CFF table, the Foxit files being bare CFF).
//
// Fixture: one page that sets each of the standard 14 fonts below with no font file, so pdf.js substitutes its bundled
// standard font (`standardFontDataUrl`), and shows Latin text, accented letters and symbols through it. Recorded per
// font, in the order pdf.js sent them: the program's file (fonts/<name>.otf, the bytes pdf.js handed to its renderer),
// its font matrix, the standard font file it came from, and for every glyph pdf.js sent the character and its path.
//
// Paths are recorded as Float32 words: `Float16Array` is removed before pdf.js loads (`FeatureTest.isFloat16ArraySupported`
// is then false) so the path keeps the 32-bit values the renderer computes; the manifest says whether this Node has
// Float16Array.
//
//   node benchmarks/rust-core/recorders/record-office-glyphs.mjs --tree <product tree with node_modules>
//
// Output: native/core/fixtures/office-glyphs/ (golden.json, fonts/, and its MANIFEST.json). The product tree is only read.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const recorder = 'benchmarks/rust-core/recorders/record-office-glyphs.mjs';
const float16Available = typeof globalThis.Float16Array !== 'undefined';
delete globalThis.Float16Array;

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-glyphs');
const stage = stageSet(finalDir);
mkdirSync(join(stage, 'fonts'), { recursive: true });

// ---- the fixture document ------------------------------------------------------------------------------------------

const WIN_ANSI_TEXT = 'The quick brown fox jumps over the lazy dog 0123456789 !?@#$%&*() \\351\\350\\344\\366\\374\\361\\347\\305\\311 \\256\\251\\231 \\225';
const FONTS = [
  { base: 'Helvetica', encoding: 'WinAnsiEncoding', text: WIN_ANSI_TEXT, standardFile: 'LiberationSans-Regular.ttf' },
  { base: 'Helvetica-BoldOblique', encoding: 'WinAnsiEncoding', text: 'Bold oblique Hamburgefonstiv 0123456789 \\351\\374', standardFile: 'LiberationSans-BoldItalic.ttf' },
  { base: 'Times-Roman', encoding: 'WinAnsiEncoding', text: WIN_ANSI_TEXT, standardFile: 'FoxitSerif.pfb' },
  { base: 'Times-Italic', encoding: 'WinAnsiEncoding', text: 'Italic ligatures fi fl \\256 and accents \\351\\350\\344\\366\\374\\361\\347', standardFile: 'FoxitSerifItalic.pfb' },
  { base: 'Courier-Bold', encoding: 'WinAnsiEncoding', text: 'Courier bold 0123456789 \\351\\374 {}[]<>', standardFile: 'FoxitFixedBold.pfb' },
  { base: 'Symbol', encoding: null, text: 'abcdefghijklmnop ABCDEFGHIJKLMNOP 0123456789 \\245\\256\\345', standardFile: 'FoxitSymbol.pfb' },
  { base: 'ZapfDingbats', encoding: null, text: '!"#$%&\\047() abcdefghijklmnop ABCDEFGHIJKLMNOP 0123456789', standardFile: 'FoxitDingbats.pfb' },
];

function buildPdf() {
  const content = FONTS.map((font, i) => `BT /F${i + 1} 14 Tf 20 ${760 - i * 40} Td (${font.text}) Tj ET`).join('\n');
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << ${FONTS.map((_, i) => `/F${i + 1} ${5 + i} 0 R`).join(' ')} >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    ...FONTS.map((font) => `<< /Type /Font /Subtype /Type1 /BaseFont /${font.base}${font.encoding ? ` /Encoding /${font.encoding}` : ''} >>`),
  ];
  let out = '%PDF-1.7\n';
  const offsets = [];
  bodies.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---- pdf.js ----------------------------------------------------------------------------------------------------

const pdfjs = await importFrom(tree, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(tree, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
const pdfjsVersion = JSON.parse(readFileSync(join(tree, 'node_modules/pdfjs-dist/package.json'), 'utf8')).version;
const standardFonts = `${join(tree, 'node_modules/pdfjs-dist/standard_fonts').split('\\').join('/')}/`;

const quiet = async (fn) => {
  const keep = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, keep);
  }
};

const loadingTask = pdfjs.getDocument({
  data: new Uint8Array(buildPdf()),
  standardFontDataUrl: standardFonts,
  useSystemFonts: false,
  disableFontFace: true,
  fontExtraProperties: true,
  isEvalSupported: false,
  verbosity: 0,
});
const doc = await quiet(() => loadingTask.promise);
const page = await quiet(() => doc.getPage(1));
await quiet(() => page.getOperatorList());

const fontObjects = [];
const pathObjects = new Map();
for (const [id, data] of page.commonObjs) {
  const at = id.indexOf('_path_');
  if (at >= 0) {
    const loadedName = id.slice(0, at);
    if (!pathObjects.has(loadedName)) pathObjects.set(loadedName, []);
    pathObjects.get(loadedName).push({ char: id.slice(at + '_path_'.length), path: Array.from(data.path) });
  } else if (data && typeof data === 'object' && 'loadedName' in data && data.data) {
    fontObjects.push(data);
  }
}
if (fontObjects.length !== FONTS.length) throw new Error(`expected ${FONTS.length} fonts, pdf.js sent ${fontObjects.length}`);

const tablesOf = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4);
  const tags = [];
  for (let i = 0, p = 12; i < count; i++, p += 16) tags.push(Buffer.from(bytes.subarray(p, p + 4)).toString('latin1'));
  return tags;
};

const fonts = FONTS.map((spec, i) => {
  const font = fontObjects[i];
  const bytes = Uint8Array.from(font.data);
  const tags = tablesOf(bytes);
  const cases = (pathObjects.get(font.loadedName) ?? []).map(({ char, path }) => ({ char, code: char.codePointAt(0), path }));
  if (cases.length === 0) throw new Error(`no glyph paths for ${spec.base}`);
  const file = `fonts/${spec.base}.otf`;
  writeFileSync(join(stage, file), bytes);
  return {
    name: spec.base,
    standardFile: spec.standardFile,
    kind: tags.includes('glyf') ? 'glyf' : 'cff',
    tables: tags,
    file,
    fontMatrix: font.fontMatrix ?? null,
    cases,
  };
});

writeJson(join(stage, 'golden.json'), { pdfjsVersion, float16Available, fonts });
writeSetManifest(stage, { set: 'office-glyphs', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree, extra: { pdfjsVersion, float16AvailableInRecordingNode: float16Available } });
commitStage(stage, finalDir);
await loadingTask.destroy();
