import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import {
  BlendMode,
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
  degrees,
} from 'pdf-lib';
import { inspectPdfBuffer } from '../../attachments/pdf-extract.mjs';
import { extractPdfOutline, extractPdfTextLayout, findPdfText, ocrPdf } from './pdf-analysis.mjs';
import { SAVE_OPTIONS, color, embedImage, round2 } from './pdf-draw.mjs';
import { embedDocumentFont } from './pdf-fonts.mjs';
import { activeContentIssues } from './pdf-safety.mjs';
import {
  addFormField,
  describeFormField,
  fieldText,
  fieldWidgets,
  fillFormValues,
  lintPdfFormFields,
  rectanglesOverlap,
} from './pdf-forms.mjs';

// The adapter is the session-facing surface: open, inspect, edit, validate.
// Writing a new document lives in pdf-writer.mjs and the form vocabulary in
// pdf-forms.mjs; both stay reachable here so consumers keep one import.
export { createPdf } from './pdf-writer.mjs';
export { lintPdfFormFields } from './pdf-forms.mjs';

export const PDF_ENCRYPTED_HINT = "PDF is encrypted: write an unencrypted copy first with action:'secure' security:'decrypt' path password output:<copy.pdf>, then open that copy";
const NO_TEXT_MARKER = '(no extractable text on this page)';
const MARK_OPERATIONS = new Set(['highlight', 'add_link']);
// pdf.js analysis takes at most this many pages per call.
const MEASURE_CHUNK = 100;

function isEncryptionError(error) {
  return error?.constructor?.name === 'EncryptedPDFError' || /is encrypted/i.test(String(error?.message || ''));
}

// pdf-lib refuses encrypted input with a message that names its own option;
// the model needs the Mixdog route (secure → decrypt) instead. Reading page
// counts and sizes still works on an encrypted file, so inspection may opt in.
async function loadPdf(buffer, { allowEncrypted = false } = {}) {
  try {
    return await PDFDocument.load(buffer, { ignoreEncryption: false, updateMetadata: false });
  } catch (error) {
    if (!isEncryptionError(error)) throw error;
    if (!allowEncrypted) throw new Error(PDF_ENCRYPTED_HINT);
    return await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  }
}

function selectedPages(document, operation) {
  const count = document.getPageCount();
  const pages = Array.isArray(operation.pages) && operation.pages.length
    ? operation.pages
    : operation.page
      ? [operation.page]
      : Array.from({ length: count }, (_, index) => index + 1);
  return pages.map((page) => {
    const index = Number(page) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`PDF page out of range: ${page}`);
    return { page: document.getPage(index), index };
  });
}

function attachmentEntries(document) {
  try {
    const names = document.catalog.lookup(PDFName.of('Names'), PDFDict);
    const embedded = names?.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
    const entries = embedded?.lookup(PDFName.of('Names'), PDFArray);
    if (!entries) return [];
    const output = [];
    for (let index = 0; index + 1 < entries.size(); index += 2) {
      const nameObject = entries.lookup(index, PDFString, PDFHexString);
      const spec = entries.lookup(index + 1, PDFDict);
      const description = spec?.lookupMaybe?.(PDFName.of('Desc'), PDFString, PDFHexString);
      output.push({
        path: `/attachments[${output.length + 1}]`,
        index: output.length + 1,
        name: nameObject?.decodeText?.() || '',
        description: description?.decodeText?.() || '',
        spec,
      });
    }
    return output;
  } catch {
    return [];
  }
}

function pdfAttachments(document) {
  return attachmentEntries(document).map(({ spec, ...entry }) => entry);
}

function attachmentBytes(spec) {
  const files = spec?.lookup(PDFName.of('EF'), PDFDict);
  const stream = files?.lookup(PDFName.of('UF')) || files?.lookup(PDFName.of('F'));
  if (!stream) return null;
  if (stream instanceof PDFRawStream) return Buffer.from(decodePDFRawStream(stream).decode());
  if (typeof stream.getContents === 'function') return Buffer.from(stream.getContents());
  return null;
}

function pageGeometry(structure, index) {
  const page = structure.getPage(index - 1);
  const { width, height } = page.getSize();
  const box = page.getCropBox();
  return {
    width: round2(width),
    height: round2(height),
    rotation: page.getRotation().angle,
    // Only when the page box does not start at 0,0: bottom-left coordinates need it added.
    ...(box.x || box.y ? { origin: { x: round2(box.x), y: round2(box.y) } } : {}),
  };
}

