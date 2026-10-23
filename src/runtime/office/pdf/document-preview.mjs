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
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { renderPdfPages } from './pdf-render.mjs';
import { callMicrosoftOffice, detectMicrosoftOffice } from '../com/com-adapter.mjs';
import { libreOfficeAvailable, renderPortableOoxml } from '../portable/portable-soffice.mjs';

// What LibreOffice converts faithfully enough to READ. PDF is absent on
// purpose: it is already viewable and never needs the conversion pass.
const PREVIEW_FORMATS = new Set([
  'docx',
  'doc',
  'docm',
  'dotx',
  'rtf',
  'odt',
  'xlsx',
  'xls',
  'xlsm',
  'ods',
  'pptx',
  'ppt',
  'pptm',
  'odp',
]);

const CACHE_DIR_NAME = 'document-previews';
// Bounded on purpose: a converted PDF is worth keeping for the session that
// opens it again, never worth growing without limit inside the app's data
// directory.
const MAX_CACHED_DOCUMENTS = 24;
const PREVIEW_PDF_NAME = 'preview.pdf';
// Rasterized pages live beside, not inside, the PDF directories so their
// eviction counts stay independent.
const PAGE_CACHE_DIR_NAME = 'document-preview-pages';
const MAX_CACHED_PAGE_REVISIONS = 48;
const MAX_MEMORY_PAGES = 32;
const MAX_MEMORY_PAGE_BYTES = 48 * 1024 * 1024;

// The Office application family that opens each previewable extension.
const OFFICE_FAMILY = {
  docx: 'docx',
  doc: 'docx',
  docm: 'docx',
  dotx: 'docx',
  rtf: 'docx',
  odt: 'docx',
  xlsx: 'xlsx',
  xls: 'xlsx',
  xlsm: 'xlsx',
  ods: 'xlsx',
  pptx: 'pptx',
  ppt: 'pptx',
  pptm: 'pptx',
  odp: 'pptx',
};

/** Marks the "no converter installed" failure; the desktop shows it in the UI language. */
export const OFFICE_PREVIEW_UNAVAILABLE = 'OFFICE_PREVIEW_UNAVAILABLE';

/** Marks a password-protected document; the host reports it and the desktop words it. */
export const OFFICE_PREVIEW_PASSWORD_PROTECTED = 'OFFICE_PREVIEW_PASSWORD_PROTECTED';

const OFFICE_PREVIEW_RENDER_TIMEOUT_MS = 300_000;

const defaultEngines = {
  libreOfficeAvailable,
  renderLibreOffice: renderPortableOoxml,
  detectOffice: detectMicrosoftOffice,
  callOffice: callMicrosoftOffice,
};

function passwordProtectedError() {
  const error = new Error(`This file is password-protected and can't be previewed. (${OFFICE_PREVIEW_PASSWORD_PROTECTED})`);
  error.code = OFFICE_PREVIEW_PASSWORD_PROTECTED;
  return error;
}

// A binary (.ppt) presentation has no password argument to open it with: PowerPoint would wait on a hidden
// prompt. MS-PPT marks an encrypted one in its "Current User" stream: a CurrentUserAtom (record type 0x0FF6)
// whose headerToken is 0xF3D1C4DF, where an unencrypted file has 0xE391C05F. The token follows the record
// header and size, so a match must sit 10 bytes after the record type.
const ENCRYPTED_PRESENTATION_TOKEN = Buffer.from([0xdf, 0xc4, 0xd1, 0xf3]);

async function legacyPresentationEncrypted(path) {
  const bytes = await readFile(path);
  for (let at = bytes.indexOf(ENCRYPTED_PRESENTATION_TOKEN); at >= 0; at = bytes.indexOf(ENCRYPTED_PRESENTATION_TOKEN, at + 1)) {
    if (at >= 10 && bytes[at - 10] === 0xf6 && bytes[at - 9] === 0x0f) return true;
  }
  return false;
}

