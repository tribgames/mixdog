// The calls the extension host serves: the office tool and the pdf.js inspection, page render and
// OCR the `read` tool uses. Each handler returns `{ value, pin }` (see worker-core.mjs). A worker
// has no session state of its own: the paths a call may touch arrive with the call.
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Script } from 'node:vm';
import { documentHandlers } from './document.mjs';
import { isInside } from './path-scope.mjs';
import { sharedBrowserProvider } from './render-browser.mjs';

const coded = (code, message) => Object.assign(new Error(message), { code });

/** The path with every symlink resolved; a part that does not exist yet keeps its name. */
function realPath(target) {
  try {
    return realpathSync.native(target);
  } catch (error) {
    const parent = dirname(target);
    if (error.code !== 'ENOENT' || parent === target) throw error;
    return join(realPath(parent), basename(target));
  }
}

/**
 * The path a call will touch, refused unless the approved paths cover it. It is normalized the way
 * office authoring reads it (trimmed, then resolved against `base`) and approved by its real path,
 * so neither stray whitespace nor a symlink can lead outside the approved set.
 */
function approvedPath(ctx, path, base = '') {
  const given = String(path).trim();
  if (!base && !isAbsolute(given)) throw coded('path_not_approved', `path must be absolute: ${path}`);
  const target = isAbsolute(given) ? resolve(given) : resolve(base, given);
  const real = realPath(target);
  if (!ctx.paths.some((root) => isInside(realPath(resolve(root)), real))) {
    throw coded('path_not_approved', `path is not approved for this call: ${target}`);
  }
  return target;
}

// ---- office ---------------------------------------------------------------------------------

// Office sessions live in this process's memory, so the thread that created one must keep coming
// back to this worker. The core pins a thread to the worker for as long as it reports `pin`.
const sessionsByThread = new Map();
let browserCall = null;
let browserProviderInstalled = false;

async function installSharedBrowser() {
  if (browserProviderInstalled) return;
  browserProviderInstalled = true;
  const [{ setHtmlBrowserProvider }, puppeteer] = await Promise.all([
    import('../runtime/office/authoring/html-browser.mjs'),
    import('puppeteer-core').then((m) => m.default),
  ]);
  setHtmlBrowserProvider(
    sharedBrowserProvider({
      requestBrowser: () => browserCall.requestBrowser(),
      connect: (browserWSEndpoint) => puppeteer.connect({ browserWSEndpoint }),
    })
  );
}

async function emitBlob(ctx, content) {
  if (content === null) return null;
  if (!Buffer.isBuffer(content)) return { uncaptured: true };
  await ctx.emit(content);
  return { bytes: content.length };
}

async function officeRun(ctx) {
  const { args = {}, cwd, dataDir } = ctx.params;
  for (const key of ['path', 'output']) {
    // Execution gets the exact path that was approved, not the text that was given.
    if (typeof args[key] === 'string' && args[key].trim()) args[key] = approvedPath(ctx, args[key], cwd);
  }
  const [{ executeOfficeTool }, { sessions }, ledgerApi] = await Promise.all([
    import('../runtime/office/index.mjs'),
    import('../runtime/office/core/office-core.mjs'),
    import('../runtime/office/core/office-write-ledger.mjs'),
  ]);
  await installSharedBrowser();
  browserCall = ctx;
  const known = new Set(sessions.keys());
  const { ledger, run } = ledgerApi.runWithOfficeWriteLedger({ cwd, dataDir }, () =>
    executeOfficeTool(args, { cwd, dataDir, signal: ctx.signal })
  );
  let result;
  try {
    result = await run;
  } finally {
    browserCall = null;
    const owned = sessionsByThread.get(ctx.thread) ?? new Set();
    for (const id of sessions.keys()) if (!known.has(id)) owned.add(id);
    for (const id of owned) if (!sessions.has(id)) owned.delete(id);
    if (owned.size) sessionsByThread.set(ctx.thread, owned);
    else sessionsByThread.delete(ctx.thread);
  }
  // The files the call wrote go back to the core as receipts: before/after bytes follow as chunks
  // in this order (before, then after, per change), so the core's turn review can offer undo.
  const writes = [];
  for (const { fullPath, before, after } of ledgerApi.officeWriteChanges(ledger)) {
    writes.push({ path: fullPath, before: await emitBlob(ctx, before), after: await emitBlob(ctx, after) });
  }
  return { value: { result, writes }, pin: sessionsByThread.has(ctx.thread) };
}

