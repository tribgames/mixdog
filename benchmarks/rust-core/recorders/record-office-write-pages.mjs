#!/usr/bin/env node
// What pdf-lib 1.17.1 does to a document's pages, form, attachments and outline the way the Node office PDF code
// drives it (src/runtime/office/pdf/pdf-batch-structure.mjs and pdf-edit-document.mjs), for the Rust crate mixdog-pdf
// (crates/mixdog-pdf/tests/twin_write_pages.rs replays it):
//   cases  a base document (made by pdf-lib with a form, widgets on two pages, a link annotation, or written by hand
//          with a page tree that inherits its boxes and rotation), the batch operations run on it by the product's own
//          STRUCTURE_OPERATIONS (delete, move, extract in place and to a new file, merge with and without bookmarks,
//          rotate, crop, bookmark, attach, extract an attachment), the files those operations read (sources,
//          attachments), the result each operation returned, and a structural summary of what pdf-lib reads from the
//          document it saved: page count, boxes, rotation and annotation subtypes of every page, the form fields with
//          their names, types and values, the attachments with their bytes, the top-level outline with the page each
//          item opens. Files the operations wrote beside the document (an extracted subset, an extracted attachment)
//          are recorded the same way.
//
//   node benchmarks/rust-core/recorders/record-office-write-pages.mjs --tree <product tree with node_modules>
//   node benchmarks/rust-core/recorders/record-office-write-pages.mjs --tree <tree> --verify <dir>
//
// Output: native/core/fixtures/office-write-pages/golden.json (and its MANIFEST.json). With --verify the recorder only
// prints, as JSON on standard output, the summary pdf-lib reads from every .pdf file in <dir> (the live test has
// pdf-lib open what the Rust writer wrote). The product tree is only read.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const require = createRequire(join(tree, 'package.json'));
const { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, degrees } = require('pdf-lib');

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const rect = ({ x, y, width, height }) => [x, y, width, height];

const { STRUCTURE_OPERATIONS } = await importFrom(tree, 'src/runtime/office/pdf/pdf-batch-structure.mjs');
const { attachmentBytes, attachmentEntries, loadPdf } = await importFrom(tree, 'src/runtime/office/pdf/pdf-edit-document.mjs');
const { SAVE_OPTIONS } = await importFrom(tree, 'src/runtime/office/pdf/pdf-draw.mjs');

// ---- the summary -------------------------------------------------------------------------------------------------------
const fieldKind = (field) => {
  const name = field.constructor.name;
  if (name === 'PDFTextField') return 'Tx';
  if (name === 'PDFDropdown' || name === 'PDFOptionList') return 'Ch';
  if (name === 'PDFSignature') return 'Sig';
  return 'Btn';
};

const valueText = (value) => {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  if (value instanceof PDFName) return value.decodeText();
  if (value instanceof PDFNumber) return String(value.asNumber());
  return null;
};

const annotationSubtypes = (page) => {
  const annots = page.node.Annots();
  const kinds = [];
  for (let index = 0; annots && index < annots.size(); index += 1) {
    const annot = page.doc.context.lookup(annots.get(index));
    const subtype = annot instanceof PDFDict ? annot.get(PDFName.of('Subtype')) : undefined;
    kinds.push(subtype instanceof PDFName ? subtype.decodeText() : null);
  }
  return kinds;
};

const outlineItems = (document) => {
  const { context, catalog } = document;
  const root = catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  const items = [];
  if (!root) return items;
  const pages = document.getPages().map((page) => String(page.ref));
  const seen = new Set();
  let ref = root.get(PDFName.of('First'));
  while (ref instanceof PDFRef && !seen.has(String(ref))) {
    seen.add(String(ref));
    const item = context.lookup(ref, PDFDict);
    const title = item.lookupMaybe(PDFName.of('Title'), PDFString, PDFHexString);
    const dest = item.lookupMaybe(PDFName.of('Dest'), PDFArray);
    const target = dest?.get(0);
    items.push({ title: title ? title.decodeText() : '', page: target instanceof PDFRef ? pages.indexOf(String(target)) : -1 });
    ref = item.get(PDFName.of('Next'));
  }
  return items;
};

