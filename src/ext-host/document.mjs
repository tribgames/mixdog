// Document previews and the LibreOffice dependency, served by the extension host: the work of the
// desktop's `document-preview.ts` and `libreoffice.ts`, which lived in Electron main. The
// conversion and rasterizing themselves are the runtime's `office/pdf/document-preview.mjs`.
//
// Failures carry a stable `code` (the core maps it to the domain's coded error); the message stays
// the one Node showed.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isInside } from './path-scope.mjs';
import { scrubRuntimeRootVars } from '../runtime/agent/orchestrator/tools/env-scrub.mjs';

const coded = (code, message) => Object.assign(new Error(message), { code });

// ---- project-relative paths ---------------------------------------------------------------------

const comparable = (path) => (process.platform === 'win32' ? path.toLocaleLowerCase() : path);

function isWithinRoot(root, path) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function canonicalThroughExistingAncestor(path) {
  let existing = path;
  const missing = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

/** Traversal- and symlink-guarded absolute path for a project-relative entry. */
function projectEntryPathIn(root, relPath) {
  const absoluteRoot = resolve(root);
  const rel = String(relPath || '').replace(/\\/g, '/');
  const target = resolve(absoluteRoot, rel);
  if (!isWithinRoot(absoluteRoot, target)) throw coded('path_outside_project', 'Path is outside the project.');
  const canonicalRoot = realpathSync(absoluteRoot);
  const canonicalTarget = canonicalThroughExistingAncestor(target);
  if (!isWithinRoot(comparable(canonicalRoot), comparable(canonicalTarget))) {
    throw coded('path_outside_project', 'Path resolves outside the project.');
  }
  return target;
}

// ---- requests ---------------------------------------------------------------------------------

// A viewer asks for the pages it is about to show. The ceiling keeps one call bounded in time (each
// page is a rasterization) and in payload, because a remote surface carries these images inside a
// single reply.
const MAX_PAGES_PER_CALL = 4;
const MIN_PAGE_WIDTH = 320;
// Wide enough for a 400% zoom on a high-DPI panel to stay crisp.
const MAX_PAGE_WIDTH = 2400;
const DEFAULT_PAGE_WIDTH = 1200;

function requestedPages(value) {
  const raw = Array.isArray(value) ? value : [1];
  const pages = [...new Set(raw.map((page) => Math.trunc(Number(page))))].filter(
    (page) => Number.isInteger(page) && page >= 1
  );
  if (!pages.length) throw coded('invalid_params', 'A document preview needs at least one page.');
  if (pages.length > MAX_PAGES_PER_CALL) {
    throw coded('invalid_params', `A document preview accepts at most ${MAX_PAGES_PER_CALL} pages per request.`);
  }
  return pages.sort((left, right) => left - right);
}

function requestedWidth(value) {
  const width = Math.trunc(Number(value));
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_PAGE_WIDTH;
  return Math.min(MAX_PAGE_WIDTH, Math.max(MIN_PAGE_WIDTH, width));
}

// An Office password is at most 255 characters ([MS-OFFCRYPTO] 2.3.4). It is handed to the
// conversion for this request only, never kept or echoed.
const MAX_PASSWORD_LENGTH = 255;

function requestedPassword(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > MAX_PASSWORD_LENGTH) {
    throw coded('invalid_params', `A document password must be text of at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  return value;
}

// A document opened with its password lives in THIS process's memory (document-preview.mjs), so the
// threads that used one stay on this worker for as long as it runs.
const unlockedThreads = new Set();

async function runtime() {
  return await import('../runtime/office/pdf/document-preview.mjs');
}

/** The project root must be inside the paths the core approved for this call. */
function assertApprovedRoot(ctx, root) {
  if (!isAbsolute(root)) throw coded('path_not_approved', `project root must be absolute: ${root}`);
  const real = realpathSync(resolve(root));
  const covered = ctx.paths.some((approved) => isInside(realpathSync(resolve(approved)), real));
  if (!covered) throw coded('path_not_approved', `path is not approved for this call: ${root}`);
}

async function convert(ctx, root, relPath, password = '') {
  assertApprovedRoot(ctx, String(root || ''));
  const file = projectEntryPathIn(String(root || ''), String(relPath || ''));
  // A PDF needs no conversion: it is rasterized in place, so the editor can show it with the same
  // page viewer as converted documents.
  if (/\.pdf$/i.test(file)) {
    const info = await stat(file);
    if (!info.isFile()) throw coded('not_a_file', 'Not a file.');
    return { path: file, format: 'pdf', mtimeMs: info.mtimeMs, size: info.size, cached: true };
  }
  const office = await runtime();
  if (!office.documentPreviewFormat(file)) {
    throw coded('no_preview_for_type', 'This file type has no built-in document preview.');
  }
  const cacheRoot = String(ctx.params.cacheRoot || '');
  return await office.documentPreviewPdf(file, password ? { cacheRoot, password, signal: ctx.signal } : { cacheRoot, signal: ctx.signal });
}

async function preview(ctx) {
  const { root, rel } = ctx.params;
  return { value: await convert(ctx, root, rel), pin: unlockedThreads.has(ctx.thread) };
}

async function previewPages(ctx) {
  const { root, rel, options = {} } = ctx.params;
  const pages = requestedPages(options.pages);
  const maxWidth = requestedWidth(options.maxWidth);
  const password = requestedPassword(options.password);
  if (password) unlockedThreads.add(ctx.thread);
  const cacheRoot = String(ctx.params.cacheRoot || '');
  let pdf = await convert(ctx, root, rel, password);
  const office = await runtime();
  let rendered = await office.documentPreviewPages(pdf.path, { pages, maxWidth, cacheRoot, signal: ctx.signal });
  // The PDF is mutable: if it changed while rasterizing, the pixels may belong to either revision.
  // Re-render once against the new one and report that revision so the renderer's binding resets.
  const after = await stat(pdf.path);
  if (after.mtimeMs !== pdf.mtimeMs || after.size !== pdf.size) {
    pdf = { ...pdf, mtimeMs: after.mtimeMs, size: after.size };
    rendered = await office.documentPreviewPages(pdf.path, { pages, maxWidth, cacheRoot, signal: ctx.signal });
    const settled = await stat(pdf.path);
    pdf = { ...pdf, mtimeMs: settled.mtimeMs, size: settled.size };
  }
  return {
    value: { format: pdf.format, mtimeMs: pdf.mtimeMs, size: pdf.size, pageCount: rendered.pageCount, pages: rendered.pages },
    pin: unlockedThreads.has(ctx.thread),
  };
}

// ---- LibreOffice ------------------------------------------------------------------------------

// LibreOffice is a ~350MB download; winget/brew on a slow link can outlive the 10-minute budget the
// small CLIs use.
const INSTALL_TIMEOUT_MS = 20 * 60_000;
// A cold soffice start (first run, AV scan) can sit well past the default 15s run budget before
// printing its version line.
const PROBE_TIMEOUT_MS = 20_000;

let cached;

function sofficeCandidates() {
  if (process.platform === 'win32') {
    // soffice.com is the console front-end: it reports through stdio and exits. soffice.exe is a
    // GUI launcher that may do neither.
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    return [
      'soffice.com',
      join(programFiles, 'LibreOffice', 'program', 'soffice.com'),
      join(programFilesX86, 'LibreOffice', 'program', 'soffice.com'),
      ...(localAppData ? [join(localAppData, 'Programs', 'LibreOffice', 'program', 'soffice.com')] : []),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      'soffice',
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      join(homedir(), 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'),
      '/opt/homebrew/bin/soffice',
      '/usr/local/bin/soffice',
    ];
  }
  return [
    'soffice',
    'libreoffice',
    '/usr/lib/libreoffice/program/soffice',
    '/snap/bin/libreoffice',
    '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice',
    join(homedir(), '.local', 'share', 'flatpak', 'exports', 'bin', 'org.libreoffice.LibreOffice'),
  ];
}

let candidateSource = sofficeCandidates;

/** Test seam: replaces the probe's candidate list (and drops the cached answer); no argument
 *  restores the platform candidates. */
export function setLibreOfficeCandidatesForTest(candidates) {
  candidateSource = candidates ? () => candidates : sofficeCandidates;
  cached = undefined;
}

/** The daemon's child environment: host identity never leaks into the probed or installed program. */
function childEnvironment() {
  const env = { ...process.env };
  scrubRuntimeRootVars(env);
  return env;
}

/** A bounded child run; ENOENT is flattened to code -1 so a missing binary reads apart from a
 *  failing one. */
function run(file, args, timeout = 15_000) {
  return new Promise((done) => {
    execFile(file, args, { timeout, windowsHide: true, env: childEnvironment() }, (error, stdout, stderr) => {
      if (!error) {
        done({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
        return;
      }
      if (error.code === 'ENOENT') {
        done({ code: -1, stdout: '', stderr: 'ENOENT' });
        return;
      }
      done({
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: String(stdout || ''),
        stderr: String(stderr || '') || error.message,
      });
    });
  });
}

async function resolveSoffice(refresh = false) {
  if (!refresh && cached !== undefined) return cached;
  for (const candidate of candidateSource()) {
    if (/[\\/]/.test(candidate) && !existsSync(candidate)) continue;
    const probe = await run(candidate, ['--version'], PROBE_TIMEOUT_MS);
    if (probe.code === 0) {
      cached = { path: candidate, version: /LibreOffice (\d[\w.]*)/.exec(probe.stdout)?.[1] || '' };
      return cached;
    }
  }
  cached = null;
  return null;
}

// Re-probes (a failed Office preview regaining focus) share one probe at a time: concurrent
// refreshes join the probe already running.
let refreshing = null;

async function statusOf(refresh) {
  const soffice = await resolveSoffice(refresh);
  if (!soffice) return { installed: false };
  return { installed: true, ...(soffice.version ? { version: soffice.version } : {}) };
}

/** Cached answer; `refresh` first re-probes so an install done outside Mixdog is seen. */
async function libreOfficeStatus(ctx) {
  if (ctx.params?.refresh === true) {
    refreshing ??= resolveSoffice(true).finally(() => {
      refreshing = null;
    });
    await refreshing;
  }
  return { value: await statusOf(false) };
}

/** Guided install of one dependency: winget on Windows, brew on macOS; every other platform throws
 *  `unsupported`. Rejects with the manager's last output line when it fails. */
async function installWithPackageManager(spec) {
  let manager;
  let managerName;
  let result;
  if (process.platform === 'win32') {
    manager = 'winget';
    managerName = 'winget';
    result = await run(
      'winget',
      [
        'install',
        '--id',
        spec.wingetId,
        '--exact',
        '--source',
        'winget',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
      ],
      spec.timeoutMs
    );
  } else if (process.platform === 'darwin') {
    manager = 'brew';
    managerName = 'Homebrew';
    result = await run('brew', spec.brewArgs, spec.timeoutMs);
  } else {
    throw coded('install_unsupported', spec.unsupported);
  }
  if (result.code === -1) {
    throw coded('package_manager_unavailable', `${managerName} is unavailable. Install ${spec.label} from ${spec.homepage} and try again.`);
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).pop();
    throw coded('install_failed', `${manager} could not install ${spec.label}: ${detail || `exit code ${result.code}`}`);
  }
}

async function installLibreOffice() {
  // The install click may race a probe that never ran (or ran before a manual install), and winget
  // treats "already installed" as a failure, so a fresh probe answers first.
  const existing = await statusOf(true);
  if (existing.installed) return { value: existing };
  await installWithPackageManager({
    label: 'LibreOffice',
    homepage: 'https://www.libreoffice.org',
    wingetId: 'TheDocumentFoundation.LibreOffice',
    brewArgs: ['install', '--cask', 'libreoffice'],
    timeoutMs: INSTALL_TIMEOUT_MS,
    unsupported:
      'Automatic LibreOffice installation is not supported on Linux. Install it with your package manager ' +
      '(for example `sudo apt install libreoffice` or `sudo dnf install libreoffice`) or from https://www.libreoffice.org.',
  });
  const status = await statusOf(true);
  if (!status.installed) {
    throw coded(
      'executable_not_found',
      'LibreOffice installed, but the executable was not found yet. Restart Mixdog Desktop to pick it up.'
    );
  }
  try {
    // The Noto faces LibreOffice renders with come in alongside it; a missing or offline
    // provisioner never fails the install itself.
    const provisioner = await import('../runtime/office/portable/font-provisioner.mjs');
    await provisioner.prepareOfficeFonts();
  } catch {
    // Non-fatal: fonts can be prepared on the next Office render.
  }
  return { value: status };
}

export const documentHandlers = {
  'document.preview': preview,
  'document.previewPages': previewPages,
  'document.libreOfficeStatus': libreOfficeStatus,
  'document.installLibreOffice': installLibreOffice,
};