// ---- pdf.js ---------------------------------------------------------------------------------

async function pdfInspect(ctx) {
  const { path, ...options } = ctx.params;
  if (options.maxPages === 'unlimited') options.maxPages = Infinity;
  const buffer = await readFile(approvedPath(ctx, path));
  const { inspectPdfBuffer } = await import('../runtime/attachments/pdf-extract.mjs');
  return { value: await inspectPdfBuffer(buffer, options) };
}

// The page images come back as chunks, in `images` order; each entry carries its byte count.
async function pdfRender(ctx) {
  const { path, pages = null, maxWidth, maximumScale } = ctx.params;
  const { renderPdfPages } = await import('../runtime/office/pdf/pdf-render.mjs');
  const rendered = await renderPdfPages(approvedPath(ctx, path), {
    pages,
    maxWidth,
    maximumScale,
    signal: ctx.signal,
    writeImages: false,
  });
  const images = [];
  for (const { data, ...image } of rendered.images) {
    const bytes = Buffer.from(data, 'base64');
    await ctx.emit(bytes);
    images.push({ ...image, bytes: bytes.length });
  }
  return { value: { ...rendered, images } };
}

async function pdfOcr(ctx) {
  const { path, pages, dataDir, languages } = ctx.params;
  const { recognizePdfPageTexts } = await import('../runtime/office/pdf/pdf-ocr.mjs');
  const texts = await recognizePdfPageTexts(approvedPath(ctx, path), pages, {
    dataDir,
    languages,
    signal: ctx.signal,
  });
  return { value: texts };
}

// ---- ooxml ----------------------------------------------------------------------------------

// The text of a .docx/.pptx/.xlsx/.xlsm, by the same two Node entry points: with container limits
// (provider lowering) an unreadable file is `null`; without them (the read tool) the failure is
// the "Error: ..." text the tool shows.
async function ooxmlText(ctx) {
  const { path, filename, maxOutputBytes, maxPartBytes, maxContainerBytes } = ctx.params;
  const file = approvedPath(ctx, path);
  const office = await import('../runtime/attachments/office-extract.mjs');
  const output = maxOutputBytes === undefined ? {} : { maxOutputBytes };
  if (maxPartBytes === undefined && maxContainerBytes === undefined) {
    return { value: { text: await office.extractOoxmlText(file, output) } };
  }
  let buffer;
  try {
    buffer = await readFile(file);
  } catch {
    return { value: { text: null } };
  }
  const text = office.tryExtractOoxmlTextFromBuffer(buffer, filename ?? file, { ...output, maxPartBytes, maxContainerBytes });
  return { value: { text } };
}

// ---- syntax ---------------------------------------------------------------------------------

// Whether Node (V8) compiles `source`, for callers that must decide exactly as Node does. Only
// the kinds listed here exist; `commonjs-script` is `new vm.Script(source)`.
async function syntaxCheck(ctx) {
  const { source, kind } = ctx.params;
  if (kind !== 'commonjs-script') throw coded('invalid_kind', `unknown syntax kind: ${kind}`);
  if (typeof source !== 'string') throw coded('invalid_params', 'source must be a string');
  try {
    new Script(source);
    return { value: { ok: true } };
  } catch (error) {
    return { value: { ok: false, message: String(error?.message ?? error) } };
  }
}

export const handlers = {
  ...documentHandlers,
  'syntax.check': syntaxCheck,
  'ooxml.text': ooxmlText,
  'office.run': officeRun,
  'pdf.inspect': pdfInspect,
  'pdf.render': pdfRender,
  'pdf.ocr': pdfOcr,
};