// The facts the office code observes, read from a document pdf-lib has open.
const summarize = (document) => ({
  pageCount: document.getPageCount(),
  pages: document.getPages().map((page) => ({
    mediaBox: rect(page.getMediaBox()),
    cropBox: rect(page.getCropBox()),
    rotation: page.getRotation().angle,
    annotations: annotationSubtypes(page),
  })),
  fields: document.catalog.getAcroForm()
    ? document.getForm().getFields().map((field) => ({
        name: field.getName(),
        type: fieldKind(field),
        value: valueText(field.acroField.V()),
      }))
    : null,
  attachments: attachmentEntries(document).map((entry) => ({
    name: entry.name,
    description: entry.description,
    bytes: b64(attachmentBytes(entry.spec) ?? Buffer.alloc(0)),
  })),
  outline: outlineItems(document),
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

const recorder = 'benchmarks/rust-core/recorders/record-office-write-pages.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-write-pages');
const stage = stageSet(finalDir);

// ---- base documents --------------------------------------------------------------------------------------------------
const CLASSIC = { useObjectStreams: false, addDefaultPage: false };

// Two pages: `name` and `both` (two widgets, one on each page) on the first, a link annotation too; `city`, `agree`
// (checked) and `both` on the second.
const formDocument = async () => {
  const document = await PDFDocument.create({ updateMetadata: false });
  const first = document.addPage([612, 792]);
  const second = document.addPage([500, 400]);
  const form = document.getForm();
  const name = form.createTextField('name');
  name.setText('Ada');
  name.addToPage(first, { x: 50, y: 700, width: 200, height: 20 });
  const both = form.createTextField('both');
  both.setText('shared');
  both.addToPage(first, { x: 50, y: 650, width: 200, height: 20 });
  both.addToPage(second, { x: 50, y: 350, width: 200, height: 20 });
  const city = form.createTextField('city');
  city.setText('Paris');
  city.addToPage(second, { x: 50, y: 300, width: 200, height: 20 });
  const agree = form.createCheckBox('agree');
  agree.check();
  agree.addToPage(second, { x: 50, y: 250, width: 20, height: 20 });
  const link = document.context.register(
    document.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], Border: [0, 0, 0] })
  );
  first.node.addAnnot(link);
  return Buffer.from(await document.save(CLASSIC));
};

// Three pages of different sizes and turns.
const plainDocument = async () => {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.addPage([612, 792]);
  document.addPage([595.5, 842]).setRotation(degrees(90));
  const third = document.addPage([200, 300]);
  third.setCropBox(10, 10, 150, 250);
  return Buffer.from(await document.save(CLASSIC));
};

// A page tree two levels deep whose pages inherit their boxes, rotation and resources.
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

const inheritedDocument = () =>
  handWritten(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 3 /MediaBox [0 0 300 400] /Rotate 180 /Resources << /ProcSet [/PDF] >> >>'],
      [3, '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R 6 0 R] /Count 2 /CropBox [5 5 295 395] >>'],
      [4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] /Annots [7 0 R] >>'],
      [5, '<< /Type /Page /Parent 3 0 R >>'],
      [6, '<< /Type /Page /Parent 3 0 R /Rotate 270 /MediaBox [0 0 50 60] >>'],
      [7, '<< /Type /Annot /Subtype /Text /Rect [1 1 20 20] /Contents (Note) /P 4 0 R >>'],
    ],
    '/Root 1 0 R'
  );

const NOTE = Buffer.from(['The quarterly notes.', 'Second line, with ünïcode.', ''].join(String.fromCharCode(10)), 'utf8');
const BLOB = Buffer.from(Array.from({ length: 300 }, (_, index) => (index * 7) % 256));