function metadataOf(structure) {
  const read = (getter) => {
    try {
      return getter() || '';
    } catch {
      return '';
    }
  };
  return {
    title: read(() => structure.getTitle()),
    author: read(() => structure.getAuthor()),
    subject: read(() => structure.getSubject()),
    keywords: read(() => structure.getKeywords()),
  };
}

export async function snapshotPdf(path, options = {}) {
  const maxChars = Math.max(1_000, Number(options.maxChars) || 30_000);
  const buffer = await readFile(path);
  const structure = await loadPdf(buffer, { allowEncrypted: true });
  const encrypted = structure.isEncrypted === true;
  const pageCount = structure.getPageCount();
  const offset = options.paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = options.paged ? Math.max(1, Number(options.limit) || 20) : pageCount;
  const selected = Array.isArray(options.pages) && options.pages.length
    ? options.pages.map(Number)
    : Array.from({ length: Math.max(0, Math.min(limit, pageCount - offset)) }, (_, index) => offset + index + 1);
  for (const index of selected) {
    if (!Number.isInteger(index) || index < 1 || index > pageCount) throw new Error(`PDF page out of range: ${index}`);
  }
  const from = selected.length ? Math.min(...selected) : 1;
  const to = selected.length ? Math.max(...selected) : 1;
  let result = { pageCount, text: '', truncated: false };
  let passwordRequired = false;
  try {
    result = await inspectPdfBuffer(buffer, {
      extractText: true,
      maxPages: Math.max(500, pageCount),
      maxOutputBytes: maxChars,
      pageRange: { from, to },
      password: options.password || '',
    });
  } catch (error) {
    // A user password blocks the text layer (unless the caller supplied it);
    // an owner-only password does not.
    if (!encrypted || !/password/i.test(String(error?.message || error?.name || ''))) throw error;
    passwordRequired = true;
  }
  const texts = new Map();
  const regex = /--- Page (\d+) ---\n([\s\S]*?)(?=\n\n--- Page \d+ ---|$)/g;
  let match;
  while ((match = regex.exec(result.text || ''))) texts.set(Number(match[1]), match[2]);
  const pages = selected
    .filter((index) => passwordRequired || texts.has(index))
    .map((index) => ({ path: `/page[${index}]`, index, text: (texts.get(index) ?? '').replace(/ {2,}/g, ' '), ...pageGeometry(structure, index) }));
  // Strings and streams stay ciphered under ignoreEncryption, so the form and
  // attachment views of an encrypted file would be noise rather than data.
  const fields = encrypted ? [] : structure.getForm().getFields().map((field, index) => describeFormField(field, structure, index));
  const attachments = encrypted ? [] : pdfAttachments(structure);
  let outline = [];
  // The outline costs a second parse; a caller that only wants issues skips it.
  if (!encrypted && options.outline !== false) {
    try {
      outline = (await extractPdfOutline(path)).entries.map((entry, index) => ({ path: `/outline[${index + 1}]`, ...entry }));
    } catch {}
  }
  const likelyScannedPages = passwordRequired ? [] : pages.filter((page) => page.text.includes(NO_TEXT_MARKER)).map((page) => page.index);
  return {
    format: 'pdf',
    ...result,
    pageCount,
    pages,
    fields,
    fieldCount: fields.length,
    attachmentCount: attachments.length,
    attachments,
    outlineCount: outline.length,
    outline,
    metadata: encrypted ? { title: '', author: '', subject: '', keywords: '' } : metadataOf(structure),
    likelyScannedPages,
    ocrRequired: likelyScannedPages.length > 0,
    encrypted,
    ...(encrypted ? { passwordRequired, hint: PDF_ENCRYPTED_HINT } : {}),
    ...(options.paged ? {
      pagination: {
        unit: 'page',
        offset,
        limit,
        returned: pages.length,
        total: pageCount,
        nextOffset: !options.pages?.length && offset + pages.length < pageCount ? offset + pages.length : null,
      },
    } : {}),
  };
}

