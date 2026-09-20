/**
 * src/runtime/office/pdf/pdf-edit-document.mjs - the pdf-lib document under
 * edit: guarded load, page selection, attachments, outline entries, sibling
 * output files, and page rotation as a viewer applies it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

export const PDF_ENCRYPTED_HINT =
  "PDF is encrypted: write an unencrypted copy first with action:'secure' security:'decrypt' path password output:<copy.pdf>, then open that copy";

function isEncryptionError(error) {
  return error?.constructor?.name === 'EncryptedPDFError' || /is encrypted/i.test(String(error?.message || ''));
}

// pdf-lib refuses encrypted input with a message that names its own option;
// the model needs the Mixdog route (secure → decrypt) instead. Reading page
// counts and sizes still works on an encrypted file, so inspection may opt in.
export async function loadPdf(buffer, { allowEncrypted = false } = {}) {
  try {
    return await PDFDocument.load(buffer, { ignoreEncryption: false, updateMetadata: false });
  } catch (error) {
    if (!isEncryptionError(error)) throw error;
    if (!allowEncrypted) throw new Error(PDF_ENCRYPTED_HINT);
    return await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  }
}

export function selectedPages(document, operation) {
  const count = document.getPageCount();
  let pages;
  if (Array.isArray(operation.pages) && operation.pages.length) pages = operation.pages;
  else if (operation.page) pages = [operation.page];
  else pages = Array.from({ length: count }, (_, index) => index + 1);
  return pages.map((page) => {
    const index = Number(page) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`PDF page out of range: ${page}`);
    return { page: document.getPage(index), index };
  });
}

export function attachmentEntries(document) {
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

export function pdfAttachments(document) {
  return attachmentEntries(document).map(({ spec, ...entry }) => entry);
}

export function attachmentBytes(spec) {
  const files = spec?.lookup(PDFName.of('EF'), PDFDict);
  const stream = files?.lookup(PDFName.of('UF')) || files?.lookup(PDFName.of('F'));
  if (!stream) return null;
  if (stream instanceof PDFRawStream) return Buffer.from(decodePDFRawStream(stream).decode());
  if (typeof stream.getContents === 'function') return Buffer.from(stream.getContents());
  return null;
}

// Bookmarks are a linked list under /Outlines; new ones go after whatever the
// file already has, so a merged report keeps its sources' entries too.
export function addOutlineEntries(document, entries) {
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
    context.assign(
      rootRef,
      context.obj({ Type: 'Outlines', First: refs[0], Last: refs.at(-1), Count: entries.length })
    );
    catalog.set(PDFName.of('Outlines'), rootRef);
  }
  return entries.length;
}

export async function writeSibling(path, target, bytes) {
  const output = resolve(dirname(path), String(target));
  if (output.toLowerCase() === resolve(path).toLowerCase())
    throw new Error('output must differ from the document being edited');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
  return output;
}

// A page's own /Rotate, normalized: the quarter turns a viewer applies before
// anyone sees the page.
export function pageSpin(page) {
  const angle = Math.round(Number(page.getRotation?.()?.angle) || 0);
  return ((angle % 360) + 360) % 360;
}
