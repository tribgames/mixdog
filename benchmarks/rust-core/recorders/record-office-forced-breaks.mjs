#!/usr/bin/env node
// Golden of the forced page break detection (crate mixdog-office-quality, module forced_breaks): what Node's
// `runtime/office/quality/forced-break-pages.mjs` answers to a fixed corpus: the openings of the elements a kept HTML
// forces onto a new page (inline styles, stylesheet rules, specificity, @media blocks, !important, entities), the openings
// of a docx body (pageBreakBefore, page-break runs), the pages of a preview PDF layout those openings match (running
// head and folio bands, repeated body text), and the whole `forcedBreakPages(session, preview)` over real docx files and
// preview PDFs written here. Writes native/core/fixtures/office-forced-breaks/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-forced-breaks.mjs --tree <product tree>
//
// Every section is a list of cases { input, output | error }; every input is plain JSON (files carry their bytes as base64).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitStage, FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-forced-breaks.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-forced-breaks');
const stage = stageSet(finalDir);
const breaks = await importFrom(tree, 'src/runtime/office/quality/forced-break-pages.mjs');
const JSZip = (await importFrom(tree, 'node_modules/jszip/lib/index.js')).default;

const plain = (value) => JSON.parse(JSON.stringify(value));
const wellFormed = (value) => JSON.parse(JSON.stringify(value), (_key, entry) => (typeof entry === 'string' ? entry.toWellFormed() : entry));
const attempt = async (run) => {
  try {
    return { output: wellFormed(await run()) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const cases = async (inputs, run) => {
  const out = [];
  for (const raw of inputs) {
    const input = plain(raw);
    out.push({ input, ...(await attempt(() => run(plain(input)))) });
  }
  return out;
};

// ---- HTML ---------------------------------------------------------------------------------------------------------------
const htmlInputs = [
  `<html><head><style>
    .chapter { break-before: page; color: #123 }
    h2.part, #appendix { page-break-before: always }
    p { margin: 0 }
  </style></head><body>
    <p>Cover words and the summary.</p>
    <h1 class="chapter">Chapter One &amp; its aim</h1><p>Body.</p>
    <p>Filler paragraph.</p>
    <h2 class="part">Part Two begins here</h2>
    <div id="appendix"><b>Appendix</b> A: the tables</div>
    <p style="break-before: page">Inline break opening</p>
    <p style="page-break-before: avoid">Not a break</p>
  </body></html>`,
  `<style>
    .chapter { break-before: page } .chapter { break-before: auto }
    .part { break-before: auto } .part { break-before: page }
    .both { break-before: page } @media screen { .both { break-before: auto } }
    @media print { .printed { break-before: page } }
    @media screen { .screened { break-before: page } }
    .over { break-before: page } p.over { break-before: auto }
  </style>
  <h1 class="chapter">Overridden chapter</h1>
  <h1 class="part">Effective part</h1>
  <h1 class="both">Print-effective both</h1>
  <h1 class="printed">Printed only rule</h1>
  <h1 class="screened">Screen only rule</h1>
  <p class="over">Higher specificity override</p>
  <h1 class="chapter" style="break-before: page">Inline wins</h1>`,
  `<style>
    .a { break-before: page; break-before: auto }
    .b { break-before: page !important; break-before: auto }
    .c { color: red; break-before: auto; page-break-before: always }
  </style>
  <h1 class="a">Later auto wins</h1>
  <h1 class="b">Important page wins</h1>
  <h1 class="c">Later always wins</h1>`,
  '',
  '<p>No styles at all</p>',
  '<h1 style="break-before:page">ab</h1><h1 style="break-before:page">abc</h1><h1 style="break-before:page"> a b </h1>',
  `<style>@import url("x.css"); @charset "utf-8"; h1 { break-before: page } /* h2 { break-before: page } */</style><h1>Heading one</h1><h2>Commented out</h2>`,
  `<style>@media only screen and (min-width: 1px), print { .x { break-before: page } } @media not print { .y { break-before: page } } @media screen, print { .z { break-before: page } } @media (min-width:1px) { .w { break-before: page } }</style><p class="x">X rule</p><p class="y">Y rule</p><p class="z">Z rule</p><p class="w">W rule</p>`,
  `<style>.p1 { break-before: PAGE } .p2 { BREAK-BEFORE: Always !IMPORTANT } .p3 { break-before: page ! important } .p4 { break-before : left } .p5 { break-before:
page }</style><p class="p1">Upper page</p><p class="p2">Upper always</p><p class="p3">Spaced important</p><p class="p4">Left break</p><p class="p5">Newline value</p>`,
  `<style>div { break-before: page } #only { break-before: auto } div.big { break-before: page }</style><div id="only">Id beats tag</div><div class="big small">Two classes</div><div>Plain div</div>`,
  `<style>.k { break-before: page } .k.m { break-before: auto } </style><p class="k m">Compound rule</p><p class="k">Single class</p><p class="m k">Order free</p>`,
  `<H1 STYLE='break-before: page'>Upper tag single quotes</H1><h2 style="break-before: page">Entities &lt;b&gt; &quot;q&quot; &#39;s&#39; &nbsp;x &unknown; &AMP; done</h2>`,
  `<section style="break-before:page"><h2>Nested <em>inline</em> <b>markup</b> here</h2><p>and a paragraph that is much longer than forty characters in total</p></section>`,
  `<p style="break-before:page">No closing tag text that runs on and on ${'word '.repeat(600)}`,
  `<p style="break-before:page"><style>x{}</style>Skip style <script>var a = 1;</script>then text goes on</p>`,
  `<body style="break-before: page"><title style="break-before:page">T</title><p>Body skipped</p></body>`,
  `<style>h1 { break-before: page; } h1 { page-break-before: avoid }</style><h1>Later avoid wins</h1><h1 style="page-break-before: always">Inline always</h1><h1 style="break-before: auto" class="x">Inline auto</h1>`,
  `<style>.a, .b, ul li, > p, *, [x] { break-before: page }</style><p class="a">Class a</p><p class="b">Class b</p><ul><li>list item</li></ul>`,
  `<style>.x{break-before:page</style><p class="x">Unclosed block</p>`,
  `<style>@media print { .x { break-before: page } .y { break-before: page }</style><p class="x">Unclosed media</p>`,
  `<style>@font-face { font-family: F; src: url(a) } @page { margin: 1cm } .x { break-before: page }</style><p class="x">After at-rules</p>`,
  `<h1 style="break-before:page">${'あいう'.repeat(20)}</h1><h1 style="break-before:page">${'😀'.repeat(30)} tail</h1>`,
  `<p id="a" class="c" style="break-before:page">Attributes in any order</p><p class='c' id='a' style='break-before:page'>Single quoted ones</p>`,
  `<style type="text/css" media="print">.a { break-before: page }</style><p class="a">Media attribute ignored</p>`,
  `<STYLE>.A { break-before: page }</STYLE><p class="A">Upper case class</p><p class="a">Lower case class</p>`,
];
const htmlGrid = [];
let seed = 20260301;
const next = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(next() * list.length)];
const values = ['page', 'always', 'auto', 'avoid', 'left', 'right', 'column', 'PAGE', 'page !important', 'auto !important'];
const properties = ['break-before', 'page-break-before'];
for (let n = 0; n < 60; n += 1) {
  const rules = [];
  const count = 1 + Math.floor(next() * 4);
  for (let r = 0; r < count; r += 1) {
    const selector = pick(['.a', '.b', 'p', 'p.a', '#i', 'p#i', 'p#i.a', '.a.b', 'h1', 'h1.b']);
    const declarations = [];
    for (let d = 0; d < 1 + Math.floor(next() * 3); d += 1) declarations.push(`${pick(properties)}: ${pick(values)}`);
    const rule = `${selector} { ${declarations.join('; ')} }`;
    rules.push(next() < 0.25 ? `@media ${pick(['screen', 'print', 'all', 'screen, print', 'not print'])} { ${rule} }` : rule);
  }
  const elements = [];
  for (let e = 0; e < 5; e += 1) {
    const tag = pick(['p', 'h1', 'div']);
    const id = next() < 0.3 ? ' id="i"' : '';
    const klass = next() < 0.7 ? ` class="${pick(['a', 'b', 'a b'])}"` : '';
    const inline = next() < 0.25 ? ` style="${pick(properties)}: ${pick(values)}"` : '';
    elements.push(`<${tag}${id}${klass}${inline}>Element ${n}-${e} text</${tag}>`);
  }
  htmlGrid.push(`<style>${rules.join('\n')}</style>${elements.join('')}`);
}
const golden = {};
golden.html = await cases([...htmlInputs, ...htmlGrid].map((html) => ({ html })), ({ html }) => breaks.htmlBreakOpenings(html));

// ---- DOCX body ----------------------------------------------------------------------------------------------------------
const docxInputs = [
  `<w:body>
    <w:p><w:r><w:t>Front matter text</w:t></w:r></w:p>
    <w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Chapter Alpha starts</w:t></w:r></w:p>
    <w:p><w:r><w:t>Ordinary paragraph</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>
    <w:p><w:r><w:t>Chapter Beta starts</w:t></w:r></w:p>
    <w:p><w:pPr><w:pageBreakBefore w:val="0"/></w:pPr><w:r><w:t>Switched off paragraph</w:t></w:r></w:p>
  </w:body>`,
  '',
  '<w:body></w:body>',
  `<w:p><w:pPr><w:pageBreakBefore w:val="false"/></w:pPr><w:r><w:t>Off by false</w:t></w:r></w:p><w:p><w:pPr><w:pageBreakBefore w:val="1"/></w:pPr><w:r><w:t>On by one</w:t></w:r></w:p>`,
  `<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p><w:p><w:r><w:t>   </w:t></w:r></w:p><w:p><w:r><w:t>Text after empty ones</w:t></w:r></w:p>`,
  `<w:p><w:r><w:t>Before</w:t><w:br w:type="page"/><w:t>After the page run in one paragraph</w:t></w:r></w:p>`,
  `<w:p><w:r><w:br w:type="page"/></w:r><w:r><w:t xml:space="preserve">Leading break run</w:t></w:r><w:br w:type="page"/><w:r><w:t>Second part follows</w:t></w:r></w:p>`,
  `<w:p><w:r><w:br w:type="column"/><w:t>Column break is none</w:t></w:r></w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>ab</w:t></w:r></w:p><w:p><w:r><w:t>Next one is long enough</w:t></w:r></w:p>`,
  `<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Fish &amp; chips &lt;menu&gt; &quot;quoted&quot; &#39;x&#39;</w:t></w:r></w:p>`,
  `<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Split</w:t></w:r><w:r><w:t> over </w:t></w:r><w:r><w:t>three runs that together exceed the forty character limit</w:t></w:r></w:p>`,
  `<w:pPr><w:pageBreakBefore/></w:pPr><w:p><w:r><w:t>The property is outside any paragraph</w:t></w:r></w:p>`,
  `<w:p w14:paraId="1"><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Paragraph with attributes</w:t></w:r></w:p>`,
  `<w:p><w:pPr><w:pageBreakBefore w:val="0"/><w:pageBreakBefore/></w:pPr><w:r><w:t>Two properties</w:t></w:r></w:p>`,
  `<w:p><w:r><w:t>Plain</w:t></w:r></w:p><w:p><w:r><w:t>Paragraphs</w:t></w:r></w:p>`,
  `<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>${'한글 문단 '.repeat(12)}</w:t></w:r></w:p>`,
];
golden.docx = await cases(docxInputs.map((xml) => ({ xml })), ({ xml }) => breaks.docxBreakOpenings(xml));

// ---- openings against layout pages --------------------------------------------------------------------------------------
const page = (number, ...lines) => ({
  page: number,
  height: 800,
  items: [{ text: 'Annual report', x: 50, top: 20 }, ...lines.map((text, index) => ({ text, x: 50, top: 100 + index * 20 })), { text: String(number), x: 300, top: 780 }],
});
const a4 = (number, ...lines) => ({
  page: number,
  height: 842,
  items: [{ text: 'Annual report', x: 50, top: 20 }, ...lines.map((text, index) => ({ text, x: 57, top: 57 + index * 20 })), { text: String(number), x: 300, top: 800 }],
});
const repeated = [1, 2, 3].map((number) => ({
  page: number,
  height: 800,
  items: [
    { text: 'Annual report', x: 50, top: 20 },
    { text: 'Summary', x: 50, top: 100 },
    { text: `Findings of part ${number}`, x: 50, top: 120 },
    { text: String(number), x: 300, top: 780 },
  ],
}));
const textInputs = [
  { openings: ['Chapter One & its aim', 'Part Two begins here', 'Appendix A: the tables', 'Inline break opening'], pages: [page(1, 'Cover words and the summary.'), page(2, 'Chapter One & its aim', 'Body.', 'Filler paragraph.'), page(3, 'More text of chapter one'), page(4, 'Part Two begins here', 'Appendix', 'A: the tables')] },
  { openings: ['Chapter Alpha starts', 'Chapter Beta starts'], pages: [page(1, 'Front matter text', 'Ordinary paragraph'), page(2, 'Chapter Alpha starts', 'Ordinary paragraph'), page(3, 'Chapter Beta starts', 'Switched off paragraph')] },
  { openings: ['Chapter Two'], pages: [a4(1, 'Intro text'), a4(2, 'Chapter Two', 'Body.'), a4(3, 'More')] },
  { openings: ['Summary'], pages: repeated },
  { openings: ['Annual report overview'], pages: [page(1, 'Annual report overview'), page(2, 'Something else')] },
  { openings: ['Annual reportSomething'], pages: [page(1, 'Annual report overview'), page(2, 'Something else')] },
  { openings: [], pages: [page(1, 'Anything')] },
  { openings: ['Anything'], pages: [] },
  { openings: ['  CHAPter  one '], pages: [page(1, 'chapter', 'ONE', 'more')] },
  { openings: ['Wide'], pages: [{ page: 1, height: 0, items: [{ text: 'Wide', x: 1, top: 2 }] }, { page: 2, items: [{ text: 'Wide', x: 1, top: 2 }] }] },
  { openings: ['Left first'], pages: [{ page: 1, height: 800, items: [{ text: 'first', x: 90, top: 100 }, { text: 'Left ', x: 10, top: 101.5 }] }] },
  { openings: ['Alpha beta'], pages: [{ page: 1, height: 800, items: [{ text: 'beta', x: 60, top: 100 }, { text: 'Alpha ', x: 10, top: 103 }] }] },
  { openings: ['Alpha beta'], pages: [{ page: 1, height: 800, items: [{ text: 'beta', x: 60, top: 100 }, { text: 'Alpha ', x: 10, top: 99 }, { text: 'x', x: 5, top: 101 }] }] },
  { openings: ['7'], pages: [page(1, '7'), page(2, 'Text')] },
  { openings: ['Chapter', 'Text'], pages: [{ page: 5, height: 800, items: [{ text: '- 1 -', x: 1, top: 10 }, { text: 'Chapter', x: 1, top: 200 }] }, { page: 6, height: 800, items: [{ text: '- 2 -', x: 1, top: 10 }, { text: 'Body', x: 1, top: 200 }] }, { page: 7, height: 800, items: [{ text: '- 3 -', x: 1, top: 10 }, { text: 'Text', x: 1, top: 200 }] }] },
  { openings: ['Header'], pages: [{ page: 1, height: 800, items: [{ text: 'Header', x: 1, top: 30 }, { text: 'a', x: 1, top: 200 }] }, { page: 2, height: 800, items: [{ text: 'Header', x: 1, top: 30.4 }, { text: 'b', x: 1, top: 200 }] }, { page: 3, height: 800, items: [{ text: 'Header', x: 1, top: 52 }, { text: 'c', x: 1, top: 200 }] }] },
];
golden.texts = await cases(textInputs, ({ openings, pages }) => [...breaks.forcedBreakPagesFromTexts(openings, pages)]);

// ---- whole sessions over real files -------------------------------------------------------------------------------------
const esc = (text) => String(text).replace(/[\\()]/g, (c) => `\\${c}`);
function pdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((lines, index) => {
    const content = lines.map(({ text, x, top }) => `BT /F1 10 Tf ${x} ${842 - top} Td (${esc(text)}) Tj ET`).join('\n');
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const at = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const pdfPage = (number, ...lines) => [{ text: 'Annual report', x: 50, top: 30 }, ...lines.map((text, index) => ({ text, x: 57, top: 100 + index * 20 })), { text: String(number), x: 300, top: 810 }];
const previewPdf = pdf([pdfPage(1, 'Cover words and the summary'), pdfPage(2, 'Chapter One begins here', 'Body text'), pdfPage(3, 'More of chapter one'), pdfPage(4, 'Part Two begins here', 'Appendix A the tables')]);
const docx = async (body) => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  if (body !== null) zip.file('word/document.xml', `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
};
const docxBody = `<w:p><w:r><w:t>Cover words and the summary</w:t></w:r></w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Chapter One begins here</w:t></w:r></w:p><w:p><w:r><w:t>More of chapter one</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Part Two begins here</w:t></w:r></w:p>`;
const b64 = (buffer) => buffer.toString('base64');
const html = '<style>h2 { break-before: page }</style><h2>Chapter One begins here</h2><p>Body text</p><h2>Part Two begins here</h2>';
const fileInputs = [
  { format: 'docx', docx: b64(await docx(docxBody)), pdf: b64(previewPdf), images: 4 },
  { format: 'docx', docx: b64(await docx(docxBody)), html, pdf: b64(previewPdf), images: 4 },
  { format: 'docx', docx: b64(await docx(docxBody)), html, htmlSourceEdits: true, pdf: b64(previewPdf), images: 4 },
  { format: 'docx', docx: b64(await docx(null)), pdf: b64(previewPdf), images: 4 },
  { format: 'pdf', html, pdf: b64(previewPdf), images: 4 },
  { format: 'pdf', html, htmlSourceEdits: true, pdf: b64(previewPdf), images: 4 },
  { format: 'pdf', pdf: b64(previewPdf), images: 4 },
  { format: 'pdf', html, pdf: b64(previewPdf), images: 0 },
  { format: 'pdf', html, pdf: b64(previewPdf), images: 4, exportAvailable: false },
  { format: 'pdf', html, pdf: b64(previewPdf), images: 4, exportAvailable: true, output: 'preview.PDF' },
  { format: 'pdf', html, pdf: b64(previewPdf), images: 4, output: 'preview.png' },
  { format: 'pdf', html, pdf: b64(previewPdf), images: 4, output: '' },
  { format: 'xlsx', html, pdf: b64(previewPdf), images: 4 },
  { format: 'pptx', docx: b64(await docx(docxBody)), pdf: b64(previewPdf), images: 4 },
];
const scratch = mkdtempSync(join(tmpdir(), 'forced-breaks-'));
try {
  golden.files = await cases(fileInputs, async (input) => {
    const target = join(scratch, 'doc.docx');
    const htmlSource = join(scratch, 'doc.html');
    const output = input.output === '' ? '' : join(scratch, input.output ?? 'preview.pdf');
    for (const name of [target, htmlSource, output]) if (name) rmSync(name, { force: true });
    if (input.docx) writeFileSync(target, Buffer.from(input.docx, 'base64'));
    if (input.html) writeFileSync(htmlSource, input.html);
    if (input.pdf && output) writeFileSync(output, Buffer.from(input.pdf, 'base64'));
    const session = { format: input.format, target, htmlSource: input.html ? htmlSource : undefined, htmlSourceEdits: input.htmlSourceEdits };
    const preview = { _images: Array.from({ length: input.images }, () => ({})), output, exportAvailable: input.exportAvailable };
    const found = await breaks.forcedBreakPages(session, preview);
    return found === null ? null : [...found];
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-forced-breaks', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`golden.json: ${Object.entries(golden).map(([name, list]) => `${name} ${list.length}`).join(', ')}`);
