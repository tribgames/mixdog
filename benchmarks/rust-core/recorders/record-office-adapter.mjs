#!/usr/bin/env node
// Golden of the office PDF session surface (crate mixdog-office-pdf: adapter, structure, safety). The Node functions of
// src/runtime/office/pdf/pdf-adapter.mjs (snapshotPdf, validatePdf, issuesPdf, applyPdfBatch with the structure
// operations of pdf-batch-structure.mjs) run over generated PDFs and give the results Rust must equal exactly, with the
// structural summary of every PDF a batch left behind (page boxes and turns, form field names, attachments, bookmarks,
// metadata). The inputs are stored in the golden (hex), so a replay needs no Node.
//
// Not recorded: pdf-security.mjs runs qpdf, which a recording must not depend on (its arguments, response file and
// refusals are tested without it in tests/security.rs); an encrypted file needs qpdf to be made.
//
//   node benchmarks/rust-core/recorders/record-office-adapter.mjs --tree <product tree>
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-adapter.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const adapter = await importFrom(tree, 'src/runtime/office/pdf/pdf-adapter.mjs');
const edit = await importFrom(tree, 'src/runtime/office/pdf/pdf-edit-document.mjs');
const analysis = await importFrom(tree, 'src/runtime/office/pdf/pdf-analysis.mjs');
const { snapshotPdf, validatePdf, issuesPdf, applyPdfBatch } = adapter;
const pdfLib = createRequire(path.join(tree, 'package.json'))('pdf-lib');
const { PDFDocument, PDFName, PDFString, StandardFonts, degrees } = pdfLib;

const work = mkdtempSync(path.join(tmpdir(), 'record-office-adapter-'));
// A path inside the work folder is shown as the case folder it sits in: <case>/sub/file.pdf.
const shown = (value) =>
  JSON.parse(
    JSON.stringify(value)
      .split(JSON.stringify(work).slice(1, -1))
      .join('<work>')
      .replace(/\\\\/g, '/')
      .replace(/<work>\/case-\d+/g, '<case>'),
  );

// ---- the generated PDFs --------------------------------------------------------------------------------------------

async function newDocument() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, font };
}

const lines = (page, font, rows) => rows.forEach((row, index) => page.drawText(row, { x: 72, y: page.getHeight() - 72 - index * 16, size: 12, font }));
const save = async (doc) => Buffer.from(await doc.save());

const fixtures = {};
const fixture = async (name, build) => {
  const { doc, font } = await newDocument();
  await build(doc, font);
  fixtures[name] = await save(doc);
};

await fixture('text3', async (doc, font) => {
  lines(doc.addPage([612, 792]), font, ['Hello World', 'Second  line   of body text', 'A third line']);
  lines(doc.addPage([400, 300]), font, ['Page two', 'lorem ipsum filler text here', 'TODO write this page']);
  doc.addPage([300, 300]);
});

await fixture('rich', async (doc, font) => {
  lines(doc.addPage([612, 792]), font, ['Report title', 'Introduction']);
  lines(doc.addPage([612, 792]), font, ['Chapter two', 'Details follow']);
  const third = doc.addPage([612, 792]);
  lines(third, font, ['Chapter three']);
  third.setRotation(degrees(90));
  doc.setTitle('The Title');
  doc.setAuthor('An Author');
  doc.setSubject('A Subject');
  doc.setKeywords(['one', 'two']);
  await doc.attach(Buffer.from('attached text'), 'note.txt', { mimeType: 'text/plain', description: 'a note' });
  edit.addOutlineEntries(doc, [
    { title: 'Introduction', pageIndex: 0 },
    { title: 'Chapter two', pageIndex: 1 },
  ]);
});

await fixture('offset', async (doc, font) => {
  const page = doc.addPage([500, 400]);
  lines(page, font, ['Cropped page text']);
  page.setCropBox(10, 20, 300, 200);
  const second = doc.addPage([500, 400]);
  second.setRotation(degrees(270));
  lines(second, font, ['Turned page text']);
});

await fixture('form', async (doc, font) => {
  const form = doc.getForm();
  const first = doc.addPage([612, 792]);
  lines(first, font, ['Application form']);
  form.createTextField('name').addToPage(first, { x: 72, y: 600, width: 200, height: 20 });
  form.createCheckBox('agree').addToPage(first, { x: 72, y: 560, width: 12, height: 12 });
  const second = doc.addPage([612, 792]);
  lines(second, font, ['Second page']);
  form.createTextField('email').addToPage(second, { x: 72, y: 600, width: 200, height: 20 });
});

