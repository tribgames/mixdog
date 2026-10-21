// Installed font families for Settings → Appearance (the font comboboxes).
// One OS listing per process, cached: Windows asks .NET's
// InstalledFontCollection (the same family names DirectWrite matches), macOS
// asks NSFontManager through JXA, Linux asks fontconfig. Any failure answers
// an empty list and the renderer keeps free-text entry.
import { execFile } from 'node:child_process';

const LIST_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const NAME_MAX = 100;

const COMMANDS: Partial<Record<NodeJS.Platform, { file: string; args: string[] }>> = {
  win32: {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; ' +
        '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }',
    ],
  },
  darwin: {
    file: 'osascript',
    args: [
      '-l',
      'JavaScript',
      '-e',
      "ObjC.import('AppKit'); $.NSFontManager.sharedFontManager.availableFontFamilies.js.map((f) => f.js).join('\\n')",
    ],
  },
  linux: { file: 'fc-list', args: ['--format=%{family}\\n'] },
};

/** Family names from a listing: one per line (fontconfig joins a family's
    localized names with commas), trimmed, de-duplicated and sorted; hidden
    system faces (a leading dot) are dropped. */
export function parseFontFamilies(platform: NodeJS.Platform, stdout: string): string[] {
  const names = stdout
    .split(/\r?\n/)
    .flatMap((line) => (platform === 'linux' ? line.split(',') : [line]))
    .map((name) => name.trim())
    .filter((name) => name && name.length <= NAME_MAX && !name.startsWith('.'));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

let cached: Promise<string[]> | null = null;

export function listSystemFonts(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  cached ??= new Promise((resolve) => {
    const command = COMMANDS[platform];
    if (!command) {
      resolve([]);
      return;
    }
    execFile(
      command.file,
      command.args,
      { timeout: LIST_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => resolve(error ? [] : parseFontFamilies(platform, stdout))
    );
  });
  return cached;
}
