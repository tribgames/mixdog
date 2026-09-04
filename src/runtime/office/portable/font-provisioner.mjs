import { existsSync, promises as fsp } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GlobalFonts } from '@napi-rs/canvas';

const execFileAsync = promisify(execFile);

export const NOTO_FONT_DEFINITIONS = Object.freeze([
  {
    id: 'noto-sans-latin',
    family: 'Noto Sans',
    fileName: 'NotoSans-Variable.ttf',
    registryName: 'Noto Sans (TrueType)',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf',
    bytes: 2049096,
  },
  {
    id: 'noto-sans-kr',
    family: 'Noto Sans KR',
    fileName: 'NotoSansKR-Variable.ttf',
    registryName: 'Noto Sans KR (TrueType)',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf',
    bytes: 10414588,
  },
  {
    id: 'noto-sans-sc',
    family: 'Noto Sans SC',
    fileName: 'NotoSansSC-Variable.ttf',
    registryName: 'Noto Sans SC (TrueType)',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
    bytes: 17772300,
  },
  {
    id: 'noto-sans-jp',
    family: 'Noto Sans JP',
    fileName: 'NotoSansJP-Variable.ttf',
    registryName: 'Noto Sans JP (TrueType)',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf',
    bytes: 9589900,
  },
  {
    id: 'noto-sans-tc',
    family: 'Noto Sans TC',
    fileName: 'NotoSansTC-Variable.ttf',
    registryName: 'Noto Sans TC (TrueType)',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf',
    bytes: 11941968,
  },
  {
    id: 'noto-sans-arabic',
    family: 'Noto Sans Arabic',
    fileName: 'NotoSansArabic-Variable.ttf',
    registryName: 'Noto Sans Arabic (TrueType)',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansarabic/NotoSansArabic%5Bwdth%2Cwght%5D.ttf',
    bytes: 844676,
  },
  {
    id: 'noto-sans-devanagari',
    family: 'Noto Sans Devanagari',
    fileName: 'NotoSansDevanagari-Variable.ttf',
    registryName: 'Noto Sans Devanagari (TrueType)',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansdevanagari/NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf',
    bytes: 647144,
  },
  {
    id: 'noto-sans-thai',
    family: 'Noto Sans Thai',
    fileName: 'NotoSansThai-Variable.ttf',
    registryName: 'Noto Sans Thai (TrueType)',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansthai/NotoSansThai%5Bwdth%2Cwght%5D.ttf',
    bytes: 218652,
  },
  {
    id: 'noto-sans-hebrew',
    family: 'Noto Sans Hebrew',
    fileName: 'NotoSansHebrew-Variable.ttf',
    registryName: 'Noto Sans Hebrew (TrueType)',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanshebrew/NotoSansHebrew%5Bwdth%2Cwght%5D.ttf',
    bytes: 112640,
  },
  {
    id: 'noto-sans-bengali',
    family: 'Noto Sans Bengali',
    fileName: 'NotoSansBengali-Variable.ttf',
    registryName: 'Noto Sans Bengali (TrueType)',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansbengali/NotoSansBengali%5Bwdth%2Cwght%5D.ttf',
    bytes: 463668,
  },
]);

export function getUserFontDirectory() {
  const currentPlatform = platform();
  if (currentPlatform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'Microsoft', 'Windows', 'Fonts');
  }
  if (currentPlatform === 'darwin') {
    return join(homedir(), 'Library', 'Fonts');
  }
  return join(homedir(), '.local', 'share', 'fonts');
}

export function isFontInstalled(fontDef) {
  const userDir = getUserFontDirectory();
  const userPath = join(userDir, fontDef.fileName);
  if (existsSync(userPath)) return { installed: true, path: userPath };

  if (platform() === 'win32') {
    const sysPath = join(process.env.WINDIR || 'C:\\Windows', 'Fonts', fontDef.fileName);
    if (existsSync(sysPath)) return { installed: true, path: sysPath };
  } else if (platform() === 'darwin') {
    const sysPath = join('/Library/Fonts', fontDef.fileName);
    if (existsSync(sysPath)) return { installed: true, path: sysPath };
  } else {
    const sysPath = join('/usr/share/fonts', fontDef.fileName);
    if (existsSync(sysPath)) return { installed: true, path: sysPath };
  }

  return { installed: false, path: userPath };
}

async function registerFontWithOs(fontDef, targetPath) {
  const currentPlatform = platform();
  if (currentPlatform === 'win32') {
    try {
      const escapedPath = targetPath.replace(/\\/g, '\\\\');
      const ps = `New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -Name '${fontDef.registryName}' -Value '${escapedPath}' -PropertyType String -Force`;
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000 });
    } catch {
      // non-fatal
    }
  } else if (currentPlatform === 'linux') {
    try {
      await execFileAsync('fc-cache', ['-f', getUserFontDirectory()], { timeout: 15000 });
    } catch {
      // non-fatal
    }
  }
}

export function registerFontInProcess(fontPath, family) {
  try {
    if (existsSync(fontPath)) {
      GlobalFonts.registerFromPath(fontPath, family);
      return true;
    }
  } catch {
    // non-fatal
  }
  return false;
}

export async function installFont(fontDef, { onProgress } = {}) {
  const status = isFontInstalled(fontDef);
  if (status.installed) {
    registerFontInProcess(status.path, fontDef.family);
    return { installed: true, skipped: true, path: status.path };
  }

  const userDir = getUserFontDirectory();
  await fsp.mkdir(userDir, { recursive: true });

  const targetPath = join(userDir, fontDef.fileName);
  const tempPath = `${targetPath}.tmp-${Date.now()}`;

  const response = await fetch(fontDef.url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    throw new Error(`Failed to download font ${fontDef.family} (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(tempPath, buffer);
  await fsp.rename(tempPath, targetPath);

  await registerFontWithOs(fontDef, targetPath);
  registerFontInProcess(targetPath, fontDef.family);

  return { installed: true, skipped: false, path: targetPath };
}

export function warmupInstalledOfficeFonts() {
  for (const fontDef of NOTO_FONT_DEFINITIONS) {
    const status = isFontInstalled(fontDef);
    if (status.installed) {
      registerFontInProcess(status.path, fontDef.family);
    }
  }
}

export async function prepareOfficeFonts(options = {}) {
  const results = {};
  const targets = options.coreOnly
    ? NOTO_FONT_DEFINITIONS.filter((def) => def.id === 'noto-sans-latin' || def.id === 'noto-sans-kr')
    : (options.targets || NOTO_FONT_DEFINITIONS);

  const BATCH_SIZE = 3;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (fontDef) => {
      try {
        results[fontDef.id] = await installFont(fontDef, options);
      } catch (error) {
        results[fontDef.id] = { installed: false, error: error?.message || String(error) };
      }
    }));
  }
  return results;
}
