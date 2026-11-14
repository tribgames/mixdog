#!/usr/bin/env node
// PDF reader goldens (track nr-exthost, the corpus every PDF task replays): what Node's attachment intake gets from
// opening a PDF and reading its pages, with pdf.js exactly as `attachments/pdf-extract.mjs` configures it.
//
// pdf-extract.mjs calls `resolvedPdfJs()` (pdfjs-runtime.mjs: the tree's pdfjs-dist legacy build, worker from the same
// folder, handed to unpdf with `definePDFJSModule`) and then unpdf's `getDocumentProxy(new Uint8Array(buffer), {})` with
// no option of its own. unpdf 1.9.1 fills in `useSystemFonts: true` and, in Node, `disableFontFace: true`,
// `standardFontDataUrl` (pdfjs-dist/standard_fonts/), `cMapUrl` (pdfjs-dist/cmaps/) and `cMapPacked: true`. This
// recorder installs the same module into unpdf behind a one-line wrapper that keeps the parameters getDocument is
// called with, and refuses to record unless every one of those options is in effect.
//
// Recorded per file (native/core/fixtures/pdf-reader/goldens/<name>.json): the outcome of the open, `numPages`, and for
// every page its `view`, `rotate`, `userUnit`, the viewport at scale 1 (width, height, rotation, offsets, transform) and
// `getTextContent()` whole (items: str, dir, transform, width, height, fontName, hasEOL; styles), or the exception
// {name, code, message} where pdf.js throws. The bytes of every file are kept beside the goldens (files/<name>.pdf), so
// a replay opens the very bytes that were recorded.
//
// Corpus, built here from constants and fonts on this machine (the result is committed, a replay needs neither):
//   pdf-lib documents   Standard 14 fonts including Symbol and ZapfDingbats, embedded TrueType subsets (Latin, Korean,
//                       Arabic), a CID font with its ToUnicode removed, many pages, rotated pages, object streams on/off
//   printed HTML        the tree's puppeteer-core and this machine's Chrome or Edge print Latin, Korean, Japanese,
//                       Chinese, Arabic, mixed sizes, superscripts and tables (creation and modification dates are
//                       rewritten in place to a constant of the same length, so offsets stay valid)
//   assembled files     broken xref offsets, a missing trailer, truncation, incremental updates, a linearized file, a
//                       page tree that loops, Type3 and predefined-CMap fonts, vertical writing, 1,030 pages, an empty
//                       file, an HTML file named .pdf, a file with bytes before the header
//   samples             native/core/fixtures/pdf-reader/samples/*.pdf (at least 20, each with a line in PROVENANCE.txt)
//
//   node benchmarks/rust-core/recorders/record-pdf-reader.mjs --tree C:\Project\mixdog
//
// The output is byte-stable: pdf-lib documents carry no dates, printed PDFs have theirs rewritten, keys are written
// sorted. A second run leaves the set unchanged.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RECORDER = 'benchmarks/rust-core/recorders/record-pdf-reader.mjs';
const SET = 'pdf-reader';

// The options pdf-extract.mjs's getDocumentProxy call ends up with, checked against what getDocument really received.
export const REFERENCE_OPTIONS = ['useSystemFonts', 'disableFontFace', 'standardFontDataUrl', 'cMapUrl', 'cMapPacked'];

const quiet = async (fn) => {
  const keep = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, keep);
  }
};

/**
 * pdf.js the way pdf-extract.mjs has it: the tree's legacy build behind unpdf's getDocumentProxy. `open(bytes, options)`
 * is the call `inspectLoaded` makes (`options` is `{password}` or empty) and returns the document proxy;
 * `lastParams()` is what getDocument was called with.
 */