// Two attachments already in the file (pdf-lib embeds at save time, so a batch cannot read back what it attached).
const attachedDocument = async () => {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.addPage([300, 200]);
  await document.attach(NOTE, 'notes.txt', { mimeType: 'text/plain', description: 'Quarterly notes' });
  await document.attach(BLOB, 'data.bin', { mimeType: 'application/octet-stream' });
  return Buffer.from(await document.save(CLASSIC));
};

const BASES = {
  'form.pdf': await formDocument(),
  'plain.pdf': await plainDocument(),
  'inherited.pdf': inheritedDocument(),
  'attached.pdf': await attachedDocument(),
};
const FILES = { 'note.txt': NOTE, 'blob.bin': BLOB, ...BASES };

// ---- cases -----------------------------------------------------------------------------------------------------------
const cases = [
  { name: 'delete-second-page-of-a-form', base: 'form.pdf', ops: [{ op: 'delete_pages', pages: [2] }] },
  { name: 'delete-first-page-of-a-form', base: 'form.pdf', ops: [{ op: 'delete_pages', pages: [1] }] },
  { name: 'delete-from-an-inheriting-tree', base: 'inherited.pdf', ops: [{ op: 'delete_pages', pages: [1, 2] }] },
  { name: 'move-a-form-page-last', base: 'form.pdf', ops: [{ op: 'move_page', page: 1, index: 2 }] },
  { name: 'move-in-a-plain-document', base: 'plain.pdf', ops: [{ op: 'move_page', page: 3, index: 1 }] },
  { name: 'extract-in-place-twice-the-same-page', base: 'form.pdf', ops: [{ op: 'extract_pages', pages: [2, 1, 2] }] },
  { name: 'extract-in-place-a-subset', base: 'plain.pdf', ops: [{ op: 'extract_pages', pages: [3, 1] }] },
  { name: 'extract-to-a-new-file', base: 'form.pdf', ops: [{ op: 'extract_pages', pages: [2], output: 'part.pdf' }] },
  { name: 'extract-inherited-pages-to-a-new-file', base: 'inherited.pdf', ops: [{ op: 'extract_pages', pages: [1, 3], output: 'part.pdf' }] },
  { name: 'merge-a-form-at-the-end', base: 'plain.pdf', ops: [{ op: 'merge_pdf', sources: ['form.pdf'] }] },
  {
    name: 'merge-two-copies-of-a-form-with-bookmarks',
    base: 'plain.pdf',
    ops: [{ op: 'merge_pdf', sources: [{ path: 'form.pdf', title: 'First copy' }, { path: 'form.pdf', pages: [2] }], bookmarks: true }],
  },
  { name: 'merge-at-an-index-into-a-nested-tree', base: 'inherited.pdf', ops: [{ op: 'merge_pdf', sources: [{ path: 'plain.pdf', pages: [1, 3] }], index: 2 }] },
  { name: 'merge-at-the-front', base: 'inherited.pdf', ops: [{ op: 'merge_pdf', path: 'plain.pdf', index: 1 }] },
  { name: 'merge-a-form-into-itself', base: 'form.pdf', ops: [{ op: 'merge_pdf', sources: ['form.pdf'] }] },
  { name: 'rotate-some-pages', base: 'plain.pdf', ops: [{ op: 'rotate_pages', pages: [1, 3], rotation: 90 }] },
  { name: 'rotate-absolute', base: 'plain.pdf', ops: [{ op: 'rotate_pages', rotation: 270, absolute: true }] },
  { name: 'crop-with-a-margin', base: 'plain.pdf', ops: [{ op: 'crop_pages', pages: [1, 3], margin: 10 }] },
  { name: 'crop-a-turned-page-by-displayed-sides', base: 'plain.pdf', ops: [{ op: 'crop_pages', pages: [2], left: 5, top: 20 }] },
  { name: 'crop-an-inheriting-page', base: 'inherited.pdf', ops: [{ op: 'crop_pages', pages: [2], left: 3, right: 4, bottom: 5 }] },
  {
    name: 'bookmark-a-document-without-an-outline',
    base: 'plain.pdf',
    ops: [{ op: 'add_bookmark', title: 'Intro', page: 1 }, { op: 'add_bookmark', title: '한글 장', page: 3 }],
  },
  {
    name: 'bookmark-after-merge-bookmarks',
    base: 'plain.pdf',
    ops: [
      { op: 'merge_pdf', sources: [{ path: 'form.pdf', title: 'Form' }], bookmarks: true },
      { op: 'add_bookmark', title: 'Later', page: 2 },
    ],
  },
  {
    name: 'attach-two-files',
    base: 'plain.pdf',
    ops: [
      { op: 'add_attachment', path: 'note.txt', name: 'notes.txt', mimeType: 'text/plain', description: 'Quarterly notes' },
      { op: 'add_attachment', path: 'blob.bin' },
    ],
  },
  {
    name: 'extract-attachments',
    base: 'attached.pdf',
    ops: [
      { op: 'extract_attachment', name: 'notes.txt', output: 'out-notes.txt' },
      { op: 'extract_attachment', index: 2, output: 'out-data.bin' },
    ],
  },
  {
    name: 'attach-to-a-document-that-has-attachments',
    base: 'attached.pdf',
    ops: [{ op: 'add_attachment', path: 'note.txt', name: 'second-notes.txt', mimeType: 'text/plain', description: 'Again' }],
  },
  {
    name: 'delete-and-attach-in-a-form',
    base: 'form.pdf',
    ops: [{ op: 'delete_pages', pages: [1] }, { op: 'add_attachment', path: 'note.txt', name: 'kept.txt', mimeType: 'text/plain' }],
  },
];

