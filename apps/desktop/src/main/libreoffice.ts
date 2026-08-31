// Extensions → Office: LibreOffice dependency — presence probe and guided
// install (winget / brew cask). The Office tools run without it, but document
// rendering and workbook recalculation need a real LibreOffice, so the Office
// card brings it in as part of its Install step. Desktop-only surface executed
// by the singleton daemon.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { run } from './cli-run';
import type { DesktopLibreOfficeStatus } from '../shared/contract';

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
      '/opt/homebrew/bin/soffice',
      '/usr/local/bin/soffice',
    ];
  }
  return ['soffice', 'libreoffice', '/usr/bin/soffice'];
}

async function resolveSoffice(refresh = false): Promise<{ path: string; version: string } | null> {
  if (!refresh && cached !== undefined) return cached;
  for (const candidate of sofficeCandidates()) {
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

export async function libreOfficeStatus(refresh = false): Promise<DesktopLibreOfficeStatus> {
  const soffice = await resolveSoffice(refresh);
  return soffice
    ? { installed: true, ...(soffice.version ? { version: soffice.version } : {}) }
    : { installed: false };
}

export async function installLibreOffice(): Promise<DesktopLibreOfficeStatus> {
  // The install click may race a probe that never ran (or ran before a manual
  // install), and winget treats "already installed" as a failure — so a fresh
  // probe answers first.
  const existing = await libreOfficeStatus(true);
  if (existing.installed) return existing;
  if (process.platform === 'win32') {
    const result = await run('winget', [
      'install', '--id', 'TheDocumentFoundation.LibreOffice', '--exact', '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements',
      '--disable-interactivity',
    ], INSTALL_TIMEOUT_MS);
    if (result.code === -1) {
      throw new Error('winget is unavailable. Install LibreOffice from https://www.libreoffice.org and try again.');
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).pop();
      throw new Error(`winget could not install LibreOffice: ${detail || `exit code ${result.code}`}`);
    }
  } else if (process.platform === 'darwin') {
    const result = await run('brew', ['install', '--cask', 'libreoffice'], INSTALL_TIMEOUT_MS);
    if (result.code === -1) {
      throw new Error('Homebrew is unavailable. Install LibreOffice from https://www.libreoffice.org and try again.');
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).pop();
      throw new Error(`brew could not install LibreOffice: ${detail || `exit code ${result.code}`}`);
    }
  } else {
    throw new Error('Automatic LibreOffice installation is not supported on this platform. Install LibreOffice from https://www.libreoffice.org.');
  }
  const status = await libreOfficeStatus(true);
  if (!status.installed) {
    throw new Error('LibreOffice installed, but the executable was not found yet. Restart Mixdog Desktop to pick it up.');
  }
  return status;
}
