import { basename, dirname, extname, join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { readFile, rename, writeFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { zipText } from './portable-opc.mjs';
import { iterateSheetCells, workbookCalculation, workbookSheets } from './portable-cells.mjs';
import { xmlAttribute, xmlDecode } from './portable-xml.mjs';

const SOFFICE_PROBE_TIMEOUT_MS = 20_000;
const SOFFICE_RENDER_TIMEOUT_MS = 120_000;
const SOFFICE_CONVERT_TIMEOUT_MS = 60_000;

// The desktop must stay out of the way on every run: without these a first
// start opens the setup wizard and a previously killed run opens the recovery
// dialog, and a headless process then waits for a window nobody can answer.
const SOFFICE_QUIET_ARGS = [
  '--headless',
  '--invisible',
  '--nocrashreport',
  '--nodefault',
  '--nologo',
  '--nofirststartwizard',
  '--norestore',
];

// A detection probe must always answer. soffice.exe is a GUI launcher that can
// sit forever without exiting, which deadlocked detection before the rendering
// call was ever reached, so the probe is bounded and the child killed on expiry.
function commandExists(command) {
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(command, ['--version'], { windowsHide: true, stdio: 'ignore' });
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, SOFFICE_PROBE_TIMEOUT_MS);
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}

async function findLibreOfficeProgram() {
  const candidates =
    process.platform === 'win32'
      ? [
          // soffice.com is the console front-end: it reports through stdio and
          // exits once the conversion finishes. soffice.exe returns early or never,
          // so a caller awaiting its exit cannot tell when output is ready.
          'soffice.com',
          'C:\\Program Files\\LibreOffice\\program\\soffice.com',
          'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
        ]
      : ['soffice', 'libreoffice'];
  for (const candidate of candidates) {
    if (await commandExists(candidate)) return candidate;
  }
  return '';
}

let resolvedProgram = '';
let pendingLookup = null;

// Detection spawns a probe per candidate, so it is answered once and shared by
// everything waiting on it. A program that answered stays found for the life of
// this process; a negative answer is not remembered, because the user may
// install LibreOffice and retry without restarting the app.
async function libreOfficeProgram() {
  if (resolvedProgram) return resolvedProgram;
  pendingLookup ||= findLibreOfficeProgram().finally(() => {
    pendingLookup = null;
  });
  resolvedProgram = await pendingLookup;
  return resolvedProgram;
}

let pendingProfile = null;

// Conversion must never attach to the user's own running LibreOffice: a shared
// profile makes the second invocation either fail or block until the desktop
// window closes. It must not build a throwaway profile per call either —
// creating the profile costs far more than the conversion it serves. One
// private profile is built on first use and reused for the life of the process.
function sharedProfileDir() {
  pendingProfile ||= (async () => {
    const created = await mkdtemp(join(tmpdir(), 'mixdog-office-profile-'));
    // An exit handler cannot await, and a profile left behind accumulates one
    // directory per run of the app.
    process.once('exit', () => {
      try {
        rmSync(created, { recursive: true, force: true });
      } catch {}
    });
    return created;
  })();
  return pendingProfile;
}

// One profile means one LibreOffice at a time: a second process sharing it
// either fails outright or blocks until the first exits. Conversions therefore
// run in the order they were requested instead of racing each other.
let conversionQueue = Promise.resolve();

function queueConversion(work) {
  const result = conversionQueue.then(work, work);
  conversionQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

function runSoffice(program, args, { signal, timeoutMs, timeoutMessage, cancelMessage }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let stderr = '';
    const child = spawn(program, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, error: cancelMessage });
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => finish({ ok: false, error: error?.message || String(error) }));
    child.once('close', (code) =>
      finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `LibreOffice exited with code ${code}` })
    );
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, error: timeoutMessage });
    }, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// A run that failed or was killed can leave a document lock or a half-written
// registry behind, and a reused profile would hand that to every conversion
// after it. The profile is dropped instead, so the next one builds a clean copy.
async function discardProfileDir() {
  const pending = pendingProfile;
  pendingProfile = null;
  const directory = await pending.catch(() => '');
  if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
}

/** One headless conversion, queued behind the others and reported as `{ ok, error }`. */
function convertWithLibreOffice(program, input, { to, outDir, signal = null, timeoutMs, messages }) {
  // The profile is resolved inside the queue: a failed conversion ahead of this
  // one discards it, and the path it used is gone by the time this one runs.
  return queueConversion(async () => {
    const profile = await sharedProfileDir();
    const result = await runSoffice(
      program,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        ...SOFFICE_QUIET_ARGS,
        '--convert-to',
        to,
        '--outdir',
        outDir,
        input,
      ],
      { signal, timeoutMs, timeoutMessage: messages.timeout, cancelMessage: messages.cancelled }
    );
    if (!result.ok) await discardProfileDir();
    return result;
  });
}

