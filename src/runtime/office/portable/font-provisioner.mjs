import { createHash } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GlobalFonts } from '@napi-rs/canvas';

const execFileAsync = promisify(execFile);

// google/fonts commit the font URLs and sha256 digests below were taken from.
const GOOGLE_FONTS_COMMIT = '23e54b51ddffbc7713c583748e3bd86f62b1fa4a';
const GOOGLE_FONTS_RAW = `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl`;

export const NOTO_FONT_DEFINITIONS = Object.freeze([
  {
    id: 'noto-sans-latin',
    family: 'Noto Sans',
    fileName: 'NotoSans-Variable.ttf',
    registryName: 'Noto Sans (TrueType)',
    url: `${GOOGLE_FONTS_RAW}/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf`,
    bytes: 2049096,
    sha256: 'bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d',
  },
  {
    id: 'noto-sans-kr',
    family: 'Noto Sans KR',
    fileName: 'NotoSansKR-Variable.ttf',
    registryName: 'Noto Sans KR (TrueType)',
    url: `${GOOGLE_FONTS_RAW}/notosanskr/NotoSansKR%5Bwght%5D.ttf`,
    bytes: 10414588,
    sha256: '194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252',
  },
  {
    id: 'noto-sans-sc',
    family: 'Noto Sans SC',
    fileName: 'NotoSansSC-Variable.ttf',
    registryName: 'Noto Sans SC (TrueType)',
    url: `${GOOGLE_FONTS_RAW}/notosanssc/NotoSansSC%5Bwght%5D.ttf`,
    bytes: 17772300,
    sha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
  },
  {
    id: 'noto-sans-jp',
    family: 'Noto Sans JP',
    fileName: 'NotoSansJP-Variable.ttf',
    registryName: 'Noto Sans JP (TrueType)',
    url: `${GOOGLE_FONTS_RAW}/notosansjp/NotoSansJP%5Bwght%5D.ttf`,
    bytes: 9589900,
    sha256: 'c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f',
  },
  {
    id: 'noto-sans-tc',
    family: 'Noto Sans TC',
    fileName: 'NotoSansTC-Variable.ttf',
    registryName: 'Noto Sans TC (TrueType)',
    url: `${GOOGLE_FONTS_RAW}/notosanstc/NotoSansTC%5Bwght%5D.ttf`,
    bytes: 11941968,
    sha256: '864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f',
  },
  {
    id: 'noto-sans-arabic',
    family: 'Noto Sans Arabic',
    fileName: 'NotoSansArabic-Variable.ttf',
    registryName: 'Noto Sans Arabic (TrueType)',
    url: `${GOOGLE_FONTS_RAW}/notosansarabic/NotoSansArabic%5Bwdth%2Cwght%5D.ttf`,
    bytes: 844676,
    sha256: '63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e',
  },
  {
    id: 'noto-sans-devanagari',
    family: 'Noto Sans Devanagari',
    fileName: 'NotoSansDevanagari-Variable.ttf',
    registryName: 'Noto Sans Devanagari (TrueType)',
    url: `${GOOGLE_FONTS_RAW}/notosansdevanagari/NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf`,
    bytes: 641944,
    sha256: '14ec4af41f27482216d1c2229f417ff9b1425e1babb014e57d1d40d03229853e',
  },
  {
    id: 'noto-sans-thai',
    family: 'Noto Sans Thai',
    fileName: 'NotoSansThai-Variable.ttf',
    registryName: 'Noto Sans Thai (TrueType)',
    url: `${GOOGLE_FONTS_RAW}/notosansthai/NotoSansThai%5Bwdth%2Cwght%5D.ttf`,
    bytes: 218652,
    sha256: '5a1c559bb539583c8a1fd99d1c5b9491e5e14478c9cd2bd0970d5c3096cc9ef8',
  },
  {
    id: 'noto-sans-hebrew',
    family: 'Noto Sans Hebrew',
    fileName: 'NotoSansHebrew-Variable.ttf',
    registryName: 'Noto Sans Hebrew (TrueType)',
    url: `${GOOGLE_FONTS_RAW}/notosanshebrew/NotoSansHebrew%5Bwdth%2Cwght%5D.ttf`,
    bytes: 112640,
    sha256: '7ef36a2c3593758cdb622e1bdef4f84523e92fbc3ccc667438dd80ff54c2de88',
  },
  {
    id: 'noto-sans-bengali',
    family: 'Noto Sans Bengali',
    fileName: 'NotoSansBengali-Variable.ttf',
    registryName: 'Noto Sans Bengali (TrueType)',
    url: `${GOOGLE_FONTS_RAW}/notosansbengali/NotoSansBengali%5Bwdth%2Cwght%5D.ttf`,
    bytes: 463668,
    sha256: 'dcd42978094e584a849c84a51450eeac40c8826057d566ea6d4b9627a403a05a',
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

function systemFontDirectory() {
  const currentPlatform = platform();
  if (currentPlatform === 'win32') return join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  if (currentPlatform === 'darwin') return '/Library/Fonts';
  return '/usr/share/fonts';
}

export function isFontInstalled(fontDef) {
  const userPath = join(getUserFontDirectory(), fontDef.fileName);
  if (existsSync(userPath)) return { installed: true, path: userPath };
  const sysPath = join(systemFontDirectory(), fontDef.fileName);
  if (existsSync(sysPath)) return { installed: true, path: sysPath };
  return { installed: false, path: userPath };
}

// The registry name and the font path reach PowerShell as environment
// variables, never as script text: an apostrophe in the path (C:\Users\O'Brien)
// would end a quoted string and run the rest, and a single-quoted string keeps
// backslashes literally, so doubling them wrote a path that is not the file's.
export function fontRegistrationCommand(fontDef, targetPath) {
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-Command',
      "New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -Name $env:MIXDOG_FONT_NAME -Value $env:MIXDOG_FONT_PATH -PropertyType String -Force",
    ],
    env: { ...process.env, MIXDOG_FONT_NAME: fontDef.registryName, MIXDOG_FONT_PATH: targetPath },
  };
}

async function registerFontWithOs(fontDef, targetPath) {
  const currentPlatform = platform();
  if (currentPlatform === 'win32') {
    try {
      const { command, args, env } = fontRegistrationCommand(fontDef, targetPath);
      await execFileAsync(command, args, { env, timeout: 15000 });
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

function registerFontInProcess(fontPath, family) {
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

export function verifyFontBuffer(fontDef, buffer) {
  if (buffer.length !== fontDef.bytes) {
    throw new Error(`Font ${fontDef.family} size mismatch: expected ${fontDef.bytes} bytes, got ${buffer.length}`);
  }
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (digest !== fontDef.sha256) {
    throw new Error(`Font ${fontDef.family} sha256 mismatch: expected ${fontDef.sha256}, got ${digest}`);
  }
}

async function installFont(fontDef) {
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
  verifyFontBuffer(fontDef, buffer);
  await fsp.writeFile(tempPath, buffer);
  await fsp.rename(tempPath, targetPath);

  await registerFontWithOs(fontDef, targetPath);
  registerFontInProcess(targetPath, fontDef.family);

  return { installed: true, skipped: false, path: targetPath };
}

// Office for Mac keeps its faces (Calibri, Cambria, Aptos, Malgun Gothic, Yu
// Gothic, ...) inside each app bundle and never registers them with the system,
// so a Mac with Excel installed measured Calibri in a fallback face — its digit
// read 9 px where Excel lays out 7, and every fitted column came out wide. The
// apps share one copy; the first bundle found is the one Excel draws with.
const MAC_OFFICE_FONT_DIRECTORIES = Object.freeze(
  ['Microsoft Excel', 'Microsoft Word', 'Microsoft PowerPoint', 'Microsoft Outlook'].map(
    (app) => `/Applications/${app}.app/Contents/Resources/DFonts`
  )
);

/** The font folder of the installed Office for Mac, or '' elsewhere or without Office. */
export function macOfficeFontDirectory() {
  if (platform() !== 'darwin') return '';
  return MAC_OFFICE_FONT_DIRECTORIES.find((candidate) => existsSync(candidate)) || '';
}

function registerMacOfficeFonts() {
  const directory = macOfficeFontDirectory();
  if (!directory) return;
  try {
    GlobalFonts.loadFontsFromDir(directory);
  } catch {
    // non-fatal: measurement falls back to the installed faces
  }
}

export function warmupInstalledOfficeFonts() {
  registerMacOfficeFonts();
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
    : options.targets || NOTO_FONT_DEFINITIONS;

  const BATCH_SIZE = 3;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (fontDef) => {
        try {
          results[fontDef.id] = await installFont(fontDef);
        } catch (error) {
          results[fontDef.id] = { installed: false, error: error?.message || String(error) };
        }
      })
    );
  }
  return results;
}