await fixture('other', async (doc, font) => {
  lines(doc.addPage([612, 792]), font, ['Other one']);
  lines(doc.addPage([612, 792]), font, ['Other two']);
});

await fixture('active', async (doc, font) => {
  const page = doc.addPage([612, 792]);
  lines(page, font, ['Active content']);
  const context = doc.context;
  doc.catalog.set(PDFName.of('OpenAction'), context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
  doc.catalog.set(PDFName.of('AA'), context.obj({}));
  doc.catalog.set(PDFName.of('Names'), context.obj({ JavaScript: context.obj({}) }));
  const link = (action) => context.register(context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: action }));
  page.node.set(
    PDFName.of('Annots'),
    context.obj([
      link({ S: 'URI', URI: PDFString.of('https://example.test/ok') }),
      link({ S: 'URI', URI: PDFString.of('file:///etc/passwd') }),
      link({ S: 'Launch' }),
      link({ S: 'GoToR' }),
      link({ S: 'URI', URI: PDFString.of('  ') }),
    ]),
  );
});

// ---- helpers -------------------------------------------------------------------------------------------------------

const hex = (buffer) => Buffer.from(buffer).toString('hex');
const attempt = async (run) => {
  try {
    return { result: await run() };
  } catch (error) {
    return { error: { name: String(error?.name ?? 'Error'), message: String(error?.message ?? error) } };
  }
};

/** What a PDF left behind looks like to the structure: boxes, turns, fields, attachments, bookmarks, metadata. */
async function summarize(file) {
  const bytes = readFileSync(file);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const box = (rect) => [rect.x, rect.y, rect.width, rect.height];
  const attachments = edit.attachmentEntries(doc).map((entry) => ({
    name: entry.name,
    description: entry.description,
    hex: hex(edit.attachmentBytes(entry.spec) ?? Buffer.alloc(0)),
  }));
  const outline = (await analysis.extractPdfOutline(file)).entries;
  return {
    pages: doc.getPages().map((page) => ({ media: box(page.getMediaBox()), crop: box(page.getCropBox()), rotation: page.getRotation().angle })),
    fields: doc.getForm().getFields().map((field) => field.getName()),
    attachments,
    outline,
    metadata: { title: doc.getTitle() ?? '', author: doc.getAuthor() ?? '', subject: doc.getSubject() ?? '', keywords: doc.getKeywords() ?? '' },
  };
}

const pdfFiles = (directory) =>
  readdirSync(directory, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => !statSync(path.join(directory, entry)).isDirectory() && /\.pdf$|\.txt$/.test(entry))
    .sort();

let caseNumber = 0;
const caseDirectory = (files) => {
  caseNumber += 1;
  const directory = path.join(work, `case-${caseNumber}`);
  mkdirSync(directory, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    if (fixtures[source]) writeFileSync(path.join(directory, name), fixtures[source]);
    else writeFileSync(path.join(directory, name), source);
  }
  return directory;
};

// ---- snapshots, validation, audits ---------------------------------------------------------------------------------

const out = { fixtures: {}, snapshots: [], validations: [], issues: [], batches: [] };
const snapshotCases = [
  ['text3-default', 'text3', {}],
  ['text3-paged-first', 'text3', { paged: true, limit: 2 }],
  ['text3-paged-second', 'text3', { paged: true, offset: 2, limit: 5 }],
  ['text3-pages', 'text3', { pages: [3, 1] }],
  ['text3-small-budget', 'text3', { maxChars: 1 }],
  ['text3-out-of-range', 'text3', { pages: [9] }],
  ['text3-fractional', 'text3', { pages: [1.5] }],
  ['rich-default', 'rich', {}],
  ['rich-no-outline', 'rich', { outline: false }],
  ['offset-default', 'offset', {}],
  ['other-default', 'other', {}],
];
for (const [name, source, options] of snapshotCases) {
  const directory = caseDirectory({ 'doc.pdf': source });
  out.snapshots.push({ name, fixture: source, options, ...shown(await attempt(() => snapshotPdf(path.join(directory, 'doc.pdf'), options))) });
}
for (const source of ['text3', 'rich', 'offset', 'other']) {
  const directory = caseDirectory({ 'doc.pdf': source });
  out.validations.push({ name: source, fixture: source, ...shown(await attempt(() => validatePdf(path.join(directory, 'doc.pdf')))) });
}
for (const [name, source, options] of [
  ['text3-audit', 'text3', {}],
  ['rich-audit', 'rich', {}],
  ['active-audit', 'active', {}],
  ['text3-audit-pages', 'text3', { pages: [2] }],
]) {
  const directory = caseDirectory({ 'doc.pdf': source });
  out.issues.push({ name, fixture: source, options, ...shown(await attempt(() => issuesPdf(path.join(directory, 'doc.pdf'), options))) });
}