/** Whether a LibreOffice front-end answers on this machine; portable rendering and recalculation need it. */
export async function libreOfficeAvailable() {
  return Boolean(await libreOfficeProgram());
}

const MAX_ERROR_LOCATIONS = 100;

// Error cells after a recalculation, tallied by error type with their
// locations, so the caller can name what to fix instead of counting.
export async function workbookFormulaErrors(zip) {
  const byType = {};
  const unparsed = [];
  let total = 0;
  for (const sheet of await workbookSheets(zip)) {
    const xml = await zipText(zip, sheet.path);
    for (const cell of iterateSheetCells(xml)) {
      const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(cell.body)?.[1] || '';
      // LibreOffice writes every formula it parsed back in upper case; one it
      // could not parse keeps a lower-case function name beside its #NAME?.
      if (formula && /(?:^|[^A-Za-z0-9_.])[a-z][a-z0-9.]*\s*\(/.test(formula.replace(/"(?:[^"]|"")*"/g, '""'))) {
        if (unparsed.length < MAX_ERROR_LOCATIONS) unparsed.push(`${sheet.name}!${cell.ref}`);
      }
      if (!/\bt="e"/.test(cell.attributes)) continue;
      const value = xmlDecode(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cell.body)?.[1] || '').trim();
      if (!value) continue;
      total += 1;
      byType[value] ||= { count: 0, cells: [], truncated: 0 };
      const entry = byType[value];
      entry.count += 1;
      if (entry.cells.length < MAX_ERROR_LOCATIONS) entry.cells.push(`${sheet.name}!${cell.ref}`);
      else entry.truncated += 1;
    }
  }
  return { total, byType, unparsed };
}

// Formula cells in the workbook, and how many of them carry no cached value.
async function workbookFormulaCounts(zip) {
  let formulaCount = 0;
  let missingCachedValues = 0;
  for (const name of Object.keys(zip.files).filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry))) {
    const xml = await zipText(zip, name);
    for (const match of xml.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/gi)) {
      if (!/<f(?:\s[^>]*)?>/i.test(match[1])) continue;
      formulaCount += 1;
      if (!/<v(?:\s[^>]*)?>[\s\S]*?<\/v>/i.test(match[1])) missingCachedValues += 1;
    }
  }
  return { formulaCount, missingCachedValues };
}

// Round-trips the workbook through LibreOffice in a scratch directory and
// returns the recalculated bytes, or the reason none came back.
async function convertWorkbookWithLibreOffice(program, path, source, signal) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-office-recalculate-'));
  const inputDir = join(root, 'input');
  const outputDir = join(root, 'output');
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  const input = join(inputDir, basename(path));
  await writeFile(input, source);
  try {
    const result = await convertWithLibreOffice(program, input, {
      to: 'xlsx',
      outDir: outputDir,
      signal,
      timeoutMs: SOFFICE_CONVERT_TIMEOUT_MS,
      messages: {
        timeout: `Portable XLSX recalculation timed out after ${SOFFICE_CONVERT_TIMEOUT_MS / 1000} seconds`,
        cancelled: 'Portable XLSX recalculation was cancelled',
      },
    });
    if (!result.ok) return { reason: result.error };
    const generated = join(outputDir, `${basename(path, extname(path))}.xlsx`);
    const details = await stat(generated).catch(() => null);
    if (!details?.isFile() || details.size <= 0) return { reason: 'LibreOffice produced no recalculated workbook.' };
    return { recalculated: await readFile(generated), outputBytes: details.size };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// The recalculation is a roundtrip through another office suite, and it comes
// back with more than the values. These are the parts it invents: the chart
// style and colour-style extensions, which this runtime never authors and
// which fail Microsoft's schema, so a workbook carrying a chart could never be
// finalized once it had been calculated.
const OPTIONAL_CHART_PARTS = /^xl\/charts\/(?:style|colors)\d*\.xml$/i;

const FONT_ELEMENT = /<font\b[^>]*>[\s\S]*?<\/font>|<font\b[^>]*\/>/g;

async function dropRemovedParts(zip, removed) {
  const partNames = new Set(removed.map((name) => `/${name}`));
  const types = await zipText(zip, '[Content_Types].xml');
  if (types) {
    zip.file(
      '[Content_Types].xml',
      types.replace(/<Override\b[^>]*\/>/g, (entry) => (partNames.has(xmlAttribute(entry, 'PartName')) ? '' : entry))
    );
  }
  for (const name of Object.keys(zip.files)) {
    if (!/\.rels$/i.test(name)) continue;
    const xml = await zipText(zip, name);
    if (!xml) continue;
    // xl/charts/_rels/chart1.xml.rels resolves its targets against xl/charts.
    const owner = posix.dirname(posix.dirname(name));
    const next = xml.replace(/<Relationship\b[^>]*\/>/g, (entry) => {
      const target = String(xmlAttribute(entry, 'Target') || '');
      if (!target || /^[a-z]+:/i.test(target)) return entry;
      const resolved = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(owner, target));
      return removed.includes(resolved) ? '' : entry;
    });
    if (next !== xml) zip.file(name, next);
  }
}

