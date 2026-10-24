// Extensions → Office: LibreOffice dependency — presence probe and guided
// install (winget / brew cask). The Office tools run without it, but document
// rendering and workbook recalculation need a real LibreOffice, so the Office
// card brings it in as part of its Install step. Desktop-only surface executed
// by the singleton daemon.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { installWithPackageManager, run } from './cli-run';
import { packagedRuntimeSourceRoot } from './runtime-layout';
import type { DesktopLibreOfficeStatus } from '../shared/contract';

interface InstallLibreOfficeOptions {
  packaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
}

/** The Office runtime's font provisioner (Noto faces for LibreOffice renders).
 *  Resolved through the runtime layout like every other runtime module: a
 *  literal relative import would make the daemon bundle swallow the module and
 *  its native canvas binding, which esbuild cannot load. */
function fontProvisionerModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath = process.cwd()
): string {
  const modulePath = packaged
    ? join(packagedRuntimeSourceRoot(resourcesPath), 'runtime', 'office', 'portable', 'font-provisioner.mjs')
    : resolve(appPath, '../../src/runtime/office/portable/font-provisioner.mjs');
  return pathToFileURL(modulePath).href;
}

// LibreOffice is a ~350MB download; winget/brew on a slow link can outlive the
// 10-minute budget the small CLIs use.
const INSTALL_TIMEOUT_MS = 20 * 60_000;
// A cold soffice start (first run, AV scan) can sit well past the default 15s
// run budget before printing its version line.
const PROBE_TIMEOUT_MS = 20_000;

let cached: { path: string; version: string } | null | undefined;

function sofficeCandidates(): string[] {
  if (process.platform === 'win32') {
    // soffice.com is the console front-end: it reports through stdio and
    // exits. soffice.exe is a GUI launcher that may do neither.
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

let candidateSource: () => string[] = sofficeCandidates;

/** Test seam: replaces the probe's candidate list (and drops the cached answer);
 *  no argument restores the platform candidates. */
export function setLibreOfficeCandidatesForTest(candidates?: string[]): void {
  candidateSource = candidates ? () => candidates : sofficeCandidates;
  cached = undefined;
}

async function resolveSoffice(refresh = false): Promise<{ path: string; version: string } | null> {
  if (!refresh && cached !== undefined) return cached;
  for (const candidate of candidateSource()) {
    if (/[\\/]/.test(candidate) && !existsSync(candidate)) continue;
    const probe = await run(candidate, ['--version'], PROBE_TIMEOUT_MS);
    if (probe.code === 0) {
      cached = {
        path: candidate,
        version: /LibreOffice (\d[\w.]*)/.exec(probe.stdout)?.[1] || '',
      };
      return cached;
    }
  }
  cached = null;
  return null;
}

// Renderer-requested re-probes (a failed Office preview regaining focus) share
// one probe at a time: concurrent refreshes join the probe already running.
let refreshing: Promise<unknown> | null = null;

async function statusOf(refresh: boolean): Promise<DesktopLibreOfficeStatus> {
  const soffice = await resolveSoffice(refresh);
  if (!soffice) return { installed: false };
  return { installed: true, ...(soffice.version ? { version: soffice.version } : {}) };
}

/** Cached answer; `refresh` first re-probes the backend (concurrent refreshes share one probe) so an install done outside Mixdog is seen. */
export async function libreOfficeStatus(refresh = false): Promise<DesktopLibreOfficeStatus> {
  if (refresh) {
    refreshing ??= resolveSoffice(true).finally(() => {
      refreshing = null;
    });
    await refreshing;
  }
  return statusOf(false);
}

export async function installLibreOffice({
  packaged,
  resourcesPath,
  appPath,
}: InstallLibreOfficeOptions = {}): Promise<DesktopLibreOfficeStatus> {
  // The install click may race a probe that never ran (or ran before a manual
  // install), and winget treats "already installed" as a failure — so a fresh
  // probe answers first.
  const existing = await statusOf(true);
  if (existing.installed) return existing;
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
    throw new Error(
      'LibreOffice installed, but the executable was not found yet. Restart Mixdog Desktop to pick it up.'
    );
  }
  try {
    // The Noto faces LibreOffice renders with come in alongside it; a missing
    // or offline provisioner never fails the install itself.
    const provisioner = (await import(
      /* @vite-ignore */ fontProvisionerModuleUrl(packaged, resourcesPath, appPath)
    )) as { prepareOfficeFonts(): Promise<unknown> };
    await provisioner.prepareOfficeFonts();
  } catch {
    // Non-fatal: fonts can be prepared on the next Office render.
  }
  return status;
}
