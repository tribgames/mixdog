// Legacy Office (.doc / .xls / .ppt, OLE compound) attachments. Text
// extraction reads OOXML packages only, so a legacy file is saved as its
// package by LibreOffice (convertLegacyOffice, the conversion `office open`
// uses) in a private scratch folder, never beside the user's file.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { redactDirectories } from '../shared/redact-directories.mjs';
import { removeDirectoryWithRetry } from '../shared/remove-directory.mjs';

// The first eight bytes of every legacy Office (OLE compound) file.
const OLE_COMPOUND_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const PACKAGE_BY_LEGACY_EXTENSION = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' };
const PACKAGE_BY_LEGACY_MIME = {
  'application/msword': 'docx',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.ms-powerpoint': 'pptx',
};
const PACKAGE_BY_OOXML_EXTENSION = { docx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', pptx: 'pptx' };

export const OOXML_MIME_BY_PACKAGE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const PACKAGE_BY_OOXML_MIME = {
  ...Object.fromEntries(Object.entries(OOXML_MIME_BY_PACKAGE).map(([kind, mime]) => [mime, kind])),
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
};

export function isLegacyOfficeBuffer(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(OLE_COMPOUND_MAGIC);
}

/** The package extension (`docx`/`xlsx`/`pptx`) an attachment labelled legacy Office
 *  (by MIME type or file extension) converts to, else ''. */
export function legacyOfficeLabelPackage(mimeType, filename) {
  const mime = String(mimeType || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  const extension = extname(String(filename || ''))
    .slice(1)
    .toLowerCase();
  return PACKAGE_BY_LEGACY_MIME[mime] || PACKAGE_BY_LEGACY_EXTENSION[extension] || '';
}

/** The package an OLE file labelled as an OOXML Office file (renamed, or sent
 *  with the OOXML MIME type and no extension) converts to, else ''. */
export function ooxmlLabelPackage(mimeType, filename) {
  const mime = String(mimeType || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  const extension = extname(String(filename || ''))
    .slice(1)
    .toLowerCase();
  return PACKAGE_BY_OOXML_MIME[mime] || PACKAGE_BY_OOXML_EXTENSION[extension] || '';
}

async function defaultConvert(path, output, options) {
  const { convertLegacyOffice } = await import('../office/portable/portable-soffice.mjs');
  return convertLegacyOffice(path, output, options);
}

/**
 * Saves the legacy Office `buffer` as the OOXML package `kind` and returns the
 * package bytes and its file name. The scratch folder is always removed, once
 * the converter has returned (it returns only after its process has closed;
 * a removal that still meets a held file is retried, and a final failure is
 * logged). A failure (LibreOffice missing, damaged or protected file, bytes
 * that are not a legacy Office file) throws a message with the scratch path
 * taken out; a cancellation rethrows the abort itself.
 */
export async function convertLegacyOfficeBuffer(
  buffer,
  filename,
  kind,
  { signal = null, convert = defaultConvert, remove = undefined, log = undefined, retryMs = undefined } = {}
) {
  signal?.throwIfAborted();
  if (!isLegacyOfficeBuffer(buffer)) {
    throw new Error(
      `${filename || 'This attachment'} is labelled as a legacy Office file but its content is not one, so it cannot be converted. Open it in Microsoft Office and save it as .${kind}, then attach that copy.`
    );
  }
  const stem = basename(String(filename || 'attachment'), extname(String(filename || ''))) || 'attachment';
  const safeStem = stem.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'attachment';
  const legacyExtension = Object.keys(PACKAGE_BY_LEGACY_EXTENSION).find(
    (ext) => PACKAGE_BY_LEGACY_EXTENSION[ext] === kind
  );
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-attachment-'));
  let converted;
  try {
    const source = join(dir, `${safeStem}.${legacyExtension}`);
    const output = join(dir, `${safeStem}.${kind}`);
    await writeFile(source, buffer);
    await convert(source, output, { signal });
    converted = { buffer: await readFile(output), filename: `${stem}.${kind}` };
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(redactDirectories(error instanceof Error ? error.message : String(error), [dir]));
  } finally {
    await removeDirectoryWithRetry(dir, { remove, log, retryMs });
  }
  // A cancel that arrived while the folder was being removed still cancels.
  signal?.throwIfAborted();
  return converted;
}
