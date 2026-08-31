import { basename, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { readFile, writeFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { zipText } from './portable-opc.mjs';

const SOFFICE_PROBE_TIMEOUT_MS = 20_000;
const SOFFICE_RENDER_TIMEOUT_MS = 120_000;

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
      try { child.kill(); } catch {}
      finish(false);
    }, SOFFICE_PROBE_TIMEOUT_MS);
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}


// Headless conversion must never attach to the user's own running LibreOffice:
// a shared profile makes the second invocation either fail or block until the
// desktop window closes. Every run gets a throwaway profile of its own.
function sofficeArgs(profileDir, args) {
  return [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--headless',
    '--norestore',
    ...args,
  ];
}


async function libreOfficeProgram() {
  const candidates = process.platform === 'win32'
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


export async function recalculateLibreOfficeWorkbook(path, {
  force = false,
  signal = null,
} = {}) {
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
      reason: 'Portable formula recalculation currently supports .xlsx only; use Microsoft Office background mode for macro-enabled or template workbooks.',
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
  let timeout;
  try {
    const result = await new Promise((resolve) => {
      let settled = false;
      const child = spawn(program, sofficeArgs(join(root, 'profile'), ['--convert-to', 'xlsx', '--outdir', outputDir, input]), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => {
        try { child.kill(); } catch {}
        finish({ recalculated: false, error: 'Portable XLSX recalculation was cancelled' });
      };
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => finish({ recalculated: false, error: error?.message || String(error) }));
      child.once('close', (code) => finish(code === 0
        ? { recalculated: true }
        : { recalculated: false, error: stderr.trim() || `LibreOffice exited with code ${code}` }));
      timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({ recalculated: false, error: 'Portable XLSX recalculation timed out after 60 seconds' });
      }, 60_000);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
    });
    if (!result.recalculated) {
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
    await writeFile(path, await readFile(generated));
    return {
      needed: true,
      available: true,
      recalculated: true,
      backend: 'libreoffice',
      formulaCount,
      missingCachedValues,
      outputBytes: details.size,
    };
  } finally {
    clearTimeout(timeout);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}


export async function validateLibreOfficeReopen(path) {
  const program = await libreOfficeProgram();
  if (!program) return { available: false, opened: false, backend: 'libreoffice' };
  const outputDir = await mkdtemp(join(tmpdir(), 'mixdog-office-libreoffice-'));
  let timeout;
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(program, sofficeArgs(join(outputDir, 'profile'), ['--convert-to', 'pdf', '--outdir', outputDir, path]), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const finish = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({ opened: false, error: 'LibreOffice reopen timed out after 60 seconds' });
      }, 60_000);
      child.once('error', (error) => finish({ opened: false, error: error?.message || String(error) }));
      child.once('close', (code) => finish(code === 0
        ? { opened: true }
        : { opened: false, error: stderr.trim() || `LibreOffice exited with code ${code}` }));
    });
    const output = join(outputDir, `${basename(path, extname(path))}.pdf`);
    if (result.opened) {
      const details = await stat(output).catch(() => null);
      if (!details?.isFile() || details.size <= 0) return { available: true, opened: false, backend: 'libreoffice', error: 'LibreOffice produced no review PDF' };
      return { available: true, opened: true, backend: 'libreoffice', outputBytes: details.size };
    }
    return { available: true, backend: 'libreoffice', ...result };
  } finally {
    clearTimeout(timeout);
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}


export async function renderPortableOoxml(path, output, { signal = null } = {}) {
  const program = await libreOfficeProgram();
  if (!program) {
    throw new Error('Portable Office rendering requires LibreOffice; install LibreOffice or open the document in background mode to render through Microsoft Office');
  }
  const outputDir = dirname(output);
  const profileDir = await mkdtemp(join(tmpdir(), 'mixdog-office-render-'));
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(program, sofficeArgs(profileDir, ['--convert-to', 'pdf', '--outdir', outputDir, path]), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      let settled = false;
      const finish = (operation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort', onAbort);
        operation();
      };
      const onAbort = () => {
        try { child.kill(); } catch {}
        finish(() => reject(new Error('Office rendering was cancelled')));
      };
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => finish(() => reject(error)));
      child.on('close', (code) => finish(() => (
        code === 0 ? resolve() : reject(new Error(stderr.trim() || `LibreOffice exited with code ${code}`))
      )));
      timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(() => reject(new Error(`LibreOffice rendering timed out after ${SOFFICE_RENDER_TIMEOUT_MS / 1000} seconds`)));
      }, SOFFICE_RENDER_TIMEOUT_MS);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  } finally {
    clearTimeout(timeout);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
  const generated = join(outputDir, `${basename(path, extname(path))}.pdf`);
  if (generated !== output) {
    const { rename } = await import('node:fs/promises');
    await rename(generated, output);
  }
  return output;
}
