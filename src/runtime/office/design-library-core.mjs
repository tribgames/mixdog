import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;

export const TEMPLATE_INSPECTOR_VERSION = 3;

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;

export const MAX_TEMPLATE_COUNT = 200;

export const MAX_LOCAL_TEMPLATE_COUNT = 5_000;

export const MAX_SCAN_DEPTH = 8;

export const MAX_COMPOSITION_HISTORY = 48;

export const FORMATS = new Set(['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'tsv']);

export const TEMPLATE_FORMATS = Object.freeze({
  '.docx': 'docx',
  '.dotx': 'docx',
  '.docm': 'docx',
  '.dotm': 'docx',
  '.xlsx': 'xlsx',
  '.xltx': 'xlsx',
  '.xlsm': 'xlsx',
  '.xltm': 'xlsx',
  '.pptx': 'pptx',
  '.potx': 'pptx',
  '.pptm': 'pptx',
  '.potm': 'pptx',
});

export const ALLOWED_LAYOUT_DEFAULTS = new Set([
  'background',
  'backgroundRole',
  'slideRole',
  'titleSize',
  'layout',
  'create',
  'visualPlacement',
  'density',
  'variant',
]);

export const LAYOUT_SLOT_TYPES = new Set(['text', 'image', 'chart', 'table', 'diagram']);


function physicalAsarPath(path) {
  return path.replace(/([\\/][^\\/]+\.asar)([\\/])/i, '$1.unpacked$2');
}


const BUNDLED_TEMPLATE_DIRECTORY = physicalAsarPath(
  fileURLToPath(new URL('./templates', import.meta.url)),
);


export function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}


export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}


export function safeId(value, label = 'id') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(`Office design ${label} must use 1-64 lowercase letters, digits, dots, underscores, or hyphens`);
  }
  return normalized;
}


export function canonicalPath(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}


export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}


export async function sha256File(path) {
  return sha256(await readFile(path));
}


function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}


export function canonicalOfficeDesignPack(pack) {
  return JSON.stringify(stableValue(pack));
}


export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || '',
  };
}


export function compareOfficeDesignVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Office design pack versions must be semantic versions: ${left}, ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  }
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease > b.prerelease ? 1 : -1;
}


export function libraryPaths(dataDir) {
  const root = join(resolve(dataDir), 'office', 'design-library');
  return {
    root,
    config: join(root, 'config.json'),
    state: join(root, 'state.json'),
    packs: join(root, 'packs'),
    templates: join(root, 'templates'),
    templateIndex: join(root, 'template-index.json'),
    compositionHistory: join(root, 'composition-history.json'),
    bindings: join(root, 'bindings'),
  };
}


export async function readJson(path, fallback = null) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return plainObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}


export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await rename(temporary, path);
  } catch {
    await rm(path, { force: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}


function resolveConfigPath(path, base) {
  const value = String(path || '').trim();
  if (!value) return '';
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}


export async function loadConfig(dataDir, override = null) {
  const paths = libraryPaths(dataDir);
  const configPath = resolveConfigPath(
    process.env.MIXDOG_OFFICE_DESIGN_LIBRARY_CONFIG || paths.config,
    process.cwd(),
  );
  const source = plainObject(override) ? override : await readJson(configPath, {});
  const base = dirname(configPath);
  const trustedKeys = plainObject(source.trustedKeys) ? { ...source.trustedKeys } : {};
  const environmentKey = String(process.env.MIXDOG_OFFICE_DESIGN_PACK_PUBLIC_KEY || '').replaceAll('\\n', '\n').trim();
  if (environmentKey) {
    trustedKeys[String(process.env.MIXDOG_OFFICE_DESIGN_PACK_KEY_ID || 'environment')] = environmentKey;
  }
  const environmentDirectories = String(process.env.MIXDOG_OFFICE_TEMPLATE_DIRS || '').trim();
  const hasExplicitDirectories = Array.isArray(source.templateDirectories) || Boolean(environmentDirectories);
  const configuredDirectories = Array.isArray(source.templateDirectories)
    ? source.templateDirectories
    : environmentDirectories.split(delimiter);
  const discoverInstalledTemplates = source.discoverInstalledTemplates == null
    ? !hasExplicitDirectories
    : source.discoverInstalledTemplates !== false;
  const templateDirectories = [
    paths.templates,
    ...(discoverInstalledTemplates ? defaultOfficeTemplateDirectories() : []),
    ...configuredDirectories.map((entry) => resolveConfigPath(entry, base)).filter(Boolean),
  ].filter((entry, index, values) => values.indexOf(entry) === index);
  const defaultTemplates = plainObject(source.defaultTemplates) ? { ...source.defaultTemplates } : {};
  if (discoverInstalledTemplates && !defaultTemplates.pptx) defaultTemplates.pptx = 'mixdog-executive';
  return {
    manifestUrl: String(process.env.MIXDOG_OFFICE_DESIGN_PACK_URL || source.manifestUrl || '').trim(),
    trustedKeys,
    packId: source.packId ? safeId(source.packId, 'config packId') : '',
    channel: String(source.channel || 'stable').trim().toLowerCase(),
    checkIntervalMs: Math.max(
      10_000,
      Math.min(24 * 60 * 60 * 1000, Number(source.checkIntervalMs) || DEFAULT_CHECK_INTERVAL_MS),
    ),
    templateDirectories,
    discoverInstalledTemplates,
    defaultTemplates,
  };
}


export function defaultOfficeTemplateDirectories({
  platform = process.platform,
  environment = process.env,
  home = homedir(),
} = {}) {
  const directories = [BUNDLED_TEMPLATE_DIRECTORY];
  if (platform === 'win32') {
    const programFiles = String(environment.ProgramFiles || environment.PROGRAMFILES || '').trim();
    const programFilesX86 = String(environment['ProgramFiles(x86)'] || environment.PROGRAMFILES_X86 || '').trim();
    const appData = String(environment.APPDATA || '').trim();
    for (const root of [programFiles, programFilesX86].filter(Boolean)) {
      directories.push(join(root, 'Microsoft Office', 'root', 'Templates'));
    }
    if (appData) directories.push(join(appData, 'Microsoft', 'Templates'));
    if (home) directories.push(join(home, 'Documents', 'Custom Office Templates'));
  }
  return directories
    .map((entry) => resolve(entry))
    .filter((entry, index, values) => values.indexOf(entry) === index);
}
