#!/usr/bin/env node
// Golden of the OCR line building and placement (crate mixdog-office-pdf: ocr/tsv.rs, ocr/layer.rs, ocr/mod.rs). Each case
// is a generated PDF page, the recognition (the engine's text and its table of words, written the way the engine writes
// them: with the header row of its command line or without it as its library does) and the options of the `ocr` operation.
// The product's `ocrTextLines` builds the lines from the recognition, and `ocrPdf` (src/runtime/office/pdf/pdf-ocr.mjs) runs
// on the PDF with the engine standing in: the stand-in is the recorded recognition, handed out page by page, so everything
// else in the call is the product's own (the page render, the word filter, the line/word placement, the font, the invisible
// text, the saved file and the result). The recording holds the lines, the result, the size of each image the engine was
// handed, and the runs of text the saved PDF carries (text, position, size) read back from its content streams.
//
// The recognitions are written by hand in the engine's format; the tesseract.js engine itself needs its language data from
// the network and is not run. Rust must equal the lines and the result exactly and the placed runs to 1e-9.
//
//   node benchmarks/rust-core/recorders/record-office-ocr.mjs --tree <product tree with node_modules>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-ocr.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);

// The engine stand-in: pdf-ocr.mjs imports `./ocr-engine.mjs`; the recorder hands it the recorded recognition instead.
const STUB = `
export async function acquireOcrEngine() {
  const state = globalThis.__ocrStub;
  return {
    async recognize(image) {
      const answer = state.answers[state.next++];
      return { text: answer.text, tsv: answer.tsv, blocks: [] };
    },
    release() {},
  };
}
`;
const HOOKS = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === './ocr-engine.mjs' && String(context.parentURL).endsWith('/pdf-ocr.mjs')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, import.meta.url);

const { ocrPdf, ocrTextLines } = await importFrom(tree, 'src/runtime/office/pdf/pdf-analysis.mjs');

// ---- bytes ---------------------------------------------------------------------------------------------------------

const ascii = (text) => Buffer.from(text, 'latin1');

/** A PDF of `pages` pages: each is `{ width, height, content }`. */
function buildPdf(pages) {
  const first = 3;
  const kids = pages.map((_, index) => `${first + index * 2} 0 R`).join(' ');
  const all = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`],
  ]);
  pages.forEach((page, index) => {
    const num = first + index * 2;
    all.set(num, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Contents ${num + 1} 0 R /Resources << >> >>`);
    all.set(num + 1, { bytes: ascii(page.content ?? '') });
  });
  const parts = [ascii('%PDF-1.7\n')];
  const offsets = new Map();
  let size = parts[0].length;
  for (const [num, body] of [...all].sort((a, b) => a[0] - b[0])) {
    offsets.set(num, size);
    const chunk =
      typeof body === 'string'
        ? ascii(`${num} 0 obj\n${body}\nendobj\n`)
        : Buffer.concat([ascii(`${num} 0 obj\n<< /Length ${body.bytes.length} >>\nstream\n`), body.bytes, ascii('\nendstream\nendobj\n')]);
    parts.push(chunk);
    size += chunk.length;
  }
  const last = Math.max(...all.keys());
  let xref = `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= last; n += 1) xref += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  parts.push(ascii(`${xref}trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** A page that looks scanned: a grey field with a darker band where the text would be. */
const scan = (width, height) => ({ width, height, content: `0.9 g 0 0 ${width} ${height} re f 0.2 g ${width / 10} ${height / 2} ${width * 0.8} 12 re f` });

// ---- recognitions --------------------------------------------------------------------------------------------------

const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
/** A word row: `[line, word, left, top, width, height, conf, text]` of block 1, paragraph 1. */
const wordRow = ([line, word, left, top, width, height, conf, text]) => `5\t1\t1\t1\t${line}\t${word}\t${left}\t${top}\t${width}\t${height}\t${conf}\t${text}`;
const structure = (width, height, lines) => [
  `1\t1\t0\t0\t0\t0\t0\t0\t${width}\t${height}\t-1\t`,
  `2\t1\t1\t0\t0\t0\t0\t0\t${width}\t${height}\t-1\t`,
  `3\t1\t1\t1\t0\t0\t0\t0\t${width}\t${height}\t-1\t`,
  ...lines.map(([line, left, top, lineWidth, lineHeight]) => `4\t1\t1\t1\t${line}\t0\t${left}\t${top}\t${lineWidth}\t${lineHeight}\t-1\t`),
];
const tsv = (rows, { headed = false } = {}) => `${[...(headed ? [HEADER] : []), ...rows].join('\n')}\n`;