// Bookmarks are a linked list under /Outlines; new ones go after whatever the
// file already has, so a merged report keeps its sources' entries too.
function addOutlineEntries(document, entries) {
  if (!entries.length) return 0;
  const { context, catalog } = document;
  const existing = catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  const rootRef = existing ? catalog.get(PDFName.of('Outlines')) : context.nextRef();
  const refs = entries.map(() => context.nextRef());
  const previousLastRef = existing?.get(PDFName.of('Last'));
  entries.forEach((entry, index) => {
    const page = document.getPage(entry.pageIndex);
    const item = context.obj({
      Title: PDFHexString.fromText(entry.title),
      Parent: rootRef,
      Dest: [page.ref, PDFName.of('Fit')],
    });
    const previous = index > 0 ? refs[index - 1] : previousLastRef;
    if (previous) item.set(PDFName.of('Prev'), previous);
    if (index < entries.length - 1) item.set(PDFName.of('Next'), refs[index + 1]);
    context.assign(refs[index], item);
  });
  if (existing) {
    if (previousLastRef) context.lookup(previousLastRef, PDFDict)?.set(PDFName.of('Next'), refs[0]);
    else existing.set(PDFName.of('First'), refs[0]);
    existing.set(PDFName.of('Last'), refs.at(-1));
    const count = existing.lookupMaybe(PDFName.of('Count'), PDFNumber)?.asNumber() ?? 0;
    existing.set(PDFName.of('Count'), PDFNumber.of(Math.max(0, count) + entries.length));
  } else {
    context.assign(rootRef, context.obj({ Type: 'Outlines', First: refs[0], Last: refs.at(-1), Count: entries.length }));
    catalog.set(PDFName.of('Outlines'), rootRef);
  }
  return entries.length;
}

async function writeSibling(path, target, bytes) {
  const output = resolve(dirname(path), String(target));
  if (output.toLowerCase() === resolve(path).toLowerCase()) throw new Error('output must differ from the document being edited');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
  return output;
}