// Hangul cells came back in a face the converter chose, while the numbers
// beside them kept the authored one, so a sheet written in a single family
// reached the reader in two. The authored names are written back by position;
// anything the styles gained keeps what it came with.
async function restoreAuthoredFonts(originalZip, produced) {
  const before = await zipText(originalZip, 'xl/styles.xml');
  const after = await zipText(produced, 'xl/styles.xml');
  if (!before || !after) return 0;
  const authored = String(before).match(FONT_ELEMENT) || [];
  if (!authored.length) return 0;
  const fontName = (entry) => /<name\s+val="([^"]*)"/i.exec(entry)?.[1] || '';
  let restored = 0;
  let index = -1;
  const next = String(after).replace(FONT_ELEMENT, (entry) => {
    index += 1;
    const wanted = fontName(authored[index] || '');
    const actual = fontName(entry);
    if (!wanted || !actual || wanted === actual) return entry;
    restored += 1;
    return entry.replace(/<name\s+val="[^"]*"/i, `<name val="${wanted}"`);
  });
  if (restored) produced.file('xl/styles.xml', next);
  return restored;
}

// The mark an edit leaves says the values are stale. Once they have been
// calculated it comes off, or every later read pays for a recalculation that
// has nothing left to do.
function clearForcedRecalculation(xml) {
  return xml.replace(/<calcPr\b([^>]*?)\/?>/i, (_match, sourceAttributes) => {
    const attributes = String(sourceAttributes || '')
      .replace(/\/\s*$/, '')
      .replace(/\s*\bfullCalcOnLoad="[^"]*"/i, '')
      .replace(/\s*\bforceFullCalc="[^"]*"/i, '');
    return `<calcPr${attributes}/>`;
  });
}

// LibreOffice keeps a cached formula value exactly as it finds it and computes
// only the cells that have none: handing it an edited workbook returned the
// answers from before the edit, which is how a corrected input still rendered
// its old number. Dropping the cached values from the copy it is handed is what
// makes it calculate every formula — a full calculation, the way Excel would.
async function withoutFormulaCache(source) {
  const zip = await JSZip.loadAsync(source);
  let stripped = 0;
  for (const name of Object.keys(zip.files).filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry))) {
    const xml = await zipText(zip, name);
    const next = xml.replace(/(<f\b[^>]*>[\s\S]*?<\/f>)\s*<v\b[^>]*>[\s\S]*?<\/v>/g, (_match, formula) => {
      stripped += 1;
      return formula;
    });
    if (next !== xml) zip.file(name, next);
  }
  if (!stripped) return source;
  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS',
  });
}

/** Keeps the values the roundtrip computed and returns everything it invented
 *  or substituted to the way the workbook was authored. */
async function normalizeRoundtrip(originalZip, bytes) {
  const produced = await JSZip.loadAsync(bytes);
  const removedParts = [];
  const restoredParts = [];
  for (const name of Object.keys(produced.files)) {
    if (!OPTIONAL_CHART_PARTS.test(name)) continue;
    const original = originalZip.file(name);
    if (original) {
      produced.file(name, await original.async('nodebuffer'));
      restoredParts.push(name);
      continue;
    }
    produced.remove(name);
    removedParts.push(name);
  }
  if (removedParts.length) await dropRemovedParts(produced, removedParts);
  const restoredFonts = await restoreAuthoredFonts(originalZip, produced);
  const workbookXml = await zipText(produced, 'xl/workbook.xml');
  if (workbookXml) produced.file('xl/workbook.xml', clearForcedRecalculation(workbookXml));
  return {
    bytes: await produced.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    summary: {
      ...(removedParts.length ? { removedParts } : {}),
      ...(restoredParts.length ? { restoredParts } : {}),
      ...(restoredFonts ? { restoredFonts } : {}),
    },
  };
}