const invoice = [
  [1, 1, 200, 300, 150, 40, 96.4, 'Invoice'],
  [1, 2, 380, 300, 90, 40, 94.1, 'No.'],
  [1, 3, 490, 300, 120, 40, 91.7, '2025-0412'],
  [2, 1, 200, 380, 140, 36, 95.0, 'Total'],
  [2, 2, 360, 380, 160, 36, 93.2, 'due:'],
  [2, 3, 540, 380, 110, 36, 90.5, '$1,280.00'],
];
const invoiceText = 'Invoice No. 2025-0412\nTotal due: $1,280.00\n\n';
const invoiceTsv = (headed) => tsv([...structure(1240, 1754, [[1, 200, 300, 410, 40], [2, 200, 380, 450, 36]]), ...invoice.map(wordRow)], { headed });

// ---- the cases -----------------------------------------------------------------------------------------------------

const cases = [];
const add = (name, pages, operation, recognitions) => cases.push({ name, pages, operation: { op: 'ocr', ...operation }, recognitions });

add('intact-lines-with-header-row', [scan(595, 842)], {}, [{ text: invoiceText, tsv: invoiceTsv(true) }]);
add('intact-lines-without-header-row', [scan(595, 842)], {}, [{ text: invoiceText, tsv: invoiceTsv(false) }]);
add('the-page-option-names-one-page', [scan(595, 842), scan(420, 595)], { page: 2 }, [{ text: invoiceText, tsv: invoiceTsv(false) }]);
add('pages-in-the-order-given-each-page-its-own-size', [scan(595, 842), scan(842, 595)], { pages: [2, 1], languages: ['eng'] }, [
  { text: invoiceText, tsv: invoiceTsv(true) },
  { text: 'Second page\n\n', tsv: tsv([wordRow([1, 1, 120, 150, 200, 44, 88.5, 'Second']), wordRow([1, 2, 340, 150, 160, 44, 87.25, 'page'])], { headed: true }) },
]);
add(
  'a-word-under-the-confidence-sends-its-row-back-to-its-boxes',
  [scan(595, 842)],
  {},
  [
    {
      text: 'Keep this smudged line\n\n',
      tsv: tsv([wordRow([1, 1, 100, 200, 90, 30, 91, 'Keep']), wordRow([1, 2, 210, 200, 90, 30, 92, 'this']), wordRow([1, 3, 320, 200, 150, 30, 12.5, 'smudged']), wordRow([1, 4, 490, 200, 90, 30, 90, 'line'])]),
    },
  ],
);
add(
  'a-column-gap-sends-its-row-back-to-its-boxes',
  [scan(595, 842)],
  {},
  [
    {
      text: 'Name                     Amount\n\n',
      tsv: tsv([wordRow([1, 1, 100, 200, 120, 30, 95, 'Name']), wordRow([1, 2, 900, 200, 160, 30, 94, 'Amount'])]),
    },
  ],
);
add('the-confidence-floor-is-the-calls', [scan(595, 842)], { minConfidence: 92 }, [{ text: invoiceText, tsv: invoiceTsv(false) }]);
add('a-string-confidence-floor-is-a-number', [scan(595, 842)], { minConfidence: '93' }, [{ text: invoiceText, tsv: invoiceTsv(false) }]);
add(
  'a-reading-is-taken-from-the-line-that-has-its-characters',
  [scan(595, 842)],
  {},
  [
    {
      // The first row has no box (width 0): its reading is skipped, never given to the next row.
      text: 'Header   only\nSecond   row  here\n\n',
      tsv: tsv([wordRow([1, 1, 100, 100, 0, 0, 95, 'Header']), wordRow([2, 1, 100, 200, 100, 30, 95, 'Second']), wordRow([2, 2, 220, 200, 70, 30, 94, 'row']), wordRow([2, 3, 310, 200, 90, 30, 93, 'here'])]),
    },
  ],
);
add('a-row-the-engine-read-differently-keeps-its-boxes-joined', [scan(595, 842)], {}, [{ text: 'Something else entirely\n\n', tsv: invoiceTsv(false) }]);
add('the-render-width-is-held-between-1200-and-3200', [scan(1600, 900)], { maxWidth: 100 }, [{ text: invoiceText, tsv: invoiceTsv(false) }]);
add('a-wide-render-is-held-at-3200', [scan(1600, 900)], { maxWidth: 9000 }, [{ text: invoiceText, tsv: invoiceTsv(false) }]);
add('a-tiny-box-keeps-the-minimum-size', [scan(595, 842)], {}, [{ text: 'dot\n\n', tsv: tsv([wordRow([1, 1, 400, 400, 6, 4, 95, 'dot'])]) }]);
add('nothing-recognised-writes-nothing', [scan(595, 842)], {}, [{ text: '\n', tsv: tsv(structure(1240, 1754, [])) }]);
add('every-word-under-the-floor-writes-nothing', [scan(595, 842)], { minConfidence: 99 }, [{ text: invoiceText, tsv: invoiceTsv(false) }]);

// ---- reading the placed text back ----------------------------------------------------------------------------------

