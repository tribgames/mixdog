/**
 * src/runtime/office/pdf/pdf-batch-structure.mjs - batch operations on the
 * document's structure: page order and rotation, extraction/splitting,
 * merging, bookmarks, metadata, attachments, and re-serialization. Same
 * handler contract as pdf-batch-content.mjs.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, degrees } from 'pdf-lib';
import { SAVE_OPTIONS, round2 } from './pdf-draw.mjs';
import {
  addOutlineEntries,
  attachmentBytes,
  attachmentEntries,
  loadPdf,
  selectedPages,
  writeSibling,
} from './pdf-edit-document.mjs';

// pdf-lib's removePage keeps its page list cached (insertPage clears it): the rest of the batch read the removed
// page, so text meant for page 2 after a deletion was drawn on the page that had left the file.
function removePageAt(document, index) {
  document.removePage(index);
  document.pageCache.invalidate();
}

// A file of its own for the pages: its widgets join the new file's form, as merge_pdf registers them, or a filled
// page came out showing its values with no fields behind them.
async function copyToNewDocument(document, indexes) {
  const next = await PDFDocument.create();
  const pages = (await next.copyPages(document, indexes)).map((page) => next.addPage(page));
  if (document.catalog.getAcroForm()) registerCopiedFields(next, pages);
  return next;
}

// The document keeps its own pages, in the order asked for (a page named twice is copied), so its form,
// attachments, outline, and metadata stay with it: rebuilt from copied pages, a moved page or an extracted subset
// lost every one of them.
async function keepPagesInOrder(document, indexes) {
  const originals = document.getPages();
  const kept = new Set();
  const wanted = [];
  const copies = [];
  for (const index of indexes) {
    if (kept.has(index)) {
      const [copy] = await document.copyPages(document, [index]);
      copies.push(copy);
      wanted.push(copy);
    } else {
      kept.add(index);
      wanted.push(originals[index]);
    }
  }
  for (let index = originals.length - 1; index >= 0; index -= 1) {
    if (!kept.has(index)) removePageAt(document, index);
  }
  wanted.forEach((page, position) => {
    const current = document.getPages().indexOf(page);
    if (current === position) return;
    if (current >= 0) removePageAt(document, current);
    document.insertPage(position, page);
  });
  if (copies.length) registerCopiedFields(document, copies);
  dropFieldsOffThePages(document);
}

// A field whose widgets sat only on removed pages leaves the form with them, and a widget on a removed page leaves
// its field: left behind, they pointed at pages that no longer exist and flatten_form failed ("Could not find page
// for PDFRef").
function dropFieldsOffThePages(document) {
  if (!document.catalog.getAcroForm()) return;
  const { context } = document;
  const placed = new Set();
  for (const page of document.getPages()) {
    const annots = page.node.Annots();
    for (let index = 0; annots && index < annots.size(); index += 1) placed.add(String(annots.get(index)));
  }
  const form = document.getForm();
  for (const field of form.getFields()) {
    const refs = field.acroField.getWidgets().map((widget) => context.getObjectRef(widget.dict));
    const gone = refs.filter((ref) => ref && !placed.has(String(ref)));
    if (!gone.length) continue;
    if (gone.length === refs.length) {
      form.acroForm.removeField(field.acroField);
      continue;
    }
    const kids = field.acroField.Kids();
    for (const ref of gone) {
      const at = kids ? kids.indexOf(ref) : -1;
      if (at >= 0) kids.remove(at);
    }
  }
}

function rotatePages(state, operation) {
  const { document } = state;
  const delta = Number(operation.rotation ?? 90);
  if (!Number.isInteger(delta) || delta % 90 !== 0)
    throw new Error(`PDF rotation must be a multiple of 90 degrees: ${operation.rotation}`);
  const pages = [];
  for (const { page, index } of selectedPages(document, operation)) {
    const current = page.getRotation().angle;
    const next = (((operation.absolute ? delta : current + delta) % 360) + 360) % 360;
    page.setRotation(degrees(next));
    pages.push({ page: index + 1, from: current, rotation: next });
  }
  return { op: operation.op, changed: pages.some((entry) => entry.from !== entry.rotation), pages };
}

// Which side of the unrotated page each side a reader sees falls on: a page
// turned 90° clockwise shows its own left edge at the top.
const DISPLAYED_SIDES = Object.freeze({
  0: { left: 'left', right: 'right', top: 'top', bottom: 'bottom' },
  90: { top: 'left', right: 'top', bottom: 'right', left: 'bottom' },
  180: { left: 'right', right: 'left', top: 'bottom', bottom: 'top' },
  270: { top: 'right', right: 'bottom', bottom: 'left', left: 'top' },
});
const CROP_SIDES = ['left', 'right', 'top', 'bottom'];

// Trims each selected page by points from the sides as displayed. The media
// box follows the crop box, so the snapshot's width, height, and origin keep
// describing the page a reader sees. The trimmed content stays in the file.
function cropPages(state, operation) {
  const trims = Object.fromEntries(CROP_SIDES.map((side) => [side, Number(operation[side] ?? operation.margin ?? 0)]));
  if (!CROP_SIDES.every((side) => Number.isFinite(trims[side]) && trims[side] >= 0)) {
    throw new Error('crop_pages left, right, top, bottom, and margin are points of zero or more');
  }
  if (CROP_SIDES.every((side) => trims[side] === 0)) {
    throw new Error('crop_pages needs left, right, top, bottom, or margin in points');
  }
  const pages = [];
  for (const { page, index } of selectedPages(state.document, operation)) {
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const sides = DISPLAYED_SIDES[rotation] || DISPLAYED_SIDES[0];
    const cut = Object.fromEntries(CROP_SIDES.map((side) => [sides[side], trims[side]]));
    const box = page.getCropBox();
    const width = box.width - cut.left - cut.right;
    const height = box.height - cut.bottom - cut.top;
    if (width < 1 || height < 1) {
      throw new Error(
        `crop_pages would leave page ${index + 1} empty: it is ${round2(box.width)} x ${round2(box.height)} pt before trimming`
      );
    }
    const x = box.x + cut.left;
    const y = box.y + cut.bottom;
    page.setMediaBox(x, y, width, height);
    page.setCropBox(x, y, width, height);
    pages.push({
      page: index + 1,
      from: { width: round2(box.width), height: round2(box.height) },
      to: { width: round2(width), height: round2(height) },
    });
  }
  return { op: operation.op, changed: true, pages };
}

function deletePages(state, operation) {
  const { document } = state;
  const indexes = selectedPages(document, operation)
    .map(({ index }) => index)
    .sort((a, b) => b - a);
  if (indexes.length >= document.getPageCount())
    throw new Error('delete_pages cannot remove every page; use extract_pages or delete fewer pages');
  for (const index of indexes) removePageAt(document, index);
  dropFieldsOffThePages(document);
  return {
    op: operation.op,
    changed: indexes.length > 0,
    count: indexes.length,
    pageCount: document.getPageCount(),
  };
}

async function extractPages(state, operation) {
  const indexes = selectedPages(state.document, operation).map(({ index }) => index);
  const pages = indexes.map((index) => index + 1);
  if (operation.output) {
    // With an output the session document stays whole; the subset is a new file.
    const next = await copyToNewDocument(state.document, indexes);
    const output = await writeSibling(state.path, operation.output, await next.save(SAVE_OPTIONS));
    return { op: operation.op, changed: true, documentChanged: false, output, count: indexes.length, pages };
  }
  await keepPagesInOrder(state.document, indexes);
  return { op: operation.op, changed: true, count: indexes.length, pages };
}

async function splitPages(state, operation) {
  const { document, path } = state;
  const every = Math.max(1, Math.floor(Number(operation.every) || 1));
  const indexes = selectedPages(document, operation).map(({ index }) => index);
  const stem = basename(path, extname(path));
  const directory = resolve(dirname(path), String(operation.output || '.'));
  const files = [];
  for (let start = 0; start < indexes.length; start += every) {
    const group = indexes.slice(start, start + every);
    const part = await copyToNewDocument(document, group);
    const first = String(group[0] + 1).padStart(3, '0');
    const label = group.length === 1 ? first : `${first}-${String(group.at(-1) + 1).padStart(3, '0')}`;
    const output = await writeSibling(path, resolve(directory, `${stem}-${label}.pdf`), await part.save(SAVE_OPTIONS));
    files.push({ output, pages: group.map((index) => index + 1) });
  }
  return { op: operation.op, changed: files.length > 0, documentChanged: false, count: files.length, files };
}

async function movePage(state, operation) {
  const { document } = state;
  const from = Number(operation.page) - 1;
  const to = Number(operation.index) - 1;
  const count = document.getPageCount();
  if (!Number.isInteger(from) || from < 0 || from >= count) throw new Error(`PDF page out of range: ${operation.page}`);
  if (!Number.isInteger(to) || to < 0 || to >= count)
    throw new Error(`PDF destination page out of range: ${operation.index}`);
  const order = document.getPageIndices();
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  await keepPagesInOrder(document, order);
  return { op: operation.op, changed: from !== to, from: from + 1, to: to + 1 };
}

function mergeSources(operation) {
  let sources = [];
  if (Array.isArray(operation.sources) && operation.sources.length) sources = operation.sources;
  else if (operation.path) sources = [operation.path];
  if (!sources.length) throw new Error('merge_pdf needs sources:[path | { path, pages }] or path');
  return sources;
}

// Copying a page copies its widgets and their appearances, but not the form they belong to: a filled application
// merged into a pack still showed its values and had no fields left — nothing to fill again, and a snapshot that
// counted zero. The copied widgets' top fields join the document's form; a name the pack already holds takes a
// numbered suffix so two merged copies of one form stay two sets of fields.
function registerCopiedFields(document, pages) {
  const { context } = document;
  const form = document.getForm();
  const names = new Set(form.getFields().map((field) => field.getName()));
  const roots = new Map();
  for (const page of pages) {
    const annots = page.node.Annots();
    for (let index = 0; annots && index < annots.size(); index += 1) {
      const ref = annots.get(index);
      const widget = context.lookup(ref);
      if (!(ref instanceof PDFRef) || !(widget instanceof PDFDict) || widget.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) continue;
      let fieldRef = ref;
      let field = widget;
      while (field.get(PDFName.of('Parent')) instanceof PDFRef) {
        fieldRef = field.get(PDFName.of('Parent'));
        field = context.lookup(fieldRef);
      }
      roots.set(fieldRef.toString(), { ref: fieldRef, field });
    }
  }
  for (const { ref, field } of roots.values()) {
    const title = field.get(PDFName.of('T'));
    let name = title?.decodeText?.() || '';
    if (name && names.has(name)) {
      let suffix = 2;
      while (names.has(`${name}_${suffix}`)) suffix += 1;
      name = `${name}_${suffix}`;
      field.set(PDFName.of('T'), PDFHexString.fromText(name));
    }
    if (name) names.add(name);
    form.acroForm.addField(ref);
  }
  return roots.size;
}

async function mergePdf(state, operation) {
  const { document, path } = state;
  const sources = mergeSources(operation);
  let insertAt = null;
  if (operation.index != null) {
    insertAt = Number(operation.index) - 1;
    if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > document.getPageCount()) {
      throw new Error(`PDF insertion index out of range: ${operation.index}`);
    }
  }
  const merged = [];
  for (const entry of sources) {
    const sourcePath = resolve(dirname(path), String(typeof entry === 'string' ? entry : entry?.path || ''));
    const other = await loadPdf(await readFile(sourcePath));
    const selection = typeof entry === 'string' ? {} : { pages: entry?.pages, page: entry?.page };
    const indexes = selectedPages(other, selection).map(({ index }) => index);
    const copied = await document.copyPages(other, indexes);
    const firstPage = insertAt == null ? document.getPageCount() : insertAt;
    for (const page of copied) {
      if (insertAt == null) document.addPage(page);
      else {
        document.insertPage(insertAt, page);
        insertAt += 1;
      }
    }
    const formFields = registerCopiedFields(document, copied);
    merged.push({
      path: sourcePath,
      pages: indexes.map((index) => index + 1),
      pagesAdded: copied.length,
      ...(formFields ? { formFields } : {}),
      at: firstPage + 1,
      title: typeof entry === 'string' ? '' : String(entry?.title || ''),
    });
  }
  const pagesAdded = merged.reduce((sum, entry) => sum + entry.pagesAdded, 0);
  const bookmarks =
    operation.bookmarks === true
      ? addOutlineEntries(
          document,
          merged
            .filter((entry) => entry.pagesAdded > 0)
            .map((entry) => ({
              title: entry.title || basename(entry.path, extname(entry.path)),
              pageIndex: entry.at - 1,
            }))
        )
      : 0;
  return {
    op: operation.op,
    changed: pagesAdded > 0,
    pagesAdded,
    sources: merged,
    pageCount: document.getPageCount(),
    ...(operation.bookmarks === true ? { bookmarks } : {}),
  };
}

function addBookmark(state, operation) {
  const title = String(operation.title ?? '').trim();
  if (!title) throw new Error('add_bookmark needs title');
  if (!operation.page) throw new Error('add_bookmark needs page');
  const [{ index }] = selectedPages(state.document, { page: operation.page });
  addOutlineEntries(state.document, [{ title, pageIndex: index }]);
  return { op: operation.op, changed: true, title, page: index + 1 };
}

const METADATA_SETTERS = {
  title: (document, value) => document.setTitle(String(value)),
  author: (document, value) => document.setAuthor(String(value)),
  subject: (document, value) => document.setSubject(String(value)),
  creator: (document, value) => document.setCreator(String(value)),
  keywords: (document, value) => document.setKeywords(Array.isArray(value) ? value.map(String) : [String(value)]),
};

function setMetadata(state, operation) {
  const props = operation.properties || {};
  const applied = [];
  for (const [key, set] of Object.entries(METADATA_SETTERS)) {
    if (props[key] === undefined) continue;
    set(state.document, props[key]);
    applied.push(key);
  }
  return { op: operation.op, changed: applied.length > 0, applied };
}

async function addAttachment(state, operation) {
  const attachmentPath = resolve(dirname(state.path), String(operation.path || ''));
  const name = String(operation.name || basename(attachmentPath));
  await state.document.attach(await readFile(attachmentPath), name, {
    mimeType: String(operation.mimeType || 'application/octet-stream'),
    description: String(operation.description || ''),
  });
  return { op: operation.op, changed: true, name };
}

async function extractAttachment(state, operation) {
  const entries = attachmentEntries(state.document);
  const wanted = entries.find(
    (entry) =>
      (operation.name != null && entry.name === String(operation.name)) ||
      (operation.index != null && entry.index === Number(operation.index))
  );
  if (!wanted) {
    throw new Error(
      `PDF has no attachment ${operation.name ?? operation.index ?? ''}; attachments: ${entries.map((entry) => entry.name).join(', ') || '(none)'}`
    );
  }
  const bytes = attachmentBytes(wanted.spec);
  if (!bytes) throw new Error(`Attachment ${wanted.name} has no embedded file stream`);
  const output = await writeSibling(state.path, operation.output || wanted.name || `attachment-${wanted.index}`, bytes);
  return { op: operation.op, changed: true, documentChanged: false, name: wanted.name, output, bytes: bytes.length };
}

// The batch's final save fills in bytesAfter / changed / note.
function compress(state, operation) {
  return { op: operation.op, changed: true, method: 'object-streams', bytesBefore: state.source.length };
}

export const STRUCTURE_OPERATIONS = {
  rotate_pages: rotatePages,
  crop_pages: cropPages,
  delete_pages: deletePages,
  extract_pages: extractPages,
  split_pages: splitPages,
  move_page: movePage,
  merge_pdf: mergePdf,
  add_bookmark: addBookmark,
  set_metadata: setMetadata,
  add_attachment: addAttachment,
  extract_attachment: extractAttachment,
  compress,
};
