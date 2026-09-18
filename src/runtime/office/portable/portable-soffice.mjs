import { basename, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { readFile, rename, writeFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { zipText } from './portable-opc.mjs';
import { iterateSheetCells, workbookSheets } from './portable-cells.mjs';
import { xmlDecode } from './portable-xml.mjs';

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

export async function recalculateLibreOfficeWorkbook(path, { force = false, signal = null } = {}) {
  const source = await readFile(path);
  const zip = await JSZip.loadAsync(source);
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
  const needed = formulaCount > 0 && (force || missingCachedValues > 0);
  if (!needed) {
    return {
      needed: false,
      recalculated: false,
      formulaCount,
      missingCachedValues,
    };
  }
  if (extname(path).toLowerCase() !== '.xlsx') {
    return {
      needed: true,
      available: false,
      recalculated: false,
      formulaCount,
      missingCachedValues,
      reason:
        'Portable formula recalculation currently supports .xlsx only; use Microsoft Office background mode for macro-enabled or template workbooks.',
    };
  }
  if (Object.keys(zip.files).some((entry) => /^xl\/externalLinks\//i.test(entry))) {
    return {
      needed: true,
      available: false,
      recalculated: false,
      formulaCount,
      missingCachedValues,
      reason: 'Portable formula recalculation is blocked because LibreOffice may invalidate external workbook links.',
    };
  }
  const program = await libreOfficeProgram();
  if (!program) {
    return {
      needed: true,
      available: false,
      recalculated: false,
      formulaCount,
      missingCachedValues,
      reason: 'LibreOffice is unavailable for portable XLSX recalculation.',
    };
  }
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
    if (!result.ok) {
      return {
        needed: true,
        available: true,
        recalculated: false,
        formulaCount,
        missingCachedValues,
        reason: result.error,
      };
    }
    const generated = join(outputDir, `${basename(path, extname(path))}.xlsx`);
    const details = await stat(generated).catch(() => null);
    if (!details?.isFile() || details.size <= 0) {
      return {
        needed: true,
        available: true,
        recalculated: false,
        formulaCount,
        missingCachedValues,
        reason: 'LibreOffice produced no recalculated workbook.',
      };
    }
    const recalculated = await readFile(generated);
    await writeFile(path, recalculated);
    const errors = await workbookFormulaErrors(await JSZip.loadAsync(recalculated));
    return {
      needed: true,
      available: true,
      recalculated: true,
      backend: 'libreoffice',
      // A clean status proves the formulas evaluate, not that they are right.
      status: errors.total ? 'errors_found' : 'success',
      formulaCount,
      missingCachedValues,
      totalErrors: errors.total,
      errorSummary: errors.byType,
      ...(errors.unparsed.length ? { unparsedFormulas: errors.unparsed } : {}),
      outputBytes: details.size,
    };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
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