// Microsoft Office renders a private COPY of the document, read-only: the host
// opens it read-only (no recalculation, no link updates, macros off), exports the
// PDF, then closes the document without saving and quits the application
// instance it started. The copy keeps the source unlocked and unreachable.
async function renderWithMicrosoftOffice(path, output, family, { signal, callOffice }) {
  if (/\.ppt$/i.test(path) && (await legacyPresentationEncrypted(path))) throw passwordProtectedError();
  const scratch = await mkdtemp(join(tmpdir(), 'mixdog-preview-'));
  try {
    const copy = join(scratch, basename(path));
    await copyFile(path, copy);
    const result = await callOffice(
      { action: 'render', format: family, mode: 'background', readOnly: true, path: copy, output },
      { signal, timeoutMs: OFFICE_PREVIEW_RENDER_TIMEOUT_MS }
    );
    signal?.throwIfAborted();
    if (!result.ok) {
      if (String(result.error).includes(OFFICE_PREVIEW_PASSWORD_PROTECTED)) throw passwordProtectedError();
      throw new Error(result.error || 'Microsoft Office could not render this document.');
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function renderPreviewPdf(path, output, format, { signal, engines }) {
  if (await engines.libreOfficeAvailable()) {
    await engines.renderLibreOffice(path, output, { signal });
    return;
  }
  const family = OFFICE_FAMILY[format];
  const detected = await engines.detectOffice({ format: family });
  if (!detected?.applications?.some((application) => application.format === family && application.installed)) {
    const error = new Error(
      `Previewing Office files needs LibreOffice or Microsoft Office, and neither was found. To install LibreOffice, open Extensions → Built-in → Office and choose Install, then try again. (${OFFICE_PREVIEW_UNAVAILABLE})`
    );
    error.code = OFFICE_PREVIEW_UNAVAILABLE;
    throw error;
  }
  await renderWithMicrosoftOffice(path, output, family, { signal, callOffice: engines.callOffice });
}

/** The convertible format for this filename, or '' when there is none. */
export function documentPreviewFormat(path) {
  const name =
    String(path || '')
      .split(/[\\/]/)
      .at(-1) || '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  const extension = name.slice(dot + 1).toLocaleLowerCase();
  return PREVIEW_FORMATS.has(extension) ? extension : '';
}

function cacheKey(path, info) {
  return createHash('sha256').update(`${path}\0${info.mtimeMs}\0${info.size}`).digest('hex').slice(0, 32);
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
  const dated = await Promise.all(
    directories.map(async (entry) => {
      const target = join(root, entry.name);
      const info = await stat(target).catch(() => null);
      return { path: target, usedAt: info?.mtimeMs ?? 0 };
    })
  );
  dated.sort((left, right) => right.usedAt - left.usedAt);
  await Promise.all(
    dated.slice(MAX_CACHED_DOCUMENTS).map((entry) => rm(entry.path, { recursive: true, force: true }).catch(() => {}))
  );
}

// Two panes can open the same document in the same breath. Without this the
// second one starts a second LibreOffice run writing the same output file.
const conversions = new Map();

/**
 * The cached PDF rendition of one document, converting it when needed.
 * @returns {Promise<{ path: string; format: string; mtimeMs: number; size: number; cached: boolean }>}
 */
export async function documentPreviewPdf(path, { cacheRoot, signal = null, engines = defaultEngines } = {}) {
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
      await renderPreviewPdf(path, output, format, { signal, engines });
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
export async function documentPreviewPages(
  pdfPath,
  { pages = [1], maxWidth = 1200, signal = null, cacheRoot = '', renderPages = renderPdfPages } = {}
) {
  const wanted = Array.isArray(pages) && pages.length ? pages : [1];
  const info = await stat(pdfPath).catch(() => null);
  const revision = info?.isFile() ? pageRevision(pdfPath, info) : null;
  const found = new Map();
  const missing = [];
  let pageCount = 0;
  for (const page of wanted) {
    const hit = revision ? await cachedPage(revision, cacheRoot, page, maxWidth) : null;
    if (hit) {
      found.set(page, hit.entry);
      pageCount = hit.pageCount;
    } else {
      missing.push(page);
    }
  }
  if (missing.length) {
    const rendered = await renderPages(pdfPath, { pages: missing, maxWidth, signal });
    pageCount = rendered.pageCount;
    const fresh = (rendered.images || []).map((image) => ({
      page: image.page,
      width: image.width,
      height: image.height,
      mime: image.mimeType || 'image/png',
      base64: image.data,
    }));
    // Only pixels of the revision that was stat'ed may be stored under it.
    const after = revision ? await stat(pdfPath).catch(() => null) : null;
    const unchanged = after && after.mtimeMs === info.mtimeMs && after.size === info.size;
    for (const entry of fresh) {
      found.set(entry.page, entry);
      if (unchanged) await storePage(revision, cacheRoot, entry, pageCount, maxWidth);
    }
    if (unchanged && cacheRoot) await prunePageCache(join(cacheRoot, PAGE_CACHE_DIR_NAME), revision);
  }
  return { pageCount, pages: wanted.filter((page) => found.has(page)).map((page) => found.get(page)) };
}

function pageRevision(pdfPath, info) {
  const path = resolve(pdfPath);
  const sha = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
  return {
    path,
    memory: `${path}\0${info.mtimeMs}\0${info.size}`,
    directory: `${sha(path)}-${sha(`${info.mtimeMs}\0${info.size}`)}`,
    owner: sha(path),
  };
}

const memoryPages = new Map();
let memoryBytes = 0;

function rememberPage(key, value) {
  const previous = memoryPages.get(key);
  if (previous) memoryBytes -= previous.bytes;
  const bytes = value.entry.base64.length;
  memoryPages.delete(key);
  memoryPages.set(key, { ...value, bytes });
  memoryBytes += bytes;
  for (const [oldest, old] of memoryPages) {
    if (memoryBytes <= MAX_MEMORY_PAGE_BYTES && memoryPages.size <= MAX_MEMORY_PAGES) break;
    memoryPages.delete(oldest);
    memoryBytes -= old.bytes;
  }
}

function pageFile(revision, cacheRoot, page, maxWidth) {
  return join(cacheRoot, PAGE_CACHE_DIR_NAME, revision.directory, `${page}-${maxWidth}.json`);
}

async function cachedPage(revision, cacheRoot, page, maxWidth) {
  const key = `${revision.memory}\0${page}\0${maxWidth}`;
  const hot = memoryPages.get(key);
  if (hot) {
    rememberPage(key, hot);
    return hot;
  }
  if (!cacheRoot) return null;
  const file = pageFile(revision, cacheRoot, page, maxWidth);
  try {
    const stored = JSON.parse(await readFile(file, 'utf8'));
    if (!stored?.entry?.base64 || stored.entry.page !== page || !(stored.pageCount >= 1)) return null;
    const now = new Date();
    await utimes(join(file, '..'), now, now).catch(() => {});
    rememberPage(key, stored);
    return stored;
  } catch {
    return null;
  }
}

async function storePage(revision, cacheRoot, entry, pageCount, maxWidth) {
  const value = { entry, pageCount };
  rememberPage(`${revision.memory}\0${entry.page}\0${maxWidth}`, value);
  if (!cacheRoot) return;
  const file = pageFile(revision, cacheRoot, entry.page, maxWidth);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

// Older revisions of the same PDF can never be requested again, so they go;
// beyond that the least recently used revisions are dropped past a fixed count.
async function prunePageCache(root, current) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const remove = (name) => rm(join(root, name), { recursive: true, force: true }).catch(() => {});
  const keep = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === current.directory) continue;
    if (entry.name.startsWith(`${current.owner}-`)) await remove(entry.name);
    else keep.push(entry.name);
  }
  if (keep.length < MAX_CACHED_PAGE_REVISIONS) return;
  const dated = await Promise.all(
    keep.map(async (name) => ({ name, usedAt: (await stat(join(root, name)).catch(() => null))?.mtimeMs ?? 0 }))
  );
  dated.sort((left, right) => right.usedAt - left.usedAt);
  await Promise.all(dated.slice(MAX_CACHED_PAGE_REVISIONS - 1).map((entry) => remove(entry.name)));
}
