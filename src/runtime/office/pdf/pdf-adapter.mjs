import { readFile, writeFile } from 'node:fs/promises';
import { inspectPdfBuffer } from '../../attachments/pdf-extract.mjs';
import { extractPdfOutline } from './pdf-analysis.mjs';
import { SAVE_OPTIONS, round2 } from './pdf-draw.mjs';
import { activeContentIssues } from './pdf-safety.mjs';
import { describeFormField, rectanglesOverlap } from './pdf-forms.mjs';
import { PDF_ENCRYPTED_HINT, loadPdf, pdfAttachments } from './pdf-edit-document.mjs';
import { MARK_OPERATIONS } from './pdf-marks.mjs';
import { CONTENT_OPERATIONS } from './pdf-batch-content.mjs';
import { STRUCTURE_OPERATIONS } from './pdf-batch-structure.mjs';

// The adapter is the session-facing surface: open, inspect, edit, validate.
// Writing a new document lives in pdf-writer.mjs and the form vocabulary in
// pdf-forms.mjs; both stay reachable here so consumers keep one import.
export { createPdf } from './pdf-writer.mjs';
export { lintPdfFormFields } from './pdf-forms.mjs';

const NO_TEXT_MARKER = '(no extractable text on this page)';
// How much page text one audit call reads: the bound on its work, not on the
// document. Past it the answer says how many pages it covered.
const PDF_AUDIT_MAX_CHARS = 4_000_000;
const BATCH_OPERATIONS = { ...CONTENT_OPERATIONS, ...STRUCTURE_OPERATIONS };

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
  const selected =
    Array.isArray(options.pages) && options.pages.length
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
  const text = result.text || '';
  for (let match = regex.exec(text); match; match = regex.exec(text)) texts.set(Number(match[1]), match[2]);
  const pages = selected
    .filter((index) => passwordRequired || texts.has(index))
    .map((index) => ({
      path: `/page[${index}]`,
      index,
      text: (texts.get(index) ?? '').replace(/ {2,}/g, ' '),
      ...pageGeometry(structure, index),
    }));
  // Strings and streams stay ciphered under ignoreEncryption, so the form and
  // attachment views of an encrypted file would be noise rather than data.
  const fields = encrypted
    ? []
    : structure
        .getForm()
        .getFields()
        .map((field, index) => describeFormField(field, structure, index));
  const attachments = encrypted ? [] : pdfAttachments(structure);
  let outline = [];
  // The outline costs a second parse; a caller that only wants issues skips it.
  if (!encrypted && options.outline !== false) {
    try {
      outline = (await extractPdfOutline(path)).entries.map((entry, index) => ({
        path: `/outline[${index + 1}]`,
        ...entry,
      }));
    } catch {}
  }
  const likelyScannedPages = passwordRequired
    ? []
    : pages.filter((page) => page.text.includes(NO_TEXT_MARKER)).map((page) => page.index);
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
    ...(options.paged ? { pagination: pagePagination(options, offset, limit, pages.length, pageCount) } : {}),
  };
}

function pagePagination(options, offset, limit, returned, total) {
  const nextOffset = !options.pages?.length && offset + returned < total ? offset + returned : null;
  return { unit: 'page', offset, limit, returned, total, nextOffset };
}

export async function applyPdfBatch(path, operations, context = {}) {
  const source = await readFile(path);
  // Batch state the handlers share: a handler that must continue on a fresh
  // load (marks, previews, page reorders, OCR) replaces state.document.
  const state = { path, source, context, document: await loadPdf(source), measure: null };
  const results = [];
  for (const operation of operations) {
    if (!Object.hasOwn(BATCH_OPERATIONS, operation.op)) {
      throw new Error(`PDF backend does not support operation: ${operation.op}`);
    }
    // Text positions measured for a mark stay valid across further marks; any
    // other operation may move text, so it drops the measurement.
    if (!MARK_OPERATIONS.has(operation.op)) state.measure = null;
    results.push(await BATCH_OPERATIONS[operation.op](state, operation));
  }
  let bytes = await state.document.save(SAVE_OPTIONS);
  // Object streams can cost more than they save on a file that is already
  // compact. When compression was the only thing asked for and the rewrite came
  // back larger, the file it started with is the better answer: keeping it and
  // reporting no change beats reporting growth as a successful compression.
  const compressionOnly = operations.length > 0 && operations.every((operation) => operation.op === 'compress');
  const grew = bytes.length > source.length;
  if (compressionOnly && grew) bytes = source;
  await writeFile(path, bytes);
  for (const entry of results) {
    if (entry.op !== 'compress') continue;
    entry.bytesAfter = bytes.length;
    entry.changed = bytes.length !== source.length;
    if (compressionOnly && grew) {
      entry.note =
        'Object streams cost more than they saved here, so the file was left as it was; images are not resampled. Pass allowNoChange to accept that outcome.';
    } else if (grew) {
      entry.grew = true;
      entry.note = "The batch's other edits grew the file; object streams did not shrink it. Images are not resampled.";
    } else {
      entry.note = 'Re-serialized with object streams; images are not resampled, so savings are usually small.';
    }
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
  // The audit reads the whole document, not the readable excerpt a snapshot
  // shows: bounded to 30K the text stopped a few pages in, and a scanned page
  // past that boundary went unreported under "ok, nothing found".
  const snapshot = await snapshotPdf(path, {
    ...options,
    maxChars: options.maxChars || PDF_AUDIT_MAX_CHARS,
    outline: false,
  });
  const issues = [];
  if (!snapshot.encrypted && snapshot.pages.length < snapshot.pageCount) {
    issues.push({
      // A fact about this call's reach, not a defect in the document.
      severity: 'info',
      code: 'audit_scope_limited',
      path: '/',
      message: `Only ${snapshot.pages.length} of ${snapshot.pageCount} pages were read for this audit; audit the rest with issues pages:[…].`,
    });
  }
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
      issues.push({
        severity: 'warning',
        code: 'unnamed_form_field',
        path: field.path,
        message: 'Form field has no name, so fill_form cannot address it.',
      });
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
  const widgets = snapshot.fields.flatMap((field) =>
    field.widgets.map((widget) => ({ ...widget, name: field.name, path: field.path }))
  );
  for (let left = 0; left < widgets.length; left += 1) {
    for (let right = left + 1; right < widgets.length; right += 1) {
      if (widgets[left].page === widgets[right].page && rectanglesOverlap(widgets[left], widgets[right])) {
        issues.push({
          severity: 'warning',
          code: 'overlapping_form_fields',
          path: widgets[left].path,
          message: `Form fields ${widgets[left].name} and ${widgets[right].name} overlap.`,
        });
      }
    }
  }
  return { ok: true, format: 'pdf', issueCount: issues.length, issues };
}