export async function pdfEngine(tree) {
  const { importFrom } = await import('./lib/common.mjs');
  const pdfjs = await importFrom(tree, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(tree, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
  let last = null;
  const seen = { getDocument: (params) => ((last = params), pdfjs.getDocument(params)) };
  const unpdf = await importFrom(tree, 'node_modules/unpdf/dist/index.mjs');
  await unpdf.definePDFJSModule(() => Promise.resolve({ ...Object.fromEntries(Object.entries(pdfjs).filter(([k]) => k !== 'default')), ...seen }));
  const engine = {
    versions: {
      pdfjsDist: JSON.parse(readFileSync(join(tree, 'node_modules/pdfjs-dist/package.json'), 'utf8')).version,
      unpdf: JSON.parse(readFileSync(join(tree, 'node_modules/unpdf/package.json'), 'utf8')).version,
    },
    lastParams: () => last,
    async open(bytes, options = {}) {
      return quiet(() => unpdf.getDocumentProxy(new Uint8Array(bytes), options));
    },
  };
  // One real open, then every option of the reference configuration must be in the params getDocument was given.
  const probe = await engine.open(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n', 'latin1'));
  await probe.loadingTask.destroy();
  const params = last ?? {};
  const fontsUrl = String(params.standardFontDataUrl ?? '');
  const cmapUrl = String(params.cMapUrl ?? '');
  const problems = [];
  if (params.useSystemFonts !== true) problems.push('useSystemFonts is not true');
  if (params.disableFontFace !== true) problems.push('disableFontFace is not true');
  if (params.cMapPacked !== true) problems.push('cMapPacked is not true');
  if (!fontsUrl.startsWith('file:') || !fontsUrl.endsWith('/pdfjs-dist/standard_fonts/') || !existsSync(fileURLToPath(fontsUrl))) problems.push(`standardFontDataUrl ${fontsUrl} is not the tree's standard_fonts`);
  if (!cmapUrl.startsWith('file:') || !cmapUrl.endsWith('/pdfjs-dist/cmaps/') || !existsSync(join(fileURLToPath(cmapUrl), 'UniJIS-UCS2-H.bcmap'))) problems.push(`cMapUrl ${cmapUrl} is not the tree's cmaps`);
  if (!(params.data instanceof Uint8Array)) problems.push('data is not a Uint8Array');
  if (problems.length) throw new Error(`pdf.js is not in the reference configuration: ${problems.join('; ')}`);
  // pdf.js's Node data factory hands the url string it is given to fs.readFile, which does not read a `file:` url: with
  // the reference configuration a predefined CMap or a standard font file fails to load ("Unable to load CMap data").
  // The same files as plain paths do load; `readableDataOptions` is that configuration, recorded beside the reference.
  const asPath = (url) => `${fileURLToPath(url).split('\\').join('/').replace(/\/+$/, '')}/`;
  engine.readableDataOptions = { cMapUrl: asPath(cmapUrl), standardFontDataUrl: asPath(fontsUrl) };
  engine.options = { cMapPacked: true, cMapUrl: 'pdfjs-dist/cmaps/', disableFontFace: true, standardFontDataUrl: 'pdfjs-dist/standard_fonts/', useSystemFonts: true };
  return engine;
}

// pdf.js names a font `g_d<document>_f<n>` after a counter that runs over every document the process opened, so the
// same file gets another name depending on what was opened before it. The document part is replaced by a marker.
const stableFontName = (name) => String(name).replace(/^g_d\d+_/, 'g_d#_');

const errorOf = (error) => ({ name: error?.name ?? null, code: error?.code ?? null, message: String(error?.message ?? error) });

/** The golden's `outcome` for one open of `bytes`: every page's geometry and text, or the exception. */
export async function readDocument(engine, bytes, options = {}) {
  let pdf;
  try {
    pdf = await engine.open(bytes, options);
  } catch (error) {
    return { ok: false, error: errorOf(error) };
  }
  try {
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      let page;
      try {
        page = await quiet(() => pdf.getPage(number));
      } catch (error) {
        pages.push({ number, error: errorOf(error) });
        continue;
      }
      const viewport = page.getViewport({ scale: 1 });
      const record = {
        number,
        view: page.view,
        rotate: page.rotate,
        userUnit: page.userUnit,
        viewport: { width: viewport.width, height: viewport.height, rotation: viewport.rotation, offsetX: viewport.offsetX, offsetY: viewport.offsetY, transform: viewport.transform },
      };
      try {
        const content = await quiet(() => page.getTextContent());
        record.text = {
          items: content.items.map((item) => ({ str: item.str, dir: item.dir, transform: item.transform, width: item.width, height: item.height, fontName: stableFontName(item.fontName), hasEOL: item.hasEOL })),
          styles: Object.fromEntries(Object.entries(content.styles).map(([name, style]) => [stableFontName(name), style])),
        };
      } catch (error) {
        record.textError = errorOf(error);
      }
      page.cleanup();
      pages.push(record);
    }
    return { ok: true, numPages: pdf.numPages, pages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Assembling files by hand

const lat = (s) => Buffer.from(s, 'latin1');
const streamObject = (dict, data) => Buffer.concat([lat(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, lat('\nendstream')]);

/**
 * A classic-xref PDF from `objects` (object number 1..n, in order; a Buffer or a string is the body between
 * `N 0 obj` and `endobj`). Offsets are real unless `options` damages them.
 */
export function rawPdf(objects, { root = 1, header = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', trailerExtra = '', trailer = true, xref = true, startxref = true } = {}) {
  const parts = [lat(header)];
  let length = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([lat(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : lat(body), lat('\nendobj\n')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xrefAt = length;
  let tail = '';
  if (xref) tail += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  if (trailer) tail += `trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R ${trailerExtra} >>\n`;
  if (startxref) tail += `startxref\n${xrefAt}\n%%EOF\n`;
  parts.push(lat(tail));
  return { bytes: Buffer.concat(parts), offsets, xrefAt };
}

const helv = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
const textPage = (lines, size = 18) => {
  const ops = lines.map((l, i) => `BT /F1 ${size} Tf 40 ${700 - i * 30} Td (${l.replace(/([()\\])/g, '\\$1')}) Tj ET`).join('\n');
  return lat(ops);
};
/** A one-page document over fonts `fonts` (name -> object body appended after the 4 fixed objects) and a content text. */
function simpleObjects(content, { fonts = { F1: helv }, pageExtra = '' } = {}) {
  const names = Object.keys(fonts);
  const fontRefs = names.map((n, i) => `/${n} ${5 + i} 0 R`).join(' ');
  return [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << ${fontRefs} >> >> ${pageExtra} >>`,
    streamObject('', Buffer.isBuffer(content) ? content : lat(content)),
    ...names.map((n) => fonts[n]),
  ];
}

function linearizedPdf() {
  // Linearization parameter dictionary first, then the first page's objects, then the rest, with a first-page xref
  // pointing at the main one through /Prev (ISO 32000-1 annex F). Hint streams are left out; pdf.js does not need them.
  const body = {
    catalog: '<< /Type /Catalog /Pages 5 0 R >>',
    page: '<< /Type /Page /Parent 5 0 R /MediaBox [0 0 612 792] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >>',
    contents: streamObject('', textPage(['Linearized first page'])),
    font: helv,
    pages: '<< /Type /Pages /Kids [2 0 R 6 0 R] /Count 2 >>',
    page2: '<< /Type /Page /Parent 5 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 4 0 R >> >> >>',
    contents2: streamObject('', textPage(['Linearized second page'])),
  };
  const obj = (n, b) => Buffer.concat([lat(`${n} 0 obj\n`), Buffer.isBuffer(b) ? b : lat(b), lat('\nendobj\n')]);
  const build = (L, firstXref, mainXref) => {
    const lin = obj(8, `<< /Linearized 1 /L ${String(L).padStart(8, '0')} /H [ 0 0 ] /O 2 /E 0000000 /N 2 /T ${String(mainXref).padStart(8, '0')} >>`);
    const header = lat('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    const first = [obj(1, body.catalog), obj(2, body.page), obj(3, body.contents), obj(4, body.font)];
    const rest = [obj(5, body.pages), obj(6, body.page2), obj(7, body.contents2)];
    const offs = {};
    let at = header.length;
    offs[8] = at;
    at += lin.length;
    const firstXrefAt = at;
    const firstXrefBytes = lat(`xref\n8 1\n${String(offs[8]).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 9 /Root 1 0 R /Prev ${String(mainXref).padStart(8, '0')} >>\nstartxref\n0\n%%EOF\n`);
    at += firstXrefBytes.length;
    [1, 2, 3, 4].forEach((n, i) => {
      offs[n] = at;
      at += first[i].length;
    });
    [5, 6, 7].forEach((n, i) => {
      offs[n] = at;
      at += rest[i].length;
    });
    const mainAt = at;
    const mainXrefBytes = lat(`xref\n0 8\n0000000000 65535 f \n${[1, 2, 3, 4, 5, 6, 7].map((n) => `${String(offs[n]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 9 >>\nstartxref\n${firstXrefAt}\n%%EOF\n`);
    const out = Buffer.concat([header, lin, firstXrefBytes, ...first, ...rest, mainXrefBytes]);
    return { out, mainAt, firstXrefAt };
  };
  // Two passes: sizes do not change with the numbers because every number is zero-padded to a fixed width.
  const pass1 = build(0, 0, 0);
  const pass2 = build(pass1.out.length, pass1.firstXrefAt, pass1.mainAt);
  return pass2.out;
}

function incrementalPdf() {
  const base = rawPdf(simpleObjects(textPage(['Original revision text'])));
  const revision = (previous, prevXref, count, text, contentsNum, pageBody) => {
    const parts = [previous];
    let at = previous.length;
    const entries = [];
    const add = (num, body) => {
      entries.push([num, at]);
      const chunk = lat(`${num} 0 obj\n${body}\nendobj\n`);
      parts.push(chunk);
      at += chunk.length;
    };
    const content = textPage([text]);
    add(contentsNum, `<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`);
    add(3, pageBody(contentsNum));
    const xrefAt = at;
    const sub = entries
      .sort((a, b) => a[0] - b[0])
      .map(([num, off]) => `${num} 1\n${String(off).padStart(10, '0')} 00000 n \n`)
      .join('');
    parts.push(lat(`xref\n${sub}trailer\n<< /Size ${count} /Root 1 0 R /Prev ${prevXref} >>\nstartxref\n${xrefAt}\n%%EOF\n`));
    return { bytes: Buffer.concat(parts), xrefAt };
  };
  const page = (contents) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 5 0 R >> >> >>`;
  const r1 = revision(base.bytes, base.xrefAt, 7, 'Second revision text', 6, page);
  const r2 = revision(r1.bytes, r1.xrefAt, 8, 'Third revision text', 7, page);
  return r2.bytes;
}

const cidType0 = (baseFont, encoding, { ordering = 'Japan1', toUnicode = null, vertical = false } = {}) => [
  `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont}-${encoding} /Encoding /${encoding} /DescendantFonts [6 0 R]${toUnicode ? ' /ToUnicode 7 0 R' : ''} >>`,
  `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${baseFont} /CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement 2 >> /FontDescriptor 8 0 R /DW 1000${vertical ? ' /DW2 [880 -1000]' : ''} >>`,
];

function cmapFile(content) {
  return streamObject('/Type /CMap /CMapName /Adobe-Identity-UCS /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >>', lat(content));
}

function type3Pdf(withToUnicode) {
  const proc = (w, body) => streamObject('', lat(`${w} 0 0 0 ${w} 700 d1\n${body}`));
  const font = `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 750 750] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /sq 6 0 R /tri 7 0 R >> /Encoding << /Type /Encoding /Differences [65 /sq /tri] >> /FirstChar 65 /LastChar 66 /Widths [800 800]${withToUnicode ? ' /ToUnicode 8 0 R' : ''} /Resources << >> >>`;
  const objects = simpleObjects('BT /F1 24 Tf 60 700 Td (ABBA) Tj ET\nBT /F1 12 Tf 60 650 Td (AB BA) Tj ET', { fonts: { F1: font } });
  objects.push(proc(800, '0 0 700 700 re f'), proc(800, '0 0 m 700 0 l 350 700 l f'));
  if (withToUnicode) {
    objects.push(streamObject('', lat('/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T3 def /CMapType 2 def 1 begincodespacerange <41> <42> endcodespacerange 2 beginbfchar <41> <0053> <42> <0054> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end')));
  }
  return rawPdf(objects).bytes;
}

function predefinedCmapPdf(encoding, ordering, text16, { vertical = false, baseFont = 'HeiseiMin-W3' } = {}) {
  const [font, descendant] = cidType0(baseFont, encoding, { ordering, vertical });
  const objects = simpleObjects(`BT /F1 20 Tf 60 700 Td <${text16}> Tj ET`, { fonts: { F1: font } });
  // object 7 is the slot a ToUnicode would take; these fonts have none
  objects.push(descendant, '<< >>', '<< /Type /FontDescriptor /FontName /' + baseFont + ' /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>');
  return rawPdf(objects).bytes;
}

// ---------------------------------------------------------------------------------------------------------------------
// pdf-lib documents

const FONT_DIR = 'C:\\Windows\\Fonts';
const FIXED_DATE = new Date('2026-03-04T05:06:07.000Z');

async function pdfLibCases(tree) {
  const need = createRequire(join(tree, 'package.json'));
  const PDFLib = need('pdf-lib');
  const fontkit = need('@pdf-lib/fontkit');
  const { PDFDocument, StandardFonts, degrees, PDFName, PDFNumber, rgb } = PDFLib;
  const fontFile = (name) => {
    const path = join(FONT_DIR, name);
    if (!existsSync(path)) throw new Error(`font ${path} is needed to build the corpus`);
    return readFileSync(path);
  };
  const fresh = async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.registerFontkit(fontkit);
    return doc;
  };
  const cases = [];
  const add = async (name, doc, save = {}) => cases.push({ name, group: 'pdf-lib', bytes: Buffer.from(await doc.save({ useObjectStreams: false, ...save })) });

  {
    const doc = await fresh();
    const page = doc.addPage([612, 792]);
    const names = Object.keys(StandardFonts);
    let y = 760;
    for (const name of names) {
      const font = await doc.embedFont(StandardFonts[name]);
      // Symbol and ZapfDingbats encode only their own glyphs, so their lines carry no label
      let text = `${name}: The quick brown fox jumps over the lazy dog 0123456789 (){}`;
      if (name === 'Symbol') text = '\u03b1\u03b2\u03b3\u03b4\u03b5\u03b6 \u2211 \u220f \u222b \u2264 \u2265 \u2260 \u221e';
      if (name === 'ZapfDingbats') text = '\u2701\u2702\u2703\u2704\u260e\u2706\u2707\u2708';
      page.drawText(text, { x: 36, y, size: 11, font });
      y -= 22;
    }
    await add('std14-fonts-all', doc);
  }
  {
    const doc = await fresh();
    const page = doc.addPage([420, 300]);
    const noto = await doc.embedFont(fontFile('NotoSans-Regular.ttf'), { subset: true });
    page.drawText('Embedded subset: naive caf\u00e9, \u00dcn\u00efc\u00f6d\u00e9, \u00fc\u00f1\u00ed', { x: 20, y: 250, size: 14, font: noto });
    page.drawText('Second line 0123456789 AV To', { x: 20, y: 220, size: 14, font: noto });
    const arial = await doc.embedFont(fontFile('arial.ttf'), { subset: true });
    page.drawText('Arial subset text with the same words', { x: 20, y: 190, size: 12, font: arial });
    await add('ttf-subsets-latin', doc);
  }
  {
    const doc = await fresh();
    const page = doc.addPage([420, 300]);
    const font = await doc.embedFont(fontFile('malgun.ttf'), { subset: true });
    page.drawText('\ud55c\uae00 \uc784\ubca0\ub4dc \ud2b8\ub8e8\ud0c0\uc785 \ubb38\uc7a5\uc785\ub2c8\ub2e4', { x: 20, y: 250, size: 16, font });
    page.drawText('\uac00\ub098\ub2e4\ub77c\ub9c8\ubc14\uc0ac 0123', { x: 20, y: 220, size: 16, font });
    await add('ttf-subset-korean', doc);
  }
  {
    const doc = await fresh();
    const page = doc.addPage([420, 300]);
    const font = await doc.embedFont(fontFile('NotoSansArabic-Regular.ttf'), { subset: true });
    page.drawText('\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645', { x: 20, y: 250, size: 16, font });
    await add('ttf-subset-arabic', doc);
  }
  {
    // A CID font whose ToUnicode is taken away: pdf.js falls back to the embedded font's own tables.
    const doc = await fresh();
    const page = doc.addPage([420, 300]);
    const font = await doc.embedFont(fontFile('NotoSans-Regular.ttf'), { subset: true });
    page.drawText('CID without ToUnicode', { x: 20, y: 250, size: 16, font });
    await doc.flush();
    const dict = doc.context.lookup(font.ref);
    dict.delete(PDFName.of('ToUnicode'));
    await add('cid-identity-h-no-tounicode', doc);
  }
  {
    const doc = await fresh();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 60; i += 1) {
      const page = doc.addPage([300 + (i % 4) * 20, 400]);
      page.drawText(`page ${i} of sixty`, { x: 20, y: 350, size: 14, font });
      page.drawText(`line two on ${i}`, { x: 20, y: 320, size: 10 + (i % 5), font });
    }
    await add('pages-sixty', doc);
  }
  {
    const doc = await fresh();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const variants = [
      ['rotate-0', 0, [0, 0, 300, 200]],
      ['rotate-90', 90, [0, 0, 300, 200]],
      ['rotate-180', 180, [0, 0, 300, 200]],
      ['rotate-270', 270, [0, 0, 300, 200]],
      ['rotate-450', 450, [0, 0, 300, 200]],
      ['rotate-minus-90', -90, [0, 0, 300, 200]],
      ['offset-origin', 0, [-50, -40, 250, 160]],
      ['rotate-90-offset', 90, [-50, -40, 250, 160]],
    ];
    for (const [label, rotation, box] of variants) {
      const page = doc.addPage();
      page.setMediaBox(box[0], box[1], box[2] - box[0], box[3] - box[1]);
      page.node.set(PDFName.of('Rotate'), PDFNumber.of(rotation));
      page.drawText(label, { x: box[0] + 20, y: box[1] + 150, size: 16, font });
      page.drawRectangle({ x: box[0] + 10, y: box[1] + 10, width: 60, height: 30, color: rgb(0.8, 0.2, 0.2) });
    }
    const cropped = doc.addPage([300, 200]);
    cropped.setCropBox(20, 30, 200, 120);
    cropped.drawText('cropped page text', { x: 30, y: 100, size: 14, font });
    const units = doc.addPage([200, 200]);
    units.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    units.drawText('user unit two', { x: 20, y: 100, size: 14, font });
    const rotatedBox = doc.addPage([200, 300]);
    rotatedBox.setRotation(degrees(90));
    rotatedBox.setCropBox(10, 10, 150, 250);
    rotatedBox.drawText('rotated cropped', { x: 20, y: 200, size: 14, font });
    await add('pages-rotated-and-boxes', doc);
  }
  for (const [label, useObjectStreams] of [['objstm-on', true], ['objstm-off', false]]) {
    const doc = await fresh();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 5; i += 1) doc.addPage([200, 200]).drawText(`object streams ${useObjectStreams ? 'on' : 'off'} page ${i}`, { x: 10, y: 100, size: 9, font });
    doc.setTitle('Object streams');
    doc.setAuthor('corpus');
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    await add(label, doc, { useObjectStreams });
  }
  {
    const doc = await fresh();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 1030; i += 1) doc.addPage([200, 120]).drawText(`page ${i} of 1030`, { x: 10, y: 60, size: 10, font });
    await add('pages-1030', doc, { useObjectStreams: true });
  }
  return cases;
}

// ---------------------------------------------------------------------------------------------------------------------
// Printed HTML

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const page = (body, style = '') => `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:13px;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #444;padding:4px 8px}${style}</style></head><body>${body}</body></html>`;
const rows = (n, cols) => Array.from({ length: n }, (_, r) => `<tr>${Array.from({ length: cols }, (_, c) => `<td>r${r + 1}c${c + 1} ${(r * cols + c) * 37 % 1000}</td>`).join('')}</tr>`).join('');
const HTML_CASES = {
  'html-latin': page('<h1>Quarterly operations report</h1><p>Night shift throughput rose twelve percent over the previous quarter. Ligatures: office, fifty, waffle, affluent.</p><p><b>Bold</b>, <i>italic</i> and <code>monospace</code> text; <a href="https://example.com/">a link</a>.</p><ul><li>First item</li><li>Second item with more words</li></ul>' + '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. </p>'.repeat(60)),
  'html-korean': page('<h1 style="font-family:\'Malgun Gothic\'">\uc57c\uac04 \uadfc\ubb34 \ubcf4\uace0\uc11c</h1><p style="font-family:\'Malgun Gothic\'">\ud55c\uad6d\uc5b4 \ubb38\uc7a5\uc785\ub2c8\ub2e4. \ucc98\ub9ac\ub7c9\uc774 \uc99d\uac00\ud588\uc2b5\ub2c8\ub2e4. \uc22b\uc790 12345\uc640 English words \uc11e\uc778 \ubb38\uc7a5.</p>'),
  'html-japanese': page('<h1 style="font-family:\'Yu Gothic\'">\u591c\u52e4\u30ec\u30dd\u30fc\u30c8</h1><p style="font-family:\'Yu Gothic\'">\u65e5\u672c\u8a9e\u306e\u6587\u7ae0\u3067\u3059\u3002\u51e6\u7406\u91cf\u304c\u5897\u52a0\u3057\u307e\u3057\u305f\u3002\u30ab\u30bf\u30ab\u30ca\u3068\u3072\u3089\u304c\u306a\u3068\u6f22\u5b57\u3002</p>'),
  'html-chinese': page('<h1 style="font-family:\'Microsoft YaHei\'">\u591c\u73ed\u62a5\u544a</h1><p style="font-family:\'Microsoft YaHei\'">\u8fd9\u662f\u4e2d\u6587\u53e5\u5b50\u3002\u591c\u73ed\u541e\u5410\u91cf\u6709\u6240\u589e\u52a0\u3002\u7e41\u9ad4\u5b57\u4e5f\u53ef\u4ee5\u3002</p>'),
  'html-arabic': page('<h1 dir="rtl">\u062a\u0642\u0631\u064a\u0631 \u0627\u0644\u0639\u0645\u0644\u064a\u0627\u062a</h1><p dir="rtl">\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645\u060c \u0647\u0630\u0627 \u0627\u062e\u062a\u0628\u0627\u0631 \u0644\u0644\u0646\u0635 \u0645\u0646 \u0627\u0644\u064a\u0645\u064a\u0646 \u0625\u0644\u0649 \u0627\u0644\u064a\u0633\u0627\u0631 123.</p><p>Mixed: abc \u0645\u0631\u062d\u0628\u0627 def</p>'),
  'html-mixed-sizes': page('<h1>Heading one</h1><h2>Heading two</h2><h3>Heading three</h3><h4>Heading four</h4><h5>Heading five</h5><h6>Heading six</h6><p style="font-size:8px">tiny text eight pixels</p><p style="font-size:48px">Big forty eight</p><p>Normal <span style="font-size:22px">larger</span> <span style="font-size:9px">smaller</span> run.</p>'),
  'html-superscripts': page('<p>E = mc<sup>2</sup>, H<sub>2</sub>O, x<sup>n+1</sup>, footnote<sup>[1]</sup> and an ordinal 12<sup>th</sup>.</p><p>Text with a <span style="vertical-align:super;font-size:70%">raised</span> and <span style="vertical-align:sub;font-size:70%">lowered</span> run.</p><p style="line-height:2.4">Spaced lines with <sup>top</sup> and <sub>bottom</sub> marks.</p>'),
  'html-tables': page(`<table><tr><th>Hub</th><th>Orders</th><th>Rate</th><th>Note</th></tr>${rows(8, 4)}</table><p>After the first table.</p><table style="width:100%">${rows(60, 6)}</table>`),
};

// Printed PDFs carry the print time. Both dates are rewritten in place to a constant of the same length, so every
// xref offset stays valid.
function stripPrintDates(bytes) {
  const text = bytes.toString('latin1');
  const fixed = text.replace(/\((D:)\d{14}([^)]*)\)/g, (_, d, zone) => `(${d}20260304050607${zone})`);
  if (fixed.length !== text.length) throw new Error('date rewrite changed the length of a printed PDF');
  return Buffer.from(fixed, 'latin1');
}

async function printedCases(tree) {
  const executablePath = BROWSERS.find((p) => existsSync(p));
  if (!executablePath) throw new Error(`no Chrome or Edge found (looked in ${BROWSERS.join(', ')}): the printed-HTML part of the corpus cannot be built`);
  const puppeteer = createRequire(join(tree, 'package.json'))('puppeteer-core');
  const profile = mkdtempSync(join(tmpdir(), 'pdf-reader-chrome-'));
  const browser = await puppeteer.launch({ executablePath, userDataDir: profile, args: ['--no-first-run', '--no-default-browser-check'] });
  const cases = [];
  try {
    const tab = await browser.newPage();
    for (const [name, html] of Object.entries(HTML_CASES)) {
      await tab.setContent(html, { waitUntil: 'load' });
      const printed = Buffer.from(await tab.pdf({ width: '210mm', height: '297mm', printBackground: true }));
      cases.push({ name, group: 'printed-html', bytes: stripPrintDates(printed) });
    }
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
  return cases;
}

// ---------------------------------------------------------------------------------------------------------------------
// Assembled files

function assembledCases() {
  const cases = [];
  const add = (name, bytes) => cases.push({ name, group: 'assembled', bytes: Buffer.isBuffer(bytes) ? bytes : lat(bytes) });
  const plain = rawPdf(simpleObjects(textPage(['Plain assembled document', 'Second line of text'])));
  add('plain-classic-xref', plain.bytes);

  // Damaged xref data: offsets all off by seven, startxref pointing past the file, no trailer, no xref at all.
  const shifted = plain.bytes.toString('latin1').replace(/(\d{10}) 00000 n /g, (_, o) => `${String(Number(o) + 7).padStart(10, '0')} 00000 n `);
  add('broken-xref-offsets', shifted);
  add('broken-startxref', plain.bytes.toString('latin1').replace(/startxref\n\d+/, 'startxref\n99999999'));
  add('missing-trailer', plain.bytes.subarray(0, plain.bytes.indexOf('trailer')));
  add('missing-xref-and-trailer', plain.bytes.subarray(0, plain.xrefAt));
  add('truncated-mid-stream', plain.bytes.subarray(0, Math.floor(plain.bytes.length * 0.45)));
  add('no-eof-marker', plain.bytes.toString('latin1').replace('%%EOF\n', ''));
  add('garbage-before-header', Buffer.concat([lat('GARBAGE LINE BEFORE THE HEADER\n'.repeat(3)), plain.bytes]));
  add('header-only', '%PDF-1.7\n');
  add('binary-junk', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) & 0xff)));
  add('empty-file', Buffer.alloc(0));
  add('html-named-pdf', '<!doctype html><html><head><title>Not a PDF</title></head><body><h1>This is an HTML page saved with a .pdf name</h1></body></html>\n');
  add('plain-text-named-pdf', 'Just some plain text in a file named like a PDF.\n');

  add('incremental-update', incrementalPdf());
  add('linearized', linearizedPdf());

  // Structure
  add('no-pages', rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>']).bytes);
  add('pages-count-wrong', rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 7 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>']).bytes);
  add('page-tree-nested', rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 3 >>',
    '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 /MediaBox [0 0 200 100] >>',
    '<< /Type /Page /Parent 3 0 R >>',
    '<< /Type /Page /Parent 3 0 R /Rotate 90 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 300] >>',
  ]).bytes);
  add('page-tree-loop', rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Pages /Parent 2 0 R /Kids [2 0 R] /Count 1 >>']).bytes);
  add('page-without-mediabox', rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R >>']).bytes);
  add('missing-font-resource', rawPdf(simpleObjects('BT /F2 14 Tf 40 700 Td (font F2 does not exist) Tj ET\nBT /F1 14 Tf 40 670 Td (but F1 does) Tj ET')).bytes);
  add('content-stream-garbage', rawPdf(simpleObjects('BT /F1 14 Tf 40 700 Td (before) Tj ET\n<<<< ]] garbage 1 2 3 \nBT /F1 14 Tf 40 670 Td (after) Tj ET')).bytes);
  add('text-render-modes', rawPdf(simpleObjects('BT /F1 14 Tf 40 700 Td 0 Tr (filled) Tj 3 Tr (invisible) Tj 1 Tr (stroked) Tj 7 Tr (clipped) Tj ET')).bytes);
  add('text-positioning-operators', rawPdf(simpleObjects('BT /F1 12 Tf 14 TL 40 700 Td (line one) Tj T* (line two) Tj (line three) \' 2 1 (line four) " 0 0 Td [(spaced ) -250 (kerned) 120 (array)] TJ 50 0 Td (moved) Tj ET\nBT /F1 12 Tf 1 0 0.3 1 40 500 Tm (skewed) Tj 12 Tz (scaled) Tj ET')).bytes);
  add('form-xobject-text', rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /XObject << /Fm1 5 0 R >> /Font << /F1 6 0 R >> >> >>',
    streamObject('', lat('BT /F1 12 Tf 20 170 Td (outside the form) Tj ET\nq 1 0 0 1 20 100 cm /Fm1 Do Q')),
    streamObject('/Type /XObject /Subtype /Form /BBox [0 0 200 60] /Resources << /Font << /F1 6 0 R >> >>', lat('BT /F1 12 Tf 5 30 Td (inside the form) Tj ET')),
    helv,
  ]).bytes);

  // Fonts the document does not embed
  add('type3-font', type3Pdf(false));
  add('type3-font-tounicode', type3Pdf(true));
  const ucs2 = (s) => Array.from(s).map((ch) => ch.codePointAt(0).toString(16).padStart(4, '0')).join('');
  add('cid-uniJIS-ucs2-h', predefinedCmapPdf('UniJIS-UCS2-H', 'Japan1', ucs2('\u65e5\u672c\u8a9e\u306e\u6587\u7ae0')));
  add('cid-uniJIS-ucs2-v-vertical', predefinedCmapPdf('UniJIS-UCS2-V', 'Japan1', ucs2('\u7e26\u66f8\u304d\u306e\u6587\u7ae0'), { vertical: true }));
  add('cid-uniGB-ucs2-h', predefinedCmapPdf('UniGB-UCS2-H', 'GB1', ucs2('\u7b80\u4f53\u4e2d\u6587\u6587\u672c'), { baseFont: 'STSong-Light' }));
  add('cid-uniKS-ucs2-h', predefinedCmapPdf('UniKS-UCS2-H', 'Korea1', ucs2('\ud55c\uad6d\uc5b4 \ubb38\uc7a5'), { baseFont: 'HYSMyeongJo-Medium' }));
  add('cid-uniCNS-ucs2-h', predefinedCmapPdf('UniCNS-UCS2-H', 'CNS1', ucs2('\u7e41\u9ad4\u4e2d\u6587\u6587\u5b57'), { baseFont: 'MSung-Light' }));
  // 90ms-RKSJ-H: Shift-JIS bytes, half-width katakana and ASCII one byte, kanji two (the bytes of "ABC" and "日本語").
  add('cid-90ms-rksj-h', predefinedCmapPdf('90ms-RKSJ-H', 'Japan1', '414243' + '93fa967b8cea'));
  add('cid-identity-h-adobe-japan1-no-embed', predefinedCmapPdf('Identity-H', 'Japan1', '0402040304040405'));
  return cases;
}

// ---------------------------------------------------------------------------------------------------------------------

function sampleCases(samplesDir) {
  const provenance = readFileSync(join(samplesDir, 'PROVENANCE.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const named = new Map(provenance.map((l) => [l.split(' | ')[0], l.split(' | ').length >= 4]));
  const files = readdirSync(samplesDir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  if (files.length < 20) throw new Error(`${files.length} samples in ${samplesDir}: at least 20 are required`);
  for (const f of files) if (!named.get(f)) throw new Error(`sample ${f} has no provenance line with four fields`);
  for (const f of named.keys()) if (!files.includes(f)) throw new Error(`provenance names ${f}, which is not in the samples folder`);
  return files.map((f) => ({ name: `sample-${f.replace(/\.pdf$/i, '')}`, group: 'samples', bytes: readFileSync(join(samplesDir, f)), sample: f }));
}

async function main() {
  const { FIXTURES_ROOT, commitStage, parseArgs, productIdentity, resolveTree, stageSet, writeCanonicalJson, writeSetManifest, within } = await import('./lib/common.mjs');
  const { recorderProvenance } = await import('./lib/provenance.mjs');
  const args = parseArgs();
  const tree = resolveTree(args);
  const identity = productIdentity(tree);
  const finalDir = join(FIXTURES_ROOT, SET);
  const samplesDir = join(finalDir, 'samples');
  const samples = sampleCases(samplesDir);
  const engine = await pdfEngine(tree);
  const corpus = [...(await pdfLibCases(tree)), ...(await printedCases(tree)), ...assembledCases(), ...samples];
  const stage = stageSet(finalDir, ['files', 'goldens']);
  mkdirSync(join(stage, 'files'), { recursive: true });
  mkdirSync(join(stage, 'goldens'), { recursive: true });
  const names = new Set();
  const summary = [];
  for (const entry of corpus) {
    if (names.has(entry.name)) throw new Error(`corpus name ${entry.name} is used twice`);
    names.add(entry.name);
    if (!entry.sample) writeFileSync(join(stage, 'files', `${entry.name}.pdf`), entry.bytes);
    const outcome = await within(entry.name, readDocument(engine, entry.bytes), 600_000);
    // The same file with the CMap and font data urls given as paths pdf.js can read; where the answer is the same it says so.
    const heavy = entry.bytes.length > 100_000 && entry.group === 'pdf-lib';
    const readable = heavy ? null : await within(entry.name, readDocument(engine, entry.bytes, engine.readableDataOptions), 600_000);
    const withReadableDataUrls = readable === null ? { skipped: 'many pages; the data files are not used by their text' } : JSON.stringify(readable) === JSON.stringify(outcome) ? { sameAsReference: true } : { sameAsReference: false, outcome: readable };
    writeCanonicalJson(join(stage, 'goldens', `${entry.name}.json`), {
      name: entry.name,
      group: entry.group,
      file: entry.sample ? `samples/${entry.sample}` : `files/${entry.name}.pdf`,
      bytes: entry.bytes.length,
      sha256: createHash('sha256').update(entry.bytes).digest('hex'),
      outcome,
      withReadableDataUrls,
    });
    summary.push(`${entry.name}: ${outcome.ok ? `${outcome.numPages} pages` : outcome.error.name}${withReadableDataUrls.sameAsReference === false ? ' (differs with readable data urls)' : ''}`);
  }
  writeSetManifest(stage, {
    set: SET,
    recorder: RECORDER,
    command: `node ${RECORDER} --tree <Node product tree with node_modules>`,
    extra: {
      cases: [...names].sort(),
      pdfEngine: { ...engine.versions, options: engine.options, openedBy: 'unpdf getDocumentProxy(new Uint8Array(buffer), {}) as attachments/pdf-extract.mjs inspectLoaded' },
      ...recorderProvenance(import.meta.url),
    },
    identity,
  });
  commitStage(stage, finalDir);
  console.log(`recorded ${SET}: ${corpus.length} files`);
  if (args.get('list')) console.log(summary.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