// ---- batches of structure operations -------------------------------------------------------------------------------

const batchCases = [
  ['rotate', { 'doc.pdf': 'rich' }, [{ op: 'rotate_pages', pages: [1], rotation: 90 }, { op: 'rotate_pages', page: 3, rotation: -90, absolute: true }, { op: 'rotate_pages' }]],
  ['rotate-not-a-quarter-turn', { 'doc.pdf': 'rich' }, [{ op: 'rotate_pages', rotation: 45 }]],
  ['crop', { 'doc.pdf': 'offset' }, [{ op: 'crop_pages', margin: 10 }, { op: 'crop_pages', page: 1, left: 5, bottom: 2.5 }]],
  ['crop-nothing', { 'doc.pdf': 'offset' }, [{ op: 'crop_pages' }]],
  ['crop-everything', { 'doc.pdf': 'offset' }, [{ op: 'crop_pages', page: 1, margin: 200 }]],
  ['crop-negative', { 'doc.pdf': 'offset' }, [{ op: 'crop_pages', left: -1 }]],
  ['delete', { 'doc.pdf': 'text3' }, [{ op: 'delete_pages', pages: [2] }]],
  ['delete-form-page', { 'doc.pdf': 'form' }, [{ op: 'delete_pages', page: 2 }]],
  ['delete-all', { 'doc.pdf': 'text3' }, [{ op: 'delete_pages' }]],
  ['extract-to-file', { 'doc.pdf': 'text3' }, [{ op: 'extract_pages', pages: [3, 1], output: 'sub/extracted.pdf' }]],
  ['extract-form-to-file', { 'doc.pdf': 'form' }, [{ op: 'extract_pages', page: 2, output: 'second.pdf' }]],
  ['extract-in-place', { 'doc.pdf': 'text3' }, [{ op: 'extract_pages', pages: [3, 1, 1] }]],
  ['extract-in-place-form', { 'doc.pdf': 'form' }, [{ op: 'extract_pages', pages: [1, 1] }]],
  ['extract-onto-itself', { 'doc.pdf': 'text3' }, [{ op: 'extract_pages', page: 1, output: 'DOC.PDF' }]],
  ['split', { 'doc.pdf': 'text3' }, [{ op: 'split_pages', every: 2, output: 'parts' }]],
  ['split-singles', { 'doc.pdf': 'text3' }, [{ op: 'split_pages' }]],
  ['split-one-group', { 'doc.pdf': 'text3' }, [{ op: 'split_pages', every: 99 }]],
  ['move', { 'doc.pdf': 'text3' }, [{ op: 'move_page', page: 1, index: 3 }, { op: 'move_page', page: 2, index: 2 }]],
  ['move-form', { 'doc.pdf': 'form' }, [{ op: 'move_page', page: 1, index: 2 }]],
  ['move-out-of-range', { 'doc.pdf': 'text3' }, [{ op: 'move_page', page: 1, index: 9 }]],
  ['move-from-out-of-range', { 'doc.pdf': 'text3' }, [{ op: 'move_page', index: 1 }]],
  ['merge', { 'doc.pdf': 'text3', 'other.pdf': 'other' }, [{ op: 'merge_pdf', path: 'other.pdf' }]],
  ['merge-selection-and-index', { 'doc.pdf': 'text3', 'other.pdf': 'other', 'rich.pdf': 'rich' }, [{ op: 'merge_pdf', index: 1, bookmarks: true, sources: [{ path: 'other.pdf', pages: [2], title: 'Second of other' }, 'rich.pdf'] }]],
  ['merge-forms', { 'doc.pdf': 'form', 'again.pdf': 'form' }, [{ op: 'merge_pdf', sources: ['again.pdf', 'again.pdf'] }]],
  ['merge-without-sources', { 'doc.pdf': 'text3' }, [{ op: 'merge_pdf' }]],
  ['merge-bad-index', { 'doc.pdf': 'text3', 'other.pdf': 'other' }, [{ op: 'merge_pdf', path: 'other.pdf', index: 9 }]],
  ['bookmark', { 'doc.pdf': 'rich' }, [{ op: 'add_bookmark', title: '  Appendix  ', page: 3 }]],
  ['bookmark-without-title', { 'doc.pdf': 'rich' }, [{ op: 'add_bookmark', page: 1 }]],
  ['bookmark-without-page', { 'doc.pdf': 'rich' }, [{ op: 'add_bookmark', title: 'x' }]],
  ['metadata', { 'doc.pdf': 'rich' }, [{ op: 'set_metadata', properties: { title: 'New', author: 'Me', keywords: ['a', 'b'], creator: 'Tool', other: 1 } }]],
  ['metadata-nothing', { 'doc.pdf': 'rich' }, [{ op: 'set_metadata', properties: { other: 1 } }]],
  ['attach', { 'doc.pdf': 'text3', 'data.txt': 'file contents' }, [{ op: 'add_attachment', path: 'data.txt', description: 'data', mimeType: 'text/plain' }]],
  ['attach-named', { 'doc.pdf': 'rich', 'data.txt': 'file contents' }, [{ op: 'add_attachment', path: 'data.txt', name: 'renamed.bin' }]],
  ['extract-attachment-by-name', { 'doc.pdf': 'rich' }, [{ op: 'extract_attachment', name: 'note.txt', output: 'out/back.txt' }]],
  ['extract-attachment-by-index', { 'doc.pdf': 'rich' }, [{ op: 'extract_attachment', index: 1 }]],
  ['extract-attachment-missing', { 'doc.pdf': 'rich' }, [{ op: 'extract_attachment', name: 'nope' }]],
  ['extract-attachment-none', { 'doc.pdf': 'text3' }, [{ op: 'extract_attachment', index: 1 }]],
  ['compress', { 'doc.pdf': 'rich' }, [{ op: 'compress' }]],
  ['mixed', { 'doc.pdf': 'text3' }, [{ op: 'rotate_pages', page: 1 }, { op: 'delete_pages', page: 3 }, { op: 'add_bookmark', title: 'Start', page: 1 }, { op: 'compress' }]],
  ['unknown-operation', { 'doc.pdf': 'text3' }, [{ op: 'explode' }]],
  ['nothing', { 'doc.pdf': 'text3' }, []],
];
// Sizes depend on the writer; what a compression does is its outcome class, so only that is compared.
const SIZE_KEYS = ['bytesBefore', 'bytesAfter', 'changed', 'grew', 'note'];
for (const [name, files, operations] of batchCases) {
  const directory = caseDirectory(files);
  const document = path.join(directory, 'doc.pdf');
  const before = readFileSync(document);
  const outcome = await attempt(() => applyPdfBatch(document, operations));
  if (outcome.result) {
    outcome.result = outcome.result.map((entry) => (entry.op === 'compress' ? Object.fromEntries(Object.entries(entry).filter(([key]) => !SIZE_KEYS.includes(key))) : entry));
  }
  const outputs = {};
  for (const relative of pdfFiles(directory)) {
    if (relative.endsWith('.txt')) outputs[relative] = { hex: hex(readFileSync(path.join(directory, relative))) };
    else outputs[relative] = await summarize(path.join(directory, relative));
  }
  out.batches.push({
    name,
    files,
    operations,
    unchanged: Buffer.compare(before, readFileSync(document)) === 0,
    ...shown(outcome),
    outputs: shown(outputs),
  });
}

for (const [name, bytes] of Object.entries(fixtures)) out.fixtures[name] = hex(bytes);

rmSync(work, { recursive: true, force: true });

const fixtureDirectory = path.join(FIXTURES_ROOT, 'office-adapter');
mkdirSync(fixtureDirectory, { recursive: true });
const data = `${JSON.stringify(out, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value))}\n`;
writeFileSync(path.join(fixtureDirectory, 'golden.json'), data);
writeSetManifest(fixtureDirectory, { set: 'office-adapter', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(
  `golden.json ${data.length} bytes, ${out.snapshots.length} snapshots, ${out.validations.length} validations, ${out.issues.length} audits, ${out.batches.length} batches`,
);