/** The runs of text the saved PDF carries: `{ page, text, x, y, size }` from each page's last content stream. */
async function placedRuns(bytes, pdfLib) {
  const document = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
  const runs = [];
  document.getPages().forEach((page, index) => {
    const contents = page.node.Contents();
    const refs = contents?.asArray ? contents.asArray() : contents ? [contents] : [];
    for (const ref of refs) {
      const stream = document.context.lookup(ref);
      let data = Buffer.from(stream.contents ?? stream.getContents());
      if (stream.dict.get(pdfLib.PDFName.of('Filter'))?.toString() === '/FlateDecode') data = inflateSync(data);
      const source = data.toString('latin1');
      const run = /\/(\S+)\s+(\S+)\s+Tf\s+\S+\s+TL\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+Tm\s+<([0-9A-Fa-f]*)>\s*Tj/g;
      for (const match of source.matchAll(run)) {
        runs.push({ page: index + 1, text: Buffer.from(match[9], 'hex').toString('latin1'), x: Number(match[7]), y: Number(match[8]), size: Number(match[2]), matrix: match.slice(3, 7).map(Number) });
      }
    }
  });
  return runs;
}

const pngSize = (file) => {
  const data = readFileSync(file);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
};

const pdfLib = await importFrom(tree, 'node_modules/pdf-lib/cjs/index.js').then((module) => module.default ?? module);

const scratch = mkdtempSync(path.join(FIXTURES_ROOT, 'office-ocr-scratch-'));
const record = async (spec) => {
  const dir = path.join(scratch, spec.name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'doc.pdf');
  const pdf = buildPdf(spec.pages);
  writeFileSync(file, pdf);
  const lines = spec.recognitions.map((recognition) =>
    ocrTextLines(recognition.tsv, recognition.text).map((line) => ({
      text: line.text,
      fromEngine: line.fromEngine,
      left: line.left,
      top: line.top,
      width: line.width,
      height: line.height,
      columnGap: line.columnGap,
      words: line.words,
    }))
  );
  globalThis.__ocrStub = { answers: spec.recognitions, next: 0 };
  const before = readFileSync(file);
  let outcome;
  try {
    const result = await ocrPdf(file, spec.operation, { dataDir: path.join(dir, 'data') });
    outcome = { result };
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : String(error) };
  }
  const after = readFileSync(file);
  const written = !before.equals(after);
  const runs = written ? await placedRuns(after, pdfLib) : [];
  const leftBeside = readdirSync(dir).filter((name) => name !== 'doc.pdf' && name !== 'data').sort();
  return { name: spec.name, pages: spec.pages.map(({ width, height }) => ({ width, height })), pdf: pdf.toString('hex'), operation: spec.operation, recognitions: spec.recognitions, lines, imageSizes: [], ...outcome, written, runs, leftBeside };
};

// The call removes its page images, so their sizes are taken from a render of the same pages in a second pass (the render
// the call itself makes: same options).
const sizesOf = async (spec) => {
  const { renderPdfPages } = await importFrom(tree, 'src/runtime/office/pdf/pdf-render.mjs');
  const dir = path.join(scratch, `${spec.name}-sizes`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'doc.pdf');
  writeFileSync(file, buildPdf(spec.pages));
  const asked = spec.operation.pages ?? (spec.operation.page ? [spec.operation.page] : spec.pages.map((_, index) => index + 1));
  const width = Math.max(1200, Math.min(3200, Number(spec.operation.maxWidth) || 2400));
  const sizes = [];
  for (const page of asked) {
    const rendered = await renderPdfPages(file, { pages: [page], maxWidth: width });
    sizes.push(pngSize(rendered.images[0].path));
  }
  return sizes;
};

const out = {
  note: 'ocrTextLines and ocrPdf of src/runtime/office/pdf (pdf-ocr.mjs) on generated scanned-looking pages, the engine standing in with hand-written recognitions in its own format. lines are the product lines of each recognition; result is what ocrPdf returned (or error its message); imageSizes are the pixel sizes of the page images the engine was handed, in the order of the pages the call read; written says the PDF changed; runs are the invisible text runs of the saved PDF (page, text, x, y, size) read from its content streams; leftBeside is what the call left beside the PDF (nothing but the data folder).',
  cases: [],
};
try {
  for (const spec of cases) {
    const recorded = await record(spec);
    recorded.imageSizes = await sizesOf(spec);
    out.cases.push(recorded);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const fixtures = path.join(FIXTURES_ROOT, 'office-ocr');
mkdirSync(fixtures, { recursive: true });
const data = ['{', `  "note": ${JSON.stringify(out.note)},`, `  "cases": [\n${out.cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`, '}', ''].join('\n');
writeFileSync(path.join(fixtures, 'golden.json'), data);
writeSetManifest(fixtures, { set: 'office-ocr', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${data.length} bytes, ${out.cases.length} cases`);
