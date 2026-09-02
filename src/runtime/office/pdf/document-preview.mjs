// Read-only viewing for documents no browser can open by itself.
//
// One LibreOffice pass converts .docx/.xlsx/.pptx to PDF. The desktop then
// shows that PDF through the viewer the editor already has, and a phone — which
// cannot open a desktop file URL, and on iOS cannot inline a PDF at all —
// receives rasterized pages instead, over the same lane as its other traffic.
//
// Conversion is the expensive half (an external process, seconds), so its
// output is cached by SOURCE IDENTITY — path, mtime and size — and reused
// until the document itself changes. Each document owns a cache DIRECTORY
// because page rasters land beside their PDF: eviction is then one directory
// removal instead of a filename convention that has to stay in sync with
// whatever the renderer happens to write.
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { renderPdfPages } from './pdf-render.mjs';
import { renderPortableOoxml } from '../portable/portable-soffice.mjs';

// What LibreOffice converts faithfully enough to READ. PDF is absent on
// purpose: it is already viewable and never needs the conversion pass.
const PREVIEW_FORMATS = new Set([
  'docx', 'doc', 'docm', 'dotx', 'rtf', 'odt',
  'xlsx', 'xls', 'xlsm', 'ods',
  'pptx', 'ppt', 'pptm', 'odp',
]);

const CACHE_DIR_NAME = 'document-previews';
// Bounded on purpose: a converted PDF is worth keeping for the session that
// opens it again, never worth growing without limit inside the app's data
// directory.
const MAX_CACHED_DOCUMENTS = 24;
const PREVIEW_PDF_NAME = 'preview.pdf';

/** The convertible format for this filename, or '' when there is none. */
export function documentPreviewFormat(path) {
  const name = String(path || '').split(/[\\/]/).at(-1) || '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  const extension = name.slice(dot + 1).toLocaleLowerCase();
  return PREVIEW_FORMATS.has(extension) ? extension : '';
}

function cacheKey(path, info) {
  return createHash('sha256')
    .update(`${path}\0${info.mtimeMs}\0${info.size}`)
    .digest('hex')
    .slice(0, 32);
}

async function pruneCache(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length <= MAX_CACHED_DOCUMENTS) return;
  const dated = await Promise.all(directories.map(async (entry) => {
    const target = join(root, entry.name);
    const info = await stat(target).catch(() => null);
    return { path: target, usedAt: info?.mtimeMs ?? 0 };
  }));
  dated.sort((left, right) => right.usedAt - left.usedAt);
  await Promise.all(dated.slice(MAX_CACHED_DOCUMENTS).map((entry) =>
    rm(entry.path, { recursive: true, force: true }).catch(() => {})));
}

// Two panes can open the same document in the same breath. Without this the
// second one starts a second LibreOffice run writing the same output file.
const conversions = new Map();

/**
 * The cached PDF rendition of one document, converting it when needed.
 * @returns {Promise<{ path: string; format: string; mtimeMs: number; size: number; cached: boolean }>}
 */
export async function documentPreviewPdf(path, { cacheRoot, signal = null } = {}) {
  const format = documentPreviewFormat(path);
  if (!format) throw new Error('This file type has no built-in document preview.');
  if (!cacheRoot) throw new Error('Document preview storage is unavailable.');
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Not a file.');
  const directory = join(cacheRoot, CACHE_DIR_NAME, cacheKey(path, info));
  const output = join(directory, PREVIEW_PDF_NAME);
  const identity = { format, mtimeMs: info.mtimeMs, size: info.size };
  const ready = await stat(output).catch(() => null);
  if (ready?.isFile() && ready.size > 0) {
    // Touch on USE, so eviction drops what nobody opens rather than what was
    // converted longest ago.
    const now = new Date();
    await utimes(directory, now, now).catch(() => {});
    return { path: output, ...identity, cached: true };
  }
  const running = conversions.get(output);
  if (running) return await running;
  const conversion = (async () => {
    await mkdir(directory, { recursive: true });
    try {
      await renderPortableOoxml(path, output, { signal });
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    await pruneCache(join(cacheRoot, CACHE_DIR_NAME));
    return { path: output, ...identity, cached: false };
  })().finally(() => conversions.delete(output));
  conversions.set(output, conversion);
  return await conversion;
}

/**
 * Rasterized pages of a converted document, for surfaces that cannot display
 * a PDF. `pages` is explicit and small: a viewer asks for what it is about to
 * show, and the answer carries the page COUNT so it can ask for the rest.
 * @returns {Promise<{ pageCount: number; pages: Array<{ page: number; width: number; height: number; mime: string; base64: string }> }>}
 */
export async function documentPreviewPages(pdfPath, {
  pages = [1],
  maxWidth = 1200,
  signal = null,
} = {}) {
  const rendered = await renderPdfPages(pdfPath, {
    pages: Array.isArray(pages) && pages.length ? pages : [1],
    maxWidth,
    signal,
  });
  return {
    pageCount: rendered.pageCount,
    pages: (rendered.images || []).map((image) => ({
      page: image.page,
      width: image.width,
      height: image.height,
      mime: image.mimeType || 'image/png',
      base64: image.data,
    })),
  };
}