// Display coordinates (top-left, page as shown) back to PDF user space through
// the inverse of pdf.js's page transform; the four corners keep a rotated box honest.
function displayToUser(transform, box) {
  const [a, b, c, d, e, f] = transform;
  const det = (a * d) - (b * c);
  const invert = ([X, Y]) => [((d * (X - e)) - (c * (Y - f))) / det, ((-b * (X - e)) + (a * (Y - f))) / det];
  const corners = [
    [box.x, box.top],
    [box.x + box.width, box.top],
    [box.x, box.top + box.height],
    [box.x + box.width, box.top + box.height],
  ].map(invert);
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// highlight and add_link take a box in bottom-left points, or `find`, which
// measures every match on the selected pages of the document as it stands in
// this batch (earlier operations included) so the boxes land on the real text.
// Measuring means serializing, and pdf-lib caches every stream it serializes
// (later drawing on such a page would be lost), so the batch continues on a
// fresh load of those bytes: the returned document replaces the caller's.
// `measure` carries the bytes and the pages already measured; marks do not
// move text, so consecutive marks share one measurement.
async function targetBoxes(document, operation, measure = null) {
  const find = String(operation.find ?? '').trim();
  if (!find) {
    const box = ['x', 'y', 'width', 'height'].map((key) => Number(operation[key]));
    if (!operation.page || box.some((value) => !Number.isFinite(value)) || box[2] <= 0 || box[3] <= 0) {
      throw new Error(`${operation.op} needs find, or page with x, y, width, height in points`);
    }
    const [{ index }] = selectedPages(document, { page: operation.page });
    return { document, boxes: [{ index, x: box[0], y: box[1], width: box[2], height: box[3] }], measure };
  }
  const selected = selectedPages(document, operation);
  let current = document;
  let next = measure;
  if (!next) {
    const bytes = await document.save(SAVE_OPTIONS);
    current = await loadPdf(bytes);
    next = { bytes, pages: new Map() };
  }
  const missing = selected.map(({ index }) => index + 1).filter((page) => !next.pages.has(page));
  for (let at = 0; at < missing.length; at += MEASURE_CHUNK) {
    const layout = await extractPdfTextLayout(next.bytes, {
      pages: missing.slice(at, at + MEASURE_CHUNK),
      shapes: false,
      maxItems: 500_000,
    });
    for (const page of layout.pages) next.pages.set(page.page, page);
  }
  const layout = { pages: selected.map(({ index }) => next.pages.get(index + 1)).filter(Boolean) };
  const { matches } = findPdfText(layout, find, {
    limit: 500,
    wholeWord: operation.wholeWord === true,
    regex: operation.regex === true,
  });
  if (!matches.length) {
    const scope = selected.length === document.getPageCount()
      ? 'the document'
      : `page${selected.length > 1 ? 's' : ''} ${selected.map(({ index }) => index + 1).join(', ')}`;
    throw new Error(`${operation.op} found no text matching "${find}" in ${scope}; check the snapshot text or pass page, x, y, width, height`);
  }
  const all = matches.map((match) => {
    const index = match.page - 1;
    const page = layout.pages.find((entry) => entry.page === match.page);
    // The layout is measured on the page as displayed (rotation and crop box
    // applied); inverting the page's transform puts the box back into user space.
    const rect = Array.isArray(page?.transform) && page.transform.length === 6
      ? displayToUser(page.transform, match)
      : { x: match.x, y: page.height - match.top - match.height, width: match.width, height: match.height };
    return { index, ...rect, text: match.text };
  });
  const boxes = operation.first === true ? all.slice(0, 1) : all;
  return { document: current, boxes, measure: next };
}

// The first few boxes go back in bottom-left points so a caller can check a
// mark against the snapshot without rendering; a long match list is a count.
function reportBoxes(boxes) {
  return boxes.slice(0, 20).map((box) => ({
    page: box.index + 1,
    x: round2(box.x),
    y: round2(box.y),
    width: round2(box.width),
    height: round2(box.height),
    ...(box.text ? { text: box.text } : {}),
  }));
}

export async function applyPdfBatch(path, operations, context = {}) {
  const source = await readFile(path);
  let document = await loadPdf(source);
  const results = [];
  // Text positions measured for a mark stay valid across further marks; any
  // other operation may move text, so it drops the measurement.
  let measure = null;
  for (const operation of operations) {
    if (!MARK_OPERATIONS.has(operation.op)) measure = null;
    switch (operation.op) {
      case 'add_text':
      case 'watermark': {
        const watermark = operation.op === 'watermark';
        const template = String(operation.text ?? '');
        if (!template.trim()) throw new Error(`${operation.op} needs text`);
        const { font, fontPath, embedded } = await embedDocumentFont(document, { fontPath: operation.fontPath, text: template });
        const size = Number(operation.size ?? (watermark ? 48 : 12));
        const opacity = Number(operation.opacity ?? (watermark ? 0.25 : 1));
        const angle = Number(operation.rotation ?? (watermark ? 45 : 0));
        const pageCount = document.getPageCount();
        const pages = [];
        const align = String(operation.align || (watermark ? 'center' : 'left')).toLowerCase();
        if (!['left', 'center', 'right'].includes(align)) throw new Error(`${operation.op} align must be left, center, or right`);
        for (const { page, index } of selectedPages(document, operation)) {
          // {page} and {pages} number an existing file the way create's pageNumbers does.
          const text = template.replace(/\{page\}/g, String(index + 1)).replace(/\{pages\}/g, String(pageCount));
          const textWidth = font.widthOfTextAtSize(text, size);
          // A watermark centres its rotated run on the page unless placed
          // explicitly; add_text with align centres or right-aligns the run
          // between the page margins when x is omitted.
          const spanX = textWidth * Math.cos((angle * Math.PI) / 180);
          const spanY = textWidth * Math.sin((angle * Math.PI) / 180);
          const defaultX = align === 'center'
            ? (page.getWidth() - spanX) / 2
            : align === 'right'
              ? page.getWidth() - 36 - spanX
              : 36;
          const x = Number(operation.x ?? defaultX);
          const y = Number(operation.y ?? (watermark ? (page.getHeight() - spanY) / 2 : 36));
          page.drawText(text, {
            x,
            y,
            size,
            font,
            color: color(operation.color),
            opacity,
            rotate: degrees(angle),
          });
          pages.push(index + 1);
        }
        results.push({ op: operation.op, changed: pages.length > 0, pages, fontEmbedded: embedded, ...(fontPath ? { fontPath } : {}) });
        break;
      }
      case 'highlight': {
        const target = await targetBoxes(document, operation, measure);
        ({ document, measure } = target);
        const { boxes } = target;
        const fill = color(operation.color || 'ffeb3b');
        const opacity = Number(operation.opacity ?? 0.45);
        const pages = new Set();
        for (const box of boxes) {
          // Multiply keeps the glyphs under the mark legible, the way a marker pen does.
          document.getPage(box.index).drawRectangle({
            x: box.x - 1,
            y: box.y - 1,
            width: box.width + 2,
            height: box.height + 2,
            color: fill,
            opacity,
            blendMode: BlendMode.Multiply,
            borderWidth: 0,
          });
          pages.add(box.index + 1);
        }
        results.push({ op: operation.op, changed: true, marks: boxes.length, pages: [...pages], ...(operation.find ? { find: String(operation.find) } : {}), boxes: reportBoxes(boxes) });
        break;
      }
      case 'add_link': {
        const autoUrls = operation.urls === true;
        const url = String(operation.url ?? '').trim();
        const toPage = operation.toPage === undefined || operation.toPage === null ? null : Number(operation.toPage);
        if (!url && toPage === null && !autoUrls) throw new Error('add_link needs url, toPage, or urls:true');
        if (url && !/^(https?:\/\/|mailto:)/i.test(url)) throw new Error(`add_link url must start with http://, https://, or mailto: (${url})`);
        if (toPage !== null) selectedPages(document, { page: toPage });
        // urls:true finds every http(s) address in the text and points each at itself.
        const request = autoUrls ? { ...operation, find: 'https?://[^\\s<>()"\']+', regex: true, wholeWord: false } : operation;
        let target;
        try {
          target = await targetBoxes(document, request, measure);
        } catch (error) {
          if (!autoUrls || !/found no text matching/.test(String(error?.message || ''))) throw error;
          throw new Error(`add_link urls:true found no http(s) address in the selected pages; pass find or a box instead`);
        }
        ({ document, measure } = target);
        const { boxes } = target;
        // The destination page is looked up after measuring, on the document the links go into.
        const destination = toPage === null ? null : [document.getPage(toPage - 1).ref, 'XYZ', null, null, null];
        const linkUrl = (box) => (autoUrls ? box.text.replace(/[.,;:!?]+$/, '') : url);
        const pages = new Set();
        for (const box of boxes) {
          const page = document.getPage(box.index);
          const href = linkUrl(box);
          const annotation = document.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [box.x, box.y, box.x + box.width, box.y + box.height],
            Border: [0, 0, 0],
            ...(href ? { A: { Type: 'Action', S: 'URI', URI: PDFString.of(href) } } : { Dest: destination }),
          });
          page.node.addAnnot(document.context.register(annotation));
          pages.add(box.index + 1);
        }
        results.push({
          op: operation.op,
          changed: true,
          links: boxes.length,
          pages: [...pages],
          ...(autoUrls ? { urls: boxes.map(linkUrl) } : url ? { url } : { toPage }),
          boxes: reportBoxes(boxes),
        });
        break;
      }
      case 'stamp_image': {
        const imagePath = resolve(dirname(path), String(operation.path || ''));
        const image = await embedImage(document, imagePath);
        const pages = [];
        for (const { page, index } of selectedPages(document, operation)) {
          // Pixels become points one-to-one, so a photo would run off the page; keep it inside the margins unless sized.
          const width = Number(operation.width || Math.min(image.width, page.getWidth() - 72));
          const height = Number(operation.height || (image.height * width / image.width));
          page.drawImage(image, {
            x: Number(operation.x || 0),
            y: Number(operation.y || 0),
            width,
            height,
            opacity: Number(operation.opacity ?? 1),
          });
          pages.push(index + 1);
        }
        results.push({ op: operation.op, changed: pages.length > 0, pages, image: imagePath });
        break;
      }
      case 'ocr_pages': {
        await writeFile(path, await document.save(SAVE_OPTIONS));
        const result = await ocrPdf(path, operation, context);
        document = await loadPdf(await readFile(path));
        results.push(result);
        break;
      }
      case 'rotate_pages': {
        const delta = Number(operation.rotation ?? 90);
        if (!Number.isInteger(delta) || delta % 90 !== 0) throw new Error(`PDF rotation must be a multiple of 90 degrees: ${operation.rotation}`);
        const pages = [];
        for (const { page, index } of selectedPages(document, operation)) {
          const current = page.getRotation().angle;
          const next = (((operation.absolute ? delta : current + delta) % 360) + 360) % 360;
          page.setRotation(degrees(next));
          pages.push({ page: index + 1, from: current, rotation: next });
        }
        results.push({ op: operation.op, changed: pages.some((entry) => entry.from !== entry.rotation), pages });
        break;
      }
      case 'delete_pages': {
        const indexes = selectedPages(document, operation).map(({ index }) => index).sort((a, b) => b - a);
        if (indexes.length >= document.getPageCount()) throw new Error('delete_pages cannot remove every page; use extract_pages or delete fewer pages');
        for (const index of indexes) document.removePage(index);
        results.push({ op: operation.op, changed: indexes.length > 0, count: indexes.length, pageCount: document.getPageCount() });
        break;
      }
      case 'extract_pages': {
        const next = await PDFDocument.create();
        const indexes = selectedPages(document, operation).map(({ index }) => index);
        const copied = await next.copyPages(document, indexes);
        copied.forEach((page) => next.addPage(page));
        const pages = indexes.map((index) => index + 1);
        if (operation.output) {
          // With an output the session document stays whole; the subset is a new file.
          const output = await writeSibling(path, operation.output, await next.save(SAVE_OPTIONS));
          results.push({ op: operation.op, changed: true, documentChanged: false, output, count: indexes.length, pages });
        } else {
          document = next;
          results.push({ op: operation.op, changed: true, count: indexes.length, pages });
        }
        break;
      }
      case 'split_pages': {
        const every = Math.max(1, Math.floor(Number(operation.every) || 1));
        const indexes = selectedPages(document, operation).map(({ index }) => index);
        const stem = basename(path, extname(path));
        const directory = resolve(dirname(path), String(operation.output || '.'));
        const files = [];
        for (let start = 0; start < indexes.length; start += every) {
          const group = indexes.slice(start, start + every);
          const part = await PDFDocument.create();
          const copied = await part.copyPages(document, group);
          copied.forEach((page) => part.addPage(page));
          const first = String(group[0] + 1).padStart(3, '0');
          const label = group.length === 1 ? first : `${first}-${String(group.at(-1) + 1).padStart(3, '0')}`;
          const output = await writeSibling(path, resolve(directory, `${stem}-${label}.pdf`), await part.save(SAVE_OPTIONS));
          files.push({ output, pages: group.map((index) => index + 1) });
        }
        results.push({ op: operation.op, changed: files.length > 0, documentChanged: false, count: files.length, files });
        break;
      }
      case 'fill_form': {
        const form = document.getForm();
        const filled = fillFormValues(form, operation.values);
        const coverage = Object.values(operation.values || {}).flat().map((value) => String(value ?? '')).join(' ');
        const { font, fontPath, embedded } = await embedDocumentFont(document, { fontPath: operation.fontPath, text: coverage });
        form.updateFieldAppearances(font);
        if (operation.flatten) form.flatten();
        results.push({
          op: operation.op,
          changed: filled.length > 0,
          filled,
          flattened: Boolean(operation.flatten),
          fontEmbedded: embedded,
          ...(fontPath ? { fontPath } : {}),
        });
        break;
      }
      case 'add_form_field': {
        const check = lintPdfFormFields([operation], document.getPages().map((entry) => [entry.getWidth(), entry.getHeight()]));
        if (!check.ok) throw new Error(check.issues.map((issue) => issue.message).join(' '));
        const { font } = await embedDocumentFont(document, { fontPath: operation.fontPath, text: fieldText(operation) });
        await addFormField(document, operation, font);
        document.getForm().updateFieldAppearances(font);
        results.push({ op: operation.op, changed: true, name: operation.name, type: String(operation.type || 'text').toLowerCase() });
        break;
      }
      case 'flatten_form': {
        const form = document.getForm();
        const count = form.getFields().length;
        if (operation.fontPath) {
          const { font } = await embedDocumentFont(document, { fontPath: operation.fontPath });
          form.updateFieldAppearances(font);
        }
        form.flatten();
        results.push({ op: operation.op, changed: count > 0, fields: count });
        break;
      }
      case 'add_attachment': {
        const attachmentPath = resolve(dirname(path), String(operation.path || ''));
        await document.attach(await readFile(attachmentPath), String(operation.name || basename(attachmentPath)), {
          mimeType: String(operation.mimeType || 'application/octet-stream'),
          description: String(operation.description || ''),
        });
        results.push({ op: operation.op, changed: true, name: String(operation.name || basename(attachmentPath)) });
        break;
      }
      case 'extract_attachment': {
        const entries = attachmentEntries(document);
        const wanted = entries.find((entry) => (
          (operation.name != null && entry.name === String(operation.name))
          || (operation.index != null && entry.index === Number(operation.index))
        ));
        if (!wanted) {
          throw new Error(`PDF has no attachment ${operation.name ?? operation.index ?? ''}; attachments: ${entries.map((entry) => entry.name).join(', ') || '(none)'}`);
        }
        const bytes = attachmentBytes(wanted.spec);
        if (!bytes) throw new Error(`Attachment ${wanted.name} has no embedded file stream`);
        const output = await writeSibling(path, operation.output || wanted.name || `attachment-${wanted.index}`, bytes);
        results.push({ op: operation.op, changed: true, documentChanged: false, name: wanted.name, output, bytes: bytes.length });
        break;
      }
      case 'compress': {
        results.push({ op: operation.op, changed: true, method: 'object-streams', bytesBefore: source.length });
        break;
      }
      case 'preview_fields': {
        // A copy with every field's box outlined and named — and any box the
        // caller proposes — so a render shows placement before a fill. The
        // session document continues on a reload of the same bytes (see targetBoxes).
        const output = String(operation.output || '').trim();
        if (!output) throw new Error('preview_fields needs output (a file name beside the document)');
        const bytes = await document.save(SAVE_OPTIONS);
        document = await loadPdf(bytes);
        const copy = await loadPdf(bytes);
        const fields = copy.getForm().getFields();
        const proposed = Array.isArray(operation.boxes) ? operation.boxes : [];
        const labels = [...fields.map((field) => field.getName()), ...proposed.map((box) => String(box.label ?? ''))].join(' ');
        const { font } = await embedDocumentFont(copy, { text: `${labels} box 0123456789` });
        const ink = color('d32f2f');
        const outline = (page, box, label) => {
          page.drawRectangle({ x: box.x, y: box.y, width: box.width, height: box.height, borderColor: ink, borderWidth: 1 });
          page.drawText(label, { x: box.x, y: box.y + box.height + 2, size: 7, font, color: ink });
        };
        let widgets = 0;
        fields.forEach((field, index) => {
          for (const widget of fieldWidgets(field, copy)) {
            if (!widget.page) continue;
            outline(copy.getPage(widget.page - 1), widget, `${index + 1} ${field.getName()}`);
            widgets += 1;
          }
        });
        proposed.forEach((box, index) => {
          const rect = ['x', 'y', 'width', 'height'].map((key) => Number(box?.[key]));
          if (!box?.page || rect.some((value) => !Number.isFinite(value))) throw new Error(`preview_fields boxes[${index}] needs page, x, y, width, height`);
          const [{ page }] = selectedPages(copy, { page: box.page });
          outline(page, { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }, String(box.label ?? `box ${index + 1}`));
        });
        const written = await writeSibling(path, output, await copy.save(SAVE_OPTIONS));
        results.push({ op: operation.op, changed: true, documentChanged: false, output: written, fields: fields.length, widgets, boxes: proposed.length });
        break;
      }
      case 'merge_pdf': {
        const sources = Array.isArray(operation.sources) && operation.sources.length
          ? operation.sources
          : operation.path ? [operation.path] : [];
        if (!sources.length) throw new Error('merge_pdf needs sources:[path | { path, pages }] or path');
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
        const bookmarks = operation.bookmarks === true
          ? addOutlineEntries(document, merged
              .filter((entry) => entry.pagesAdded > 0)
              .map((entry) => ({ title: entry.title || basename(entry.path, extname(entry.path)), pageIndex: entry.at - 1 })))
          : 0;
        results.push({
          op: operation.op,
          changed: pagesAdded > 0,
          pagesAdded,
          sources: merged,
          pageCount: document.getPageCount(),
          ...(operation.bookmarks === true ? { bookmarks } : {}),
        });
        break;
      }
      case 'add_bookmark': {
        const title = String(operation.title ?? '').trim();
        if (!title) throw new Error('add_bookmark needs title');
        if (!operation.page) throw new Error('add_bookmark needs page');
        const [{ index }] = selectedPages(document, { page: operation.page });
        addOutlineEntries(document, [{ title, pageIndex: index }]);
        results.push({ op: operation.op, changed: true, title, page: index + 1 });
        break;
      }
      case 'set_metadata': {
        const props = operation.properties || {};
        const applied = [];
        if (props.title !== undefined) { document.setTitle(String(props.title)); applied.push('title'); }
        if (props.author !== undefined) { document.setAuthor(String(props.author)); applied.push('author'); }
        if (props.subject !== undefined) { document.setSubject(String(props.subject)); applied.push('subject'); }
        if (props.creator !== undefined) { document.setCreator(String(props.creator)); applied.push('creator'); }
        if (props.keywords !== undefined) {
          document.setKeywords(Array.isArray(props.keywords) ? props.keywords.map(String) : [String(props.keywords)]);
          applied.push('keywords');
        }
        results.push({ op: operation.op, changed: applied.length > 0, applied });
        break;
      }
      case 'move_page': {
        const from = Number(operation.page) - 1;
        const to = Number(operation.index) - 1;
        const count = document.getPageCount();
        if (!Number.isInteger(from) || from < 0 || from >= count) throw new Error(`PDF page out of range: ${operation.page}`);
        if (!Number.isInteger(to) || to < 0 || to >= count) throw new Error(`PDF destination page out of range: ${operation.index}`);
        const order = document.getPageIndices();
        const [moved] = order.splice(from, 1);
        order.splice(to, 0, moved);
        const next = await PDFDocument.create();
        const copied = await next.copyPages(document, order);
        copied.forEach((page) => next.addPage(page));
        document = next;
        results.push({ op: operation.op, changed: from !== to, from: from + 1, to: to + 1 });
        break;
      }
      default:
        throw new Error(`PDF backend does not support operation: ${operation.op}`);
    }
  }
  const bytes = await document.save(SAVE_OPTIONS);
  await writeFile(path, bytes);
  for (const entry of results) {
    if (entry.op !== 'compress') continue;
    entry.bytesAfter = bytes.length;
    entry.changed = bytes.length !== source.length;
    entry.note = 'Re-serialized with object streams; images are not resampled, so savings are usually small.';
  }
  return results;
}