export async function recalculateLibreOfficeWorkbook(path, { force = false, signal = null } = {}) {
  const source = await readFile(path);
  const zip = await JSZip.loadAsync(source);
  const counts = await workbookFormulaCounts(zip);
  // A cached value is not a fresh one. Editing an input leaves every dependent
  // formula's cache in place, so a workbook that was written, closed, and
  // reopened answered with the numbers from before the edit — and an error a
  // guard had swallowed stayed swallowed. The edit path marks the workbook for
  // a full calculation, and that mark is what staleness looks like on disk.
  const stale = workbookCalculation(await zipText(zip, 'xl/workbook.xml')).fullCalcOnLoad === true;
  const needed = counts.formulaCount > 0 && (force || stale || counts.missingCachedValues > 0);
  if (!needed) return { needed: false, recalculated: false, ...counts };
  const unavailable = (reason) => ({
    needed: true,
    available: false,
    recalculated: false,
    ...(stale ? { stale: true } : {}),
    ...counts,
    reason,
  });
  if (extname(path).toLowerCase() !== '.xlsx') {
    return unavailable(
      'Portable formula recalculation currently supports .xlsx only; use Microsoft Office background mode for macro-enabled or template workbooks.'
    );
  }
  if (Object.keys(zip.files).some((entry) => /^xl\/externalLinks\//i.test(entry))) {
    return unavailable(
      'Portable formula recalculation is blocked because LibreOffice may invalidate external workbook links.'
    );
  }
  const program = await libreOfficeProgram();
  if (!program) return unavailable('LibreOffice is unavailable for portable XLSX recalculation.');
  const converted = await convertWorkbookWithLibreOffice(
    program,
    path,
    stale || force ? await withoutFormulaCache(source) : source,
    signal
  );
  if (!converted.recalculated) {
    return {
      needed: true,
      available: true,
      recalculated: false,
      ...(stale ? { stale: true } : {}),
      ...counts,
      reason: converted.reason,
    };
  }
  const normalized = await normalizeRoundtrip(zip, converted.recalculated);
  await writeFile(path, normalized.bytes);
  const errors = await workbookFormulaErrors(await JSZip.loadAsync(normalized.bytes));
  return {
    needed: true,
    available: true,
    recalculated: true,
    ...(stale ? { stale: true } : {}),
    backend: 'libreoffice',
    // A clean status proves the formulas evaluate, not that they are right.
    status: errors.total ? 'errors_found' : 'success',
    ...counts,
    totalErrors: errors.total,
    errorSummary: errors.byType,
    ...(errors.unparsed.length ? { unparsedFormulas: errors.unparsed } : {}),
    ...(Object.keys(normalized.summary).length ? { normalized: normalized.summary } : {}),
    outputBytes: normalized.bytes.length,
  };
}

export async function validateLibreOfficeReopen(path, { signal = null } = {}) {
  const program = await libreOfficeProgram();
  if (!program) return { available: false, opened: false, backend: 'libreoffice' };
  const outputDir = await mkdtemp(join(tmpdir(), 'mixdog-office-libreoffice-'));
  try {
    const result = await convertWithLibreOffice(program, path, {
      to: 'pdf',
      outDir: outputDir,
      signal,
      timeoutMs: SOFFICE_CONVERT_TIMEOUT_MS,
      messages: {
        timeout: `LibreOffice reopen timed out after ${SOFFICE_CONVERT_TIMEOUT_MS / 1000} seconds`,
        cancelled: 'LibreOffice reopen was cancelled',
      },
    });
    if (!result.ok) return { available: true, opened: false, backend: 'libreoffice', error: result.error };
    const details = await stat(join(outputDir, `${basename(path, extname(path))}.pdf`)).catch(() => null);
    if (!details?.isFile() || details.size <= 0)
      return { available: true, opened: false, backend: 'libreoffice', error: 'LibreOffice produced no review PDF' };
    return { available: true, opened: true, backend: 'libreoffice', outputBytes: details.size };
  } finally {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function renderPortableOoxml(path, output, { signal = null } = {}) {
  const program = await libreOfficeProgram();
  if (!program) {
    throw new Error(
      'Portable Office rendering requires LibreOffice; install LibreOffice or open the document in background mode to render through Microsoft Office'
    );
  }
  const outputDir = dirname(output);
  const result = await convertWithLibreOffice(program, path, {
    to: 'pdf',
    outDir: outputDir,
    signal,
    timeoutMs: SOFFICE_RENDER_TIMEOUT_MS,
    messages: {
      timeout: `LibreOffice rendering timed out after ${SOFFICE_RENDER_TIMEOUT_MS / 1000} seconds`,
      cancelled: 'Office rendering was cancelled',
    },
  });
  if (!result.ok) throw new Error(result.error);
  const generated = join(outputDir, `${basename(path, extname(path))}.pdf`);
  if (generated !== output) await rename(generated, output);
  return output;
}
