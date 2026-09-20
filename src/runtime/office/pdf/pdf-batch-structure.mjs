/**
 * src/runtime/office/pdf/pdf-batch-structure.mjs - batch operations on the
 * document's structure: page order and rotation, extraction/splitting,
 * merging, bookmarks, metadata, attachments, and re-serialization. Same
 * handler contract as pdf-batch-content.mjs.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';
import { SAVE_OPTIONS } from './pdf-draw.mjs';
import {
  addOutlineEntries,
  attachmentBytes,
  attachmentEntries,
  loadPdf,
  selectedPages,
  writeSibling,
} from './pdf-edit-document.mjs';

async function copyToNewDocument(document, indexes) {
  const next = await PDFDocument.create();
  for (const page of await next.copyPages(document, indexes)) next.addPage(page);
  return next;
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

function deletePages(state, operation) {
  const { document } = state;
  const indexes = selectedPages(document, operation)
    .map(({ index }) => index)
    .sort((a, b) => b - a);
  if (indexes.length >= document.getPageCount())
    throw new Error('delete_pages cannot remove every page; use extract_pages or delete fewer pages');
  for (const index of indexes) document.removePage(index);
  return {
    op: operation.op,
    changed: indexes.length > 0,
    count: indexes.length,
    pageCount: document.getPageCount(),
  };
}

async function extractPages(state, operation) {
  const indexes = selectedPages(state.document, operation).map(({ index }) => index);
  const next = await copyToNewDocument(state.document, indexes);
  const pages = indexes.map((index) => index + 1);
  if (operation.output) {
    // With an output the session document stays whole; the subset is a new file.
    const output = await writeSibling(state.path, operation.output, await next.save(SAVE_OPTIONS));
    return { op: operation.op, changed: true, documentChanged: false, output, count: indexes.length, pages };
  }
  state.document = next;
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
  state.document = await copyToNewDocument(document, order);
  return { op: operation.op, changed: from !== to, from: from + 1, to: to + 1 };
}

function mergeSources(operation) {
  let sources = [];
  if (Array.isArray(operation.sources) && operation.sources.length) sources = operation.sources;
  else if (operation.path) sources = [operation.path];
  if (!sources.length) throw new Error('merge_pdf needs sources:[path | { path, pages }] or path');
  return sources;
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
    merged.push({
      path: sourcePath,
      pages: indexes.map((index) => index + 1),
      pagesAdded: copied.length,
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
