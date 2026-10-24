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
import { rmSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  isEncryptedBinaryPresentation,
  isEncryptedOoxml,
  isEncryptedWordDocument,
  readEncryptedOoxml,
  readOoxmlEncryptionInfo,
} from './cfb-protection.mjs';
import { decryptOoxmlPackage, ooxmlEncryption, ooxmlPackageIntact, ooxmlPasswordKey } from './ooxml-crypto.mjs';
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

/** Marks a password-protected document that a password can open: the desktop asks for it. */
export const OFFICE_PREVIEW_PASSWORD_PROTECTED = 'OFFICE_PREVIEW_PASSWORD_PROTECTED';

/** The password given for a protected document does not open it. */
export const OFFICE_PREVIEW_WRONG_PASSWORD = 'OFFICE_PREVIEW_WRONG_PASSWORD';

/** A protected document no password route can preview (an encrypted .ppt, an unknown encryption). */
export const OFFICE_PREVIEW_PASSWORD_UNSUPPORTED = 'OFFICE_PREVIEW_PASSWORD_UNSUPPORTED';

/** A protected binary Word document only Microsoft Word can open with its password, and Word is not installed. */
export const OFFICE_PREVIEW_PASSWORD_NEEDS_OFFICE = 'OFFICE_PREVIEW_PASSWORD_NEEDS_OFFICE';

/**
 * A protected document whose encrypted package fails its integrity check ([MS-OFFCRYPTO] 2.3.4.14), or whose
 * integrity data cannot be checked: it is never rendered, whatever the password.
 */
export const OFFICE_PREVIEW_PASSWORD_CORRUPT = 'OFFICE_PREVIEW_PASSWORD_CORRUPT';

const OFFICE_PREVIEW_RENDER_TIMEOUT_MS = 300_000;

const defaultEngines = {
  libreOfficeAvailable,
  renderLibreOffice: renderPortableOoxml,
  detectOffice: detectMicrosoftOffice,
  callOffice: callMicrosoftOffice,
};

function codedError(message, code) {
  const error = new Error(`${message} (${code})`);
  error.code = code;
  return error;
}

const passwordProtectedError = () =>
  codedError("This file is password-protected and can't be previewed.", OFFICE_PREVIEW_PASSWORD_PROTECTED);
const wrongPasswordError = () => codedError("That password didn't work.", OFFICE_PREVIEW_WRONG_PASSWORD);
const passwordUnsupportedError = () =>
  codedError("This file is password-protected and can't be previewed.", OFFICE_PREVIEW_PASSWORD_UNSUPPORTED);
const passwordNeedsOfficeError = () =>
  codedError('Previewing this password-protected file needs Microsoft Office.', OFFICE_PREVIEW_PASSWORD_NEEDS_OFFICE);
const passwordCorruptError = () =>
  codedError("This password-protected file is damaged and can't be previewed.", OFFICE_PREVIEW_PASSWORD_CORRUPT);

// An engine's error text may echo what it was given; the password never leaves in it.
const withoutPassword = (text, password) => (password ? String(text).split(password).join('***') : String(text));

// Microsoft Office renders a private COPY of the document, read-only: the host
// opens it read-only (no recalculation, no link updates, macros off), exports the
// PDF, then closes the document without saving and quits the application
// instance it started. The copy keeps the source unlocked and unreachable. A
// password travels in the request on the host's stdin, never on its command line.
async function renderWithMicrosoftOffice(path, output, family, { signal, engines, password }) {
  const { callOffice, removeDirectory: remove, removeBackoffMs: backoffMs } = engines;
  const scratch = await createScratch('mixdog-preview-');
  let result;
  try {
    const copy = join(scratch, basename(path));
    await copyFile(path, copy);
    const request = { action: 'render', format: family, mode: 'background', readOnly: true, path: copy, output };
    if (password) request.password = password;
    result = await callOffice(request, { signal, timeoutMs: OFFICE_PREVIEW_RENDER_TIMEOUT_MS });
    signal?.throwIfAborted();
    if (!result.ok) {
      const error = String(result.error);
      if (error.includes(OFFICE_PREVIEW_WRONG_PASSWORD)) throw wrongPasswordError();
      if (error.includes(OFFICE_PREVIEW_PASSWORD_PROTECTED)) throw passwordProtectedError();
      throw new Error(withoutPassword(result.error || 'Microsoft Office could not render this document.', password));
    }
  } finally {
    await removeScratch(scratch, result?.hostExit, { remove, backoffMs });
  }
}

// Every scratch directory this module creates holds document content: a private copy for Microsoft Office, a
// decrypted package, an unlocked PDF. Each is tracked from its creation, while its render still runs, until its
// removal is confirmed; whatever is still tracked when the process exits (a removal that kept failing, a render
// still running) is removed then.
const scratchDirectories = new Set();
let scratchExitHook = false;