const results = [];
const work = mkdtempSync(join(FIXTURES_ROOT, '.write-pages-'));
try {
  for (const entry of cases) {
    const folder = join(work, entry.name);
    mkdirSync(folder, { recursive: true });
    for (const [file, bytes] of Object.entries(FILES)) writeFileSync(join(folder, file), bytes);
    const path = join(folder, 'document.pdf');
    writeFileSync(path, BASES[entry.base]);
    const document = await loadPdf(BASES[entry.base]);
    const state = { document, path, source: BASES[entry.base] };
    const returned = [];
    for (const op of entry.ops) {
      const done = await STRUCTURE_OPERATIONS[op.op](state, op);
      returned.push({
        op: op.op,
        ...(done.count !== undefined ? { count: done.count } : {}),
        ...(done.pagesAdded !== undefined ? { pagesAdded: done.pagesAdded } : {}),
        ...(done.formFields !== undefined ? { formFields: done.formFields } : {}),
        ...(done.pageCount !== undefined ? { pageCount: done.pageCount } : {}),
        ...(done.bookmarks !== undefined ? { bookmarks: done.bookmarks } : {}),
      });
    }
    const saved = Buffer.from(await document.save(SAVE_OPTIONS));
    const outputs = {};
    for (const file of readdirSync(folder)) {
      if (file in FILES || file === 'document.pdf') continue;
      const bytes = readFileSync(join(folder, file));
      outputs[file] = file.endsWith('.pdf') ? { pdf: b64(bytes), summary: summarize(await openedForReading(bytes)) } : { bytes: b64(bytes) };
    }
    results.push({
      name: entry.name,
      base: entry.base,
      ops: entry.ops,
      returned,
      pdf: b64(saved),
      summary: summarize(await openedForReading(saved)),
      outputs,
    });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

writeJson(join(stage, 'golden.json'), {
  files: Object.fromEntries(Object.entries(FILES).map(([name, bytes]) => [name, { bytes: b64(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }])),
  cases: results,
});
writeSetManifest(stage, { set: 'office-write-pages', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