export async function validatePdf(path) {
  const document = await loadPdf(await readFile(path), { allowEncrypted: true });
  const encrypted = document.isEncrypted === true;
  return {
    ok: true,
    format: 'pdf',
    pages: document.getPageCount(),
    validation: 'pdf-parse',
    encrypted,
    ...(encrypted ? { warning: PDF_ENCRYPTED_HINT } : {}),
  };
}

export async function issuesPdf(path, options = {}) {
  const snapshot = await snapshotPdf(path, { ...options, maxChars: options.maxChars || 30_000, outline: false });
  const issues = [];
  if (snapshot.encrypted) {
    issues.push({
      severity: snapshot.passwordRequired ? 'error' : 'warning',
      code: 'encrypted',
      path: '/metadata',
      message: PDF_ENCRYPTED_HINT,
    });
  }
  if (!snapshot.encrypted) issues.push(...activeContentIssues(await loadPdf(await readFile(path))));
  for (const page of snapshot.likelyScannedPages) {
    issues.push({
      severity: 'warning',
      code: 'ocr_required',
      path: `/page[${page}]`,
      message: 'Page has no text layer. Run ocr_pages or render it and read the image instead of treating it as empty.',
    });
  }
  for (const field of snapshot.fields) {
    if (!field.name) {
      issues.push({ severity: 'warning', code: 'unnamed_form_field', path: field.path, message: 'Form field has no name, so fill_form cannot address it.' });
    }
    const mark = ['checkbox', 'radio'].includes(field.type);
    const [minWidth, minHeight] = mark ? [8, 8] : [24, 12];
    const small = field.widgets.find((widget) => widget.width < minWidth || widget.height < minHeight);
    if (small) {
      issues.push({
        severity: 'warning',
        code: 'field_too_small',
        path: field.path,
        message: `Form field ${field.name || field.index} has a ${round2(small.width)} x ${round2(small.height)} pt box on page ${small.page}; a ${field.type} field needs at least ${minWidth} x ${minHeight}.`,
      });
    }
  }
  const widgets = snapshot.fields.flatMap((field) => field.widgets.map((widget) => ({ ...widget, name: field.name, path: field.path })));
  for (let left = 0; left < widgets.length; left += 1) {
    for (let right = left + 1; right < widgets.length; right += 1) {
      if (widgets[left].page === widgets[right].page && rectanglesOverlap(widgets[left], widgets[right])) {
        issues.push({ severity: 'warning', code: 'overlapping_form_fields', path: widgets[left].path, message: `Form fields ${widgets[left].name} and ${widgets[right].name} overlap.` });
      }
    }
  }
  return { ok: true, format: 'pdf', issueCount: issues.length, issues };
}