async function createScratch(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  scratchDirectories.add(directory);
  if (!scratchExitHook) {
    scratchExitHook = true;
    process.once('exit', removeTrackedPreviewScratchSync);
  }
  return directory;
}

/** Scratch directories whose removal is not confirmed yet (for diagnostics and tests). */
export const trackedPreviewScratch = () => [...scratchDirectories];

/** Removes every tracked scratch directory at once; the process does this as it exits. */
export function removeTrackedPreviewScratchSync() {
  for (const directory of scratchDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
      scratchDirectories.delete(directory);
    } catch {}
  }
}

// Whether a path lies inside a tracked scratch directory (an unlocked PDF does).
function inScratch(path) {
  const target = resolve(path);
  for (const directory of scratchDirectories) {
    const inside = relative(directory, target);
    if (inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return true;
  }
  return false;
}

// A cancelled render can return while the host (and so Office) still holds the copy open. The first
// removal is immediate; if it fails, ownership moves to a background task that waits for the host to
// exit and retries a bounded number of times with growing delays. The caller never waits on it. The
// directory stays tracked until a removal succeeds, so one that never does is removed at exit.
const SCRATCH_REMOVE_ATTEMPTS = 6;
const SCRATCH_REMOVE_BACKOFF_MS = 250;

const removeTree = (target) => rm(target, { recursive: true, force: true });

async function removeScratch(scratch, hostExit, { remove = removeTree, backoffMs = SCRATCH_REMOVE_BACKOFF_MS } = {}) {
  const removed = async () => {
    try {
      await remove(scratch);
    } catch {
      return false;
    }
    scratchDirectories.delete(scratch);
    return true;
  };
  if (await removed()) return;
  void (async () => {
    await Promise.resolve(hostExit).catch(() => {});
    for (let attempt = 0; attempt < SCRATCH_REMOVE_ATTEMPTS; attempt++) {
      await new Promise((done) => setTimeout(done, backoffMs * 2 ** attempt).unref?.());
      if (await removed()) return;
    }
  })();
}

// What protects a document, read from its container before any renderer starts (a hidden PowerPoint or Word would
// wait on a password prompt nobody sees, LibreOffice would fail late): an encrypted OOXML package this module
// unlocks with the password ('package'), one whose integrity data is malformed ('corrupt'), an encrypted binary
// Word document Word opens with it ('word'), a protection no password route opens ('unsupported'), or null. An
// unreadable container is left to the renderer.
async function protection(path) {
  if (/\.ppt$/i.test(path)) return (await isEncryptedBinaryPresentation(path)) ? 'unsupported' : null;
  if (/\.doc$/i.test(path)) return (await isEncryptedWordDocument(path)) ? 'word' : null;
  if (/\.(docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|potx|potm|ppsx|ppsm)$/i.test(path)) {
    if (!(await isEncryptedOoxml(path))) return null;
    const descriptor = ooxmlEncryption(await readOoxmlEncryptionInfo(path));
    if (!descriptor) return 'unsupported';
    return descriptor.integrity?.malformed ? 'corrupt' : 'package';
  }
  return null;
}

async function officeInstalled(engines, family) {
  const detected = await engines.detectOffice({ format: family });
  return Boolean(detected?.applications?.some((application) => application.format === family && application.installed));
}

// LibreOffice when it is available, else Microsoft Office. A password only reaches Microsoft Office: a document
// its host finds protected (a legacy one the container check does not cover) is opened with it there.
async function renderWithEngine(path, output, format, { signal, engines, password }) {
  if (await engines.libreOfficeAvailable()) {
    await engines.renderLibreOffice(path, output, { signal });
    return;
  }
  const family = OFFICE_FAMILY[format];
  if (!(await officeInstalled(engines, family))) {
    throw codedError(
      'Previewing Office files needs LibreOffice or Microsoft Office, and neither was found. To install LibreOffice, open Extensions → Built-in → Office and choose Install, then try again.',
      OFFICE_PREVIEW_UNAVAILABLE
    );
  }
  await renderWithMicrosoftOffice(path, output, family, { signal, engines, password });
}

// An encrypted OOXML package is opened the way [MS-OFFCRYPTO] specifies (see ooxml-crypto.mjs): the password
// verifier decides a wrong password without starting anything (its hashing off this thread, ended by `signal`),
// the package's HMAC must then prove it intact, and only then does the key decrypt it into a private scratch copy
// that the usual engine renders and that is removed with it. No engine ever sees the password.
async function renderUnlockedPackage(path, output, format, { signal, engines, password }) {
  const encrypted = await readEncryptedOoxml(path);
  const descriptor = encrypted && ooxmlEncryption(encrypted.encryptionInfo);
  if (!descriptor) throw passwordUnsupportedError();
  if (descriptor.integrity?.malformed) throw passwordCorruptError();
  const key = await ooxmlPasswordKey(descriptor, password, { signal });
  if (!key) throw wrongPasswordError();
  if (!ooxmlPackageIntact(descriptor, key, encrypted.encryptedPackage)) throw passwordCorruptError();
  const plain = decryptOoxmlPackage(descriptor, key, encrypted.encryptedPackage);
  signal?.throwIfAborted();
  const scratch = await createScratch('mixdog-unlocked-');
  try {
    const copy = join(scratch, basename(path));
    await writeFile(copy, plain, { mode: 0o600 });
    await renderWithEngine(copy, output, format, { signal, engines });
  } finally {
    await removeScratch(scratch, undefined, { remove: engines.removeDirectory, backoffMs: engines.removeBackoffMs });
  }
}

async function renderPreviewPdf(path, output, format, { signal, engines, password }) {
  const protectedBy = await protection(path);
  if (protectedBy === 'unsupported') throw passwordUnsupportedError();
  if (protectedBy === 'corrupt') throw passwordCorruptError();
  if (protectedBy === 'package') {
    if (!password) throw passwordProtectedError();
    await renderUnlockedPackage(path, output, format, { signal, engines, password });
    return;
  }
  if (protectedBy === 'word') {
    // LibreOffice's conversion takes no password, so only Word can open it.
    if (!(await officeInstalled(engines, 'docx'))) throw passwordNeedsOfficeError();
    if (!password) throw passwordProtectedError();
    await renderWithMicrosoftOffice(path, output, 'docx', { signal, engines, password });
    return;
  }
  await renderWithEngine(path, output, format, { signal, engines, password });
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

// A document opened with its password is never written to the cache: its PDF lives in a private scratch directory
// for as long as this process runs (or until newer unlocks push it out), so the viewer's later page requests are
// served without the password, and nothing of it outlives the process. Keyed by source identity like the cache, so
// a changed document asks for its password again. An entry pushed out is no longer served at once; its directory
// stays tracked (and its pages off disk) until its removal is confirmed.
const MAX_UNLOCKED_DOCUMENTS = 8;
const unlockedPreviews = new Map();

function forgetUnlocked(key) {
  const entry = unlockedPreviews.get(key);
  if (!entry) return;
  unlockedPreviews.delete(key);
  void removeScratch(entry.directory, undefined, entry.removal);
}

function rememberUnlocked(key, entry) {
  forgetUnlocked(key);
  unlockedPreviews.set(key, entry);
  for (const oldest of unlockedPreviews.keys()) {
    if (unlockedPreviews.size <= MAX_UNLOCKED_DOCUMENTS) break;
    forgetUnlocked(oldest);
  }
}

async function unlockedPreview(key) {
  const entry = unlockedPreviews.get(key);
  if (!entry) return null;
  const ready = await stat(entry.output).catch(() => null);
  if (!ready?.isFile()) {
    forgetUnlocked(key);
    return null;
  }
  // Most recently used last, so eviction drops the one nobody looked at.
  unlockedPreviews.delete(key);
  unlockedPreviews.set(key, entry);
  return entry.output;
}

async function renderUnlocked(path, key, identity, { signal, engines, password }) {
  const removal = { remove: engines.removeDirectory, backoffMs: engines.removeBackoffMs };
  const directory = await createScratch('mixdog-unlocked-preview-');
  const output = join(directory, PREVIEW_PDF_NAME);
  try {
    await renderPreviewPdf(path, output, identity.format, { signal, engines, password });
  } catch (error) {
    await removeScratch(directory, undefined, removal);
    throw error;
  }
  rememberUnlocked(key, { directory, output, removal });
  return { path: output, ...identity, cached: false };
}

/**
 * The cached PDF rendition of one document, converting it when needed. `password` opens a protected document for
 * this one request; it is handed to the opening step and nowhere else.
 * @returns {Promise<{ path: string; format: string; mtimeMs: number; size: number; cached: boolean }>}
 */
export async function documentPreviewPdf(
  path,
  { cacheRoot, signal = null, engines = defaultEngines, password = '' } = {}
) {
  const format = documentPreviewFormat(path);
  if (!format) throw new Error('This file type has no built-in document preview.');
  if (!cacheRoot) throw new Error('Document preview storage is unavailable.');
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Not a file.');
  const key = cacheKey(path, info);
  const directory = join(cacheRoot, CACHE_DIR_NAME, key);
  const output = join(directory, PREVIEW_PDF_NAME);
  const identity = { format, mtimeMs: info.mtimeMs, size: info.size };
  const unlocked = await unlockedPreview(key);
  if (unlocked) return { path: unlocked, ...identity, cached: true };
  if (password) return await renderUnlocked(path, key, identity, { signal, engines, password });
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
  { pages = [1], maxWidth = 1200, signal = null, cacheRoot: storageRoot = '', renderPages = renderPdfPages } = {}
) {
  // Pages of a document opened with its password stay in memory only, like its PDF.
  const cacheRoot = inScratch(pdfPath) ? '' : storageRoot;
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
