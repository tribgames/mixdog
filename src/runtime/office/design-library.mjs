import {
  createHash,
  createPublicKey,
  randomUUID,
  verify,
} from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { delimiter } from 'node:path';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const SCHEMA_VERSION = 1;
const TEMPLATE_INSPECTOR_VERSION = 3;
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;
const MAX_TEMPLATE_COUNT = 200;
const MAX_LOCAL_TEMPLATE_COUNT = 5_000;
const MAX_SCAN_DEPTH = 8;
const MAX_COMPOSITION_HISTORY = 48;
const FORMATS = new Set(['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'tsv']);
const TEMPLATE_FORMATS = Object.freeze({
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
const ALLOWED_LAYOUT_DEFAULTS = new Set([
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
const LAYOUT_SLOT_TYPES = new Set(['text', 'image', 'chart', 'table', 'diagram']);

function physicalAsarPath(path) {
  return path.replace(/([\\/][^\\/]+\.asar)([\\/])/i, '$1.unpacked$2');
}

const BUNDLED_TEMPLATE_DIRECTORY = physicalAsarPath(
  fileURLToPath(new URL('./templates', import.meta.url)),
);

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function safeId(value, label = 'id') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(`Office design ${label} must use 1-64 lowercase letters, digits, dots, underscores, or hyphens`);
  }
  return normalized;
}

function canonicalPath(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(path) {
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

function parseVersion(value) {
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

function libraryPaths(dataDir) {
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

async function readJson(path, fallback = null) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return plainObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
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

async function loadConfig(dataDir, override = null) {
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

function normalizeProfiles(value) {
  if (!plainObject(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error('Office design pack has too many profiles');
  return Object.fromEntries(entries.map(([id, profile]) => {
    const normalizedId = safeId(id, 'profile id');
    if (!plainObject(profile)) throw new Error(`Office design profile ${normalizedId} must be an object`);
    if (JSON.stringify(profile).length > 64 * 1024) throw new Error(`Office design profile ${normalizedId} is too large`);
    if (profile.extends) safeId(profile.extends, 'profile extends');
    for (const format of Object.keys(profile.formats || {})) {
      if (!FORMATS.has(format)) throw new Error(`Office design profile ${normalizedId} has unsupported format ${format}`);
    }
    return [normalizedId, clone(profile)];
  }));
}

function normalizeLayoutSlots(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error('Office design layout slots must be an array of at most 128 entries');
  }
  return value.map((slot) => {
    if (!plainObject(slot)) throw new Error('Office design layout slots must be objects');
    const role = safeId(slot.role, 'layout slot role');
    const type = String(slot.type || 'text').trim().toLowerCase();
    if (!LAYOUT_SLOT_TYPES.has(type)) throw new Error(`Office design layout slot ${role} has unsupported type ${type}`);
    const shape = Number(slot.shape);
    if (!Number.isInteger(shape) || shape < 1) throw new Error(`Office design layout slot ${role} requires a positive shape index`);
    return {
      role,
      type,
      shape,
      ...(slot.placeholderType ? { placeholderType: String(slot.placeholderType) } : {}),
      ...(Number.isInteger(Number(slot.placeholderIndex)) ? { placeholderIndex: Number(slot.placeholderIndex) } : {}),
      ...(plainObject(slot.geometry) ? { geometry: clone(slot.geometry) } : {}),
      required: slot.required === true,
    };
  });
}

function normalizeLayoutCapacity(value) {
  if (!plainObject(value)) return {};
  const bounded = (name, maximum = 1_000_000_000) => {
    const number = Number(value[name]);
    return Number.isFinite(number) && number >= 0 ? Math.min(maximum, number) : 0;
  };
  return {
    sampleTextChars: bounded('sampleTextChars', 1_000_000),
    shapeCount: bounded('shapeCount', 10_000),
    textSlots: bounded('textSlots', 1_000),
    metricGroups: bounded('metricGroups', 100),
    columnGroups: bounded('columnGroups', 100),
    stepGroups: bounded('stepGroups', 100),
    textArea: bounded('textArea'),
  };
}

function normalizeDesignTags(value, limit = 16) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean))].slice(0, limit);
}

function normalizeLayouts(value, { templatePath = '' } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 1_000) throw new Error('Office design layouts must be an array of at most 1000 entries');
  return value.map((layout) => {
    if (!plainObject(layout)) throw new Error('Office design layout entries must be objects');
    const id = safeId(layout.id, 'layout id');
    const format = String(layout.format || 'pptx').toLowerCase();
    if (!FORMATS.has(format)) throw new Error(`Office design layout ${id} has unsupported format ${format}`);
    const kind = String(layout.kind || '').trim().toLowerCase();
    if (!kind) throw new Error(`Office design layout ${id} requires kind`);
    const defaults = plainObject(layout.defaults) ? clone(layout.defaults) : {};
    const unknownDefaults = Object.keys(defaults).filter((key) => !ALLOWED_LAYOUT_DEFAULTS.has(key));
    if (unknownDefaults.length) {
      throw new Error(`Office design layout ${id} has unsupported default(s): ${unknownDefaults.join(', ')}`);
    }
    const sourceSlide = Number(layout.sourceSlide || 0);
    if (sourceSlide && (!Number.isInteger(sourceSlide) || sourceSlide < 1)) {
      throw new Error(`Office design layout ${id} has invalid sourceSlide`);
    }
    const sourceLayout = Number(layout.sourceLayout || 0);
    if (sourceLayout && (!Number.isInteger(sourceLayout) || sourceLayout < 1)) {
      throw new Error(`Office design layout ${id} has invalid sourceLayout`);
    }
    return {
      id,
      format,
      kind,
      profile: layout.profile ? safeId(layout.profile, 'layout profile') : '',
      density: String(layout.density || '').toLowerCase(),
      variant: String(layout.variant || '').trim().toLowerCase(),
      purposes: normalizeDesignTags(layout.purposes),
      expressionModes: normalizeDesignTags(layout.expressionModes),
      templateId: layout.templateId ? safeId(layout.templateId, 'layout templateId') : '',
      templatePath: templatePath || String(layout.templatePath || ''),
      sourceSlide,
      sourceLayout,
      slots: normalizeLayoutSlots(layout.slots),
      capacity: normalizeLayoutCapacity(layout.capacity),
      capabilities: [...new Set((Array.isArray(layout.capabilities) ? layout.capabilities : [])
        .map((entry) => String(entry || '').trim().toLowerCase())
        .filter(Boolean))].slice(0, 32),
      priority: Math.max(-100, Math.min(100, Number(layout.priority) || 0)),
      strict: layout.strict === true,
      defaults,
    };
  });
}

function normalizeLocalSamples(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error('Office local template samples must be an array of at most 1000 entries');
  }
  return value.map((sample) => {
    if (!plainObject(sample)) throw new Error('Office local template samples must be objects');
    const slide = Number(sample.slide);
    if (!Number.isInteger(slide) || slide < 1) {
      throw new Error('Office local template sample requires a positive slide number');
    }
    const roles = plainObject(sample.roles)
      ? Object.fromEntries(Object.entries(sample.roles).map(([shape, role]) => {
          const shapeIndex = Number(shape);
          if (!Number.isInteger(shapeIndex) || shapeIndex < 1) {
            throw new Error(`Office local template sample ${slide} has an invalid shape index`);
          }
          return [shapeIndex, safeId(role, `sample ${slide} slot role`)];
        }))
      : {};
    const defaults = plainObject(sample.defaults) ? clone(sample.defaults) : {};
    const unknownDefaults = Object.keys(defaults).filter((key) => !ALLOWED_LAYOUT_DEFAULTS.has(key));
    if (unknownDefaults.length) {
      throw new Error(`Office local template sample ${slide} has unsupported default(s): ${unknownDefaults.join(', ')}`);
    }
    return {
      slide,
      id: sample.id ? safeId(sample.id, `sample ${slide} layout id`) : '',
      kind: String(sample.kind || '').trim().toLowerCase(),
      density: String(sample.density || '').trim().toLowerCase(),
      variant: String(sample.variant || '').trim().toLowerCase(),
      purposes: normalizeDesignTags(sample.purposes),
      expressionModes: normalizeDesignTags(sample.expressionModes),
      priority: Math.max(-100, Math.min(100, Number(sample.priority) || 0)),
      strict: sample.strict === true,
      roles,
      capacity: normalizeLayoutCapacity(sample.capacity),
      defaults,
    };
  });
}

function normalizeRemoteTemplates(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_TEMPLATE_COUNT) {
    throw new Error(`Office design pack templates must be an array of at most ${MAX_TEMPLATE_COUNT} entries`);
  }
  const ids = new Set();
  return value.map((template) => {
    if (!plainObject(template)) throw new Error('Office design template entries must be objects');
    const id = safeId(template.id, 'template id');
    if (ids.has(id)) throw new Error(`Office design pack contains duplicate template id ${id}`);
    ids.add(id);
    const format = String(template.format || '').toLowerCase();
    if (!['docx', 'xlsx', 'pptx'].includes(format)) {
      throw new Error(`Office design template ${id} has unsupported format ${format}`);
    }
    const url = new URL(String(template.url || ''));
    if (url.protocol !== 'https:') throw new Error(`Office design template ${id} requires an HTTPS URL`);
    const digest = String(template.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Office design template ${id} requires sha256`);
    const bytes = Number(template.bytes);
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_TEMPLATE_BYTES) {
      throw new Error(`Office design template ${id} has an invalid byte size`);
    }
    const extension = extname(url.pathname).toLowerCase();
    if (TEMPLATE_FORMATS[extension] !== format) {
      throw new Error(`Office design template ${id} URL extension does not match ${format}`);
    }
    return {
      id,
      label: String(template.label || id),
      format,
      url: url.href,
      sha256: digest,
      bytes,
      extension,
      layouts: normalizeLayouts(template.layouts || []),
    };
  });
}

function normalizePack(value) {
  if (!plainObject(value)) throw new Error('Office design pack payload must be an object');
  const id = safeId(value.id, 'pack id');
  const version = String(value.version || '').trim();
  if (!parseVersion(version)) throw new Error(`Office design pack ${id} has invalid semantic version ${version}`);
  const channel = String(value.channel || 'stable').trim().toLowerCase();
  const defaultProfiles = plainObject(value.defaultProfiles) ? { ...value.defaultProfiles } : {};
  for (const [format, profile] of Object.entries(defaultProfiles)) {
    if (!FORMATS.has(format)) throw new Error(`Office design pack ${id} has unsupported default format ${format}`);
    defaultProfiles[format] = safeId(profile, 'default profile');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    version,
    channel,
    publishedAt: String(value.publishedAt || ''),
    profiles: normalizeProfiles(value.profiles),
    defaultProfiles,
    layouts: normalizeLayouts(value.layouts || []),
    templates: normalizeRemoteTemplates(value.templates || []),
  };
}

export function verifyOfficeDesignPackEnvelope(envelope, trustedKeys = {}) {
  if (!plainObject(envelope) || Number(envelope.schemaVersion) !== SCHEMA_VERSION) {
    throw new Error(`Office design pack envelope requires schemaVersion ${SCHEMA_VERSION}`);
  }
  const keyId = safeId(envelope.keyId, 'signing key id');
  const publicKeyValue = trustedKeys[keyId];
  if (!publicKeyValue) throw new Error(`Office design pack signing key is not trusted: ${keyId}`);
  const signature = Buffer.from(String(envelope.signature || ''), 'base64');
  if (signature.length !== 64) throw new Error('Office design pack signature is invalid');
  const publicKey = createPublicKey(publicKeyValue);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Office design pack signing key ${keyId} must be Ed25519`);
  }
  const valid = verify(
    null,
    Buffer.from(canonicalOfficeDesignPack(envelope.pack)),
    publicKey,
    signature,
  );
  if (!valid) throw new Error('Office design pack signature verification failed');
  return {
    keyId,
    pack: normalizePack(envelope.pack),
    envelope: clone(envelope),
  };
}

async function responseBytes(response, maximum, label) {
  if (!response?.ok) throw new Error(`${label} download failed with HTTP ${response?.status || 0}`);
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > maximum) throw new Error(`${label} exceeds the download size limit`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximum) throw new Error(`${label} exceeds the download size limit`);
  return bytes;
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener?.('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.('abort', abort);
  }
}

function cachedPackRoot(paths, id, version) {
  return join(paths.packs, safeId(id, 'pack id'), String(version));
}

async function materializePack(envelope, verified, paths, fetchImpl, signal) {
  const target = cachedPackRoot(paths, verified.pack.id, verified.pack.version);
  const staging = join(paths.packs, `.staging-${randomUUID()}`);
  await mkdir(join(staging, 'templates'), { recursive: true });
  try {
    for (const template of verified.pack.templates) {
      const response = await fetchWithTimeout(fetchImpl, template.url, { signal }, 30_000);
      const bytes = await responseBytes(response, template.bytes, `Office design template ${template.id}`);
      if (bytes.length !== template.bytes) {
        throw new Error(`Office design template ${template.id} size mismatch`);
      }
      const digest = sha256(bytes);
      if (digest !== template.sha256) {
        throw new Error(`Office design template ${template.id} sha256 mismatch`);
      }
      await writeFile(join(staging, 'templates', `${template.id}${template.extension}`), bytes, { mode: 0o600 });
    }
    await writeJsonAtomic(join(staging, 'envelope.json'), envelope);
    await mkdir(dirname(target), { recursive: true });
    const backup = `${target}.previous-${randomUUID()}`;
    let movedExisting = false;
    try {
      await rename(target, backup);
      movedExisting = true;
    } catch {}
    try {
      await rename(staging, target);
      if (movedExisting) await rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (movedExisting) await rename(backup, target).catch(() => {});
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  return target;
}

async function loadCachedPack(paths, config, id, version) {
  if (!id || !version) return null;
  const root = cachedPackRoot(paths, id, version);
  const envelope = await readJson(join(root, 'envelope.json'));
  if (!envelope) return null;
  const verified = verifyOfficeDesignPackEnvelope(envelope, config.trustedKeys);
  const templates = [];
  for (const template of verified.pack.templates) {
    const path = join(root, 'templates', `${template.id}${template.extension}`);
    const details = await stat(path).catch(() => null);
    if (!details?.isFile() || details.size !== template.bytes || await sha256File(path) !== template.sha256) {
      throw new Error(`Cached Office design template ${template.id} failed integrity validation`);
    }
    templates.push({
      ...template,
      path,
      source: 'remote-pack',
      version: verified.pack.version,
      layouts: template.layouts.map((layout) => ({
        ...layout,
        templateId: layout.templateId || template.id,
        templatePath: path,
      })),
    });
  }
  return {
    ...verified.pack,
    keyId: verified.keyId,
    templates,
    source: 'remote-pack',
  };
}

function packSummary(pack) {
  return pack ? {
    id: pack.id,
    version: pack.version,
    channel: pack.channel,
    keyId: pack.keyId,
    profiles: Object.keys(pack.profiles || {}),
    layouts: pack.layouts?.length || 0,
    templates: pack.templates?.length || 0,
  } : null;
}

async function walkTemplateDirectory(root, output, depth = 0) {
  if (depth > MAX_SCAN_DEPTH || output.length >= MAX_LOCAL_TEMPLATE_COUNT) return;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (output.length >= MAX_LOCAL_TEMPLATE_COUNT) break;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walkTemplateDirectory(path, output, depth + 1);
    else if (
      entry.isFile()
      && !/\.mixdog-edit\.[^.]+$/i.test(entry.name)
      && TEMPLATE_FORMATS[extname(entry.name).toLowerCase()]
    ) output.push(path);
  }
}

function xmlDecode(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, entry) => String.fromCodePoint(Number.parseInt(entry, 16)))
    .replace(/&#(\d+);/g, (_, entry) => String.fromCodePoint(Number(entry)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function xmlAttribute(source, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(String(source || ''));
  return match ? xmlDecode(match[1]) : '';
}

function xmlTexts(source) {
  return [...String(source || '').matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)]
    .map((match) => xmlDecode(match[1]).trim())
    .filter(Boolean);
}

function pptxPartPath(target) {
  const raw = String(target || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const segments = (raw.startsWith('ppt/') ? raw : `ppt/${raw}`).split('/');
  const normalized = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') normalized.pop();
    else normalized.push(segment);
  }
  return normalized.join('/');
}

async function pptxSlideEntries(zip) {
  const names = Object.keys(zip.files);
  const numberFromPath = (value) => Number(/(\d+)(?=\.xml$)/.exec(value)?.[1] || 0);
  const fallback = names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => numberFromPath(left) - numberFromPath(right));
  const presentationFile = zip.file('ppt/presentation.xml');
  const relationshipsFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!presentationFile || !relationshipsFile) {
    return fallback.map((name, index) => ({ name, slide: index + 1, part: numberFromPath(name) }));
  }
  const presentationXml = await presentationFile.async('string');
  const relationshipsXml = await relationshipsFile.async('string');
  const targetsById = new Map(
    [...relationshipsXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?>/gi)]
      .map((match) => [xmlAttribute(match[0], 'Id'), xmlAttribute(match[0], 'Target')])
      .filter(([id, target]) => id && /(?:^|\/)slides\/slide\d+\.xml$/i.test(target)),
  );
  const ordered = [...presentationXml.matchAll(/<(?:\w+:)?sldId\b[^>]*\/?>/gi)]
    .map((match) => ({
      relationshipId: xmlAttribute(match[0], 'r:id'),
      name: pptxPartPath(targetsById.get(xmlAttribute(match[0], 'r:id'))),
    }))
    .filter((entry) => zip.file(entry.name));
  const slideEntries = ordered.length
    ? ordered
    : fallback.map((name) => ({ relationshipId: '', name }));
  return slideEntries.map((entry, index) => ({
    ...entry,
    slide: index + 1,
    part: numberFromPath(entry.name),
  }));
}

function xmlSetAttribute(source, name, value) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(source).replace(
    new RegExp(`(\\b${escaped}=")[^"]*(")`, 'i'),
    `$1${String(value)}$2`,
  );
}

function relationshipType(block, suffix) {
  return xmlAttribute(block, 'Type').toLowerCase().endsWith(`/${suffix.toLowerCase()}`);
}

function ensureContentTypeOverride(xml, partName, contentType) {
  if (!xml || new RegExp(`\\bPartName="${String(partName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i').test(xml)) {
    return xml;
  }
  return xml.replace(
    /<\/Types>/i,
    `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`,
  );
}

export async function createPptxSlideSelection(sourcePath, slides, outputPath) {
  const selected = (Array.isArray(slides) ? slides : []).map(Number);
  if (!selected.length || selected.some((slide) => !Number.isInteger(slide) || slide < 1)) {
    throw new Error('PPTX slide selection requires positive integer slide numbers');
  }
  const zip = await JSZip.loadAsync(await readFile(sourcePath));
  const entries = await pptxSlideEntries(zip);
  if (selected.some((slide) => slide > entries.length)) {
    throw new Error(`PPTX slide selection is outside source deck range 1-${entries.length}`);
  }
  const presentationFile = zip.file('ppt/presentation.xml');
  const relationshipsFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!presentationFile || !relationshipsFile) throw new Error('PPTX presentation relationships are missing');
  const presentationXml = await presentationFile.async('string');
  const relationshipsXml = await relationshipsFile.async('string');
  const relationshipBlocks = [...relationshipsXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?>/gi)]
    .map((match) => match[0]);
  const slideRelationshipIds = entries.map((entry) => entry.relationshipId).filter(Boolean);
  const nonSlideRelationshipIds = new Set(
    relationshipBlocks
      .filter((block) => !relationshipType(block, 'slide'))
      .map((block) => xmlAttribute(block, 'Id')),
  );
  const relationshipIds = [];
  let nextRelationshipId = 2;
  for (let index = 0; index < selected.length; index += 1) {
    let id = slideRelationshipIds[index] || '';
    while (!id || nonSlideRelationshipIds.has(id) || relationshipIds.includes(id)) {
      id = `rId${nextRelationshipId}`;
      nextRelationshipId += 1;
    }
    relationshipIds.push(id);
  }
  const selectedParts = [];
  for (const slide of selected) {
    const entry = entries[slide - 1];
    const slideXml = await zip.file(entry.name).async('string');
    const slideRelationshipsPath = `ppt/slides/_rels/slide${entry.part}.xml.rels`;
    const slideRelationshipsXml = await zip.file(slideRelationshipsPath)?.async('string') || '';
    const notesRelationship = [...slideRelationshipsXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?>/gi)]
      .map((match) => match[0])
      .find((block) => relationshipType(block, 'notesSlide'));
    const notesTarget = notesRelationship ? xmlAttribute(notesRelationship, 'Target') : '';
    const notesPart = Number(/notesSlide(\d+)\.xml$/i.exec(notesTarget)?.[1] || 0);
    const notesXml = notesPart
      ? await zip.file(`ppt/notesSlides/notesSlide${notesPart}.xml`)?.async('string') || ''
      : '';
    const notesRelationshipsXml = notesPart
      ? await zip.file(`ppt/notesSlides/_rels/notesSlide${notesPart}.xml.rels`)?.async('string') || ''
      : '';
    selectedParts.push({
      slideXml,
      slideRelationshipsXml,
      notesXml,
      notesRelationshipsXml,
    });
  }
  const slideListPattern = /<((?:\w+:)?)sldIdLst\b[^>]*>[\s\S]*?<\/\1sldIdLst>/i;
  const slideListMatch = slideListPattern.exec(presentationXml);
  if (!slideListMatch) throw new Error('PPTX presentation slide list is missing');
  const presentationPrefix = slideListMatch[1] || '';
  const slideIds = relationshipIds
    .map((id, index) => `<${presentationPrefix}sldId id="${256 + index}" r:id="${id}"/>`)
    .join('');
  const nextPresentationXml = presentationXml.replace(
    slideListPattern,
    `<${presentationPrefix}sldIdLst>${slideIds}</${presentationPrefix}sldIdLst>`,
  );
  const slideRelationships = relationshipIds
    .map((id, index) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`)
    .join('');
  const nextRelationshipsXml = relationshipsXml
    .replace(/<(?:\w+:)?Relationship\b[^>]*\/?>/gi, (block) => (
      relationshipType(block, 'slide') ? '' : block
    ))
    .replace(/<\/Relationships>/i, `${slideRelationships}</Relationships>`);
  zip.file('ppt/presentation.xml', nextPresentationXml);
  zip.file('ppt/_rels/presentation.xml.rels', nextRelationshipsXml);
  let contentTypesXml = await zip.file('[Content_Types].xml')?.async('string') || '';
  for (let index = 0; index < selectedParts.length; index += 1) {
    const target = index + 1;
    const part = selectedParts[index];
    zip.file(`ppt/slides/slide${target}.xml`, part.slideXml);
    if (part.slideRelationshipsXml) {
      const slideRels = part.slideRelationshipsXml.replace(
        /<(?:\w+:)?Relationship\b[^>]*\/?>/gi,
        (block) => relationshipType(block, 'notesSlide')
          ? xmlSetAttribute(block, 'Target', `../notesSlides/notesSlide${target}.xml`)
          : block,
      );
      zip.file(`ppt/slides/_rels/slide${target}.xml.rels`, slideRels);
    } else {
      zip.remove(`ppt/slides/_rels/slide${target}.xml.rels`);
    }
    contentTypesXml = ensureContentTypeOverride(
      contentTypesXml,
      `/ppt/slides/slide${target}.xml`,
      'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    );
    if (part.notesXml) {
      zip.file(`ppt/notesSlides/notesSlide${target}.xml`, part.notesXml);
      const notesRels = part.notesRelationshipsXml.replace(
        /<(?:\w+:)?Relationship\b[^>]*\/?>/gi,
        (block) => relationshipType(block, 'slide')
          ? xmlSetAttribute(block, 'Target', `../slides/slide${target}.xml`)
          : block,
      );
      if (notesRels) zip.file(`ppt/notesSlides/_rels/notesSlide${target}.xml.rels`, notesRels);
      contentTypesXml = ensureContentTypeOverride(
        contentTypesXml,
        `/ppt/notesSlides/notesSlide${target}.xml`,
        'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
      );
    }
  }
  if (contentTypesXml) zip.file('[Content_Types].xml', contentTypesXml);
  const appFile = zip.file('docProps/app.xml');
  if (appFile) {
    const appXml = await appFile.async('string');
    zip.file('docProps/app.xml', appXml.replace(/<Slides>\d+<\/Slides>/i, `<Slides>${selected.length}</Slides>`));
  }
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    }));
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    output: outputPath,
    source: sourcePath,
    slides: selected,
    count: selected.length,
  };
}

function directPptxShapeBlocks(xml) {
  const tree = /<p:spTree\b[^>]*>([\s\S]*?)<\/p:spTree>/i.exec(String(xml || ''))?.[1] || '';
  const tags = /<\/?p:(sp|pic|graphicFrame|grpSp)\b[^>]*>/gi;
  const stack = [];
  const output = [];
  let start = -1;
  let rootType = '';
  for (const match of tree.matchAll(tags)) {
    const token = match[0];
    const type = match[1];
    const closing = token.startsWith('</');
    if (!closing) {
      if (!stack.length) {
        start = match.index;
        rootType = type;
      }
      stack.push(type);
    } else {
      const current = stack.pop();
      if (current !== type) {
        stack.length = 0;
        start = -1;
        rootType = '';
        continue;
      }
      if (!stack.length && start >= 0) {
        output.push({ type: rootType, xml: tree.slice(start, match.index + token.length) });
        start = -1;
        rootType = '';
      }
    }
  }
  return output;
}

function tokenSlotRole(text) {
  const token = /\{\{([A-Z0-9_]+)\}\}/.exec(String(text || ''))?.[1] || '';
  if (!token) return '';
  const metric = /^METRIC_(\d+)_(VALUE|LABEL|DETAIL)$/.exec(token);
  if (metric) return `metric-${metric[2].toLowerCase()}-${metric[1]}`;
  const column = /^COLUMN_(\d+)_(TITLE|BODY)$/.exec(token);
  if (column) return `column-${column[2].toLowerCase()}-${column[1]}`;
  const step = /^STEP_(\d+)_(TITLE|DETAIL)$/.exec(token);
  if (step) return `step-${step[2].toLowerCase()}-${step[1]}`;
  return token.toLowerCase().replaceAll('_', '-');
}

function pptxShapeMetadata(block, shape) {
  const cNvPr = /<p:cNvPr\b[^>]*>/i.exec(block.xml)?.[0] || '';
  const placeholder = /<p:ph\b[^>]*\/?>/i.exec(block.xml)?.[0] || '';
  const placeholderType = xmlAttribute(placeholder, 'type') || '';
  const placeholderIndex = Number(xmlAttribute(placeholder, 'idx'));
  const texts = xmlTexts(block.xml);
  const text = texts.join('\n');
  const off = /<a:off\b[^>]*>/i.exec(block.xml)?.[0] || '';
  const ext = /<a:ext\b[^>]*>/i.exec(block.xml)?.[0] || '';
  const geometry = {
    left: Number(xmlAttribute(off, 'x')) || 0,
    top: Number(xmlAttribute(off, 'y')) || 0,
    width: Number(xmlAttribute(ext, 'cx')) || 0,
    height: Number(xmlAttribute(ext, 'cy')) || 0,
  };
  let type = 'text';
  if (block.type === 'pic') type = 'image';
  else if (block.type === 'graphicFrame' && /<c:chart\b/i.test(block.xml)) type = 'chart';
  else if (block.type === 'graphicFrame' && /<a:tbl\b/i.test(block.xml)) type = 'table';
  else if (block.type === 'graphicFrame' || block.type === 'grpSp') type = 'diagram';
  let role = tokenSlotRole(text);
  if (!role) {
    if (['title', 'ctrTitle'].includes(placeholderType)) role = 'title';
    else if (placeholderType === 'subTitle') role = 'subtitle';
    else if (placeholderType === 'pic' || type === 'image') role = 'image';
    else if (type === 'chart') role = 'chart';
    else if (type === 'table') role = 'table';
    else if (placeholderType) role = `body-${shape}`;
  }
  return {
    shape,
    name: xmlAttribute(cNvPr, 'name'),
    type,
    text,
    placeholderType,
    ...(Number.isInteger(placeholderIndex) ? { placeholderIndex } : {}),
    geometry,
    ...(role ? {
      slot: {
        role,
        type,
        shape,
        ...(placeholderType ? { placeholderType } : {}),
        ...(Number.isInteger(placeholderIndex) ? { placeholderIndex } : {}),
        geometry,
        required: ['title'].includes(role),
      },
    } : {}),
  };
}

function inferPptxSampleKind(sample, total) {
  const roles = new Set(sample.slots.map((slot) => slot.role));
  const title = String(sample.title || '').toLowerCase();
  if (sample.slide === 1) return 'cover';
  if (sample.slide === total && /(thank|next|close|감사|다음)/i.test(title)) return 'closing';
  if ([...roles].some((role) => role.startsWith('step-'))) return 'process';
  if ([...roles].some((role) => role.startsWith('column-'))) return 'comparison';
  if (roles.has('chart') || [...roles].some((role) => role.startsWith('metric-'))) return 'metrics';
  if (roles.has('image')) return 'split';
  if (sample.textChars < 90 && sample.shapes.length <= 6) return 'statement';
  return 'content';
}

function numberedRoleGroups(slots, prefix) {
  return new Set((slots || []).flatMap((slot) => {
    const match = new RegExp(`^${prefix}-(?:value|label|detail|title|body)-(\\d+)$`).exec(String(slot.role || ''));
    return match ? [Number(match[1])] : [];
  })).size;
}

function pptxSampleCapacity(sample) {
  const slots = Array.isArray(sample?.slots) ? sample.slots : [];
  return {
    sampleTextChars: Number(sample?.textChars) || 0,
    shapeCount: Array.isArray(sample?.shapes) ? sample.shapes.length : 0,
    textSlots: slots.filter((slot) => slot.type === 'text').length,
    metricGroups: numberedRoleGroups(slots, 'metric'),
    columnGroups: numberedRoleGroups(slots, 'column'),
    stepGroups: numberedRoleGroups(slots, 'step'),
    textArea: Math.round(slots
      .filter((slot) => slot.type === 'text')
      .reduce((total, slot) => (
        total + Math.max(0, Number(slot.geometry?.width) || 0) * Math.max(0, Number(slot.geometry?.height) || 0)
      ), 0)),
  };
}

export function officeTemplateCoverage(sampleSlides = []) {
  const samples = Array.isArray(sampleSlides) ? sampleSlides : [];
  const kinds = [...new Set(samples.map((sample) => String(sample.kind || '')).filter(Boolean))].sort();
  const densities = [...new Set(samples.map((sample) => String(sample.density || '')).filter(Boolean))].sort();
  const purposes = [...new Set(samples.flatMap((sample) => sample.purposes || []))].sort();
  const expressionModes = [...new Set(samples.flatMap((sample) => sample.expressionModes || []))].sort();
  const capabilities = [...new Set(samples.flatMap((sample) => sample.capabilities || []))].sort();
  const recommendedKinds = ['cover', 'content', 'statement', 'comparison', 'process', 'metrics', 'split', 'closing'];
  const recommendedDensities = ['light', 'balanced', 'dense'];
  const recommendedPurposes = ['compare', 'decide', 'explain', 'monitor'];
  const recommendedExpressionModes = ['conservative', 'strong-fit', 'divergent'];
  return {
    sampleCount: samples.length,
    kinds,
    densities,
    purposes,
    expressionModes,
    capabilities,
    missingKinds: recommendedKinds.filter((kind) => !kinds.includes(kind)),
    missingDensities: recommendedDensities.filter((density) => !densities.includes(density)),
    missingPurposes: recommendedPurposes.filter((purpose) => !purposes.includes(purpose)),
    missingExpressionModes: recommendedExpressionModes.filter((mode) => !expressionModes.includes(mode)),
    nativeObjectCoverage: {
      image: capabilities.includes('image'),
      chart: capabilities.includes('chart'),
      table: capabilities.includes('table'),
      diagram: capabilities.includes('diagram'),
    },
    complete: recommendedKinds.every((kind) => kinds.includes(kind))
      && recommendedDensities.every((density) => densities.includes(density))
      && ['image', 'chart', 'table'].every((capability) => capabilities.includes(capability)),
  };
}

export async function inspectOfficeTemplate(path, { format = '' } = {}) {
  const normalizedFormat = format || TEMPLATE_FORMATS[extname(path).toLowerCase()] || '';
  if (normalizedFormat !== 'pptx') return { sampleSlides: [], nativeLayouts: [], theme: null };
  const zip = await JSZip.loadAsync(await readFile(path));
  const names = Object.keys(zip.files);
  const numberFromPath = (value) => Number(/(\d+)(?=\.xml$)/.exec(value)?.[1] || 0);
  const slideEntries = await pptxSlideEntries(zip);
  const sampleSlides = [];
  for (const { name, slide, part } of slideEntries) {
    const xml = await zip.file(name).async('string');
    const shapes = directPptxShapeBlocks(xml).map((block, index) => pptxShapeMetadata(block, index + 1));
    const slots = shapes.flatMap((shape) => shape.slot ? [shape.slot] : []);
    const textChars = shapes.reduce((total, shape) => total + shape.text.length, 0);
    const title = shapes.find((shape) => ['title', 'ctrTitle'].includes(shape.placeholderType))?.text
      || shapes.find((shape) => shape.slot?.role === 'title')?.text
      || '';
    const capabilities = [...new Set(shapes.map((shape) => shape.type).filter((type) => type !== 'text'))];
    sampleSlides.push({
      slide,
      part,
      title,
      textChars,
      density: textChars > 340 || shapes.length > 16 ? 'dense' : textChars > 120 || shapes.length > 8 ? 'balanced' : 'light',
      shapes,
      slots,
      capabilities,
    });
  }
  for (const sample of sampleSlides) {
    sample.kind = inferPptxSampleKind(sample, sampleSlides.length);
    sample.capacity = pptxSampleCapacity(sample);
  }
  const layoutNames = names
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(name))
    .sort((left, right) => numberFromPath(left) - numberFromPath(right));
  const nativeLayouts = [];
  for (const name of layoutNames) {
    const xml = await zip.file(name).async('string');
    const root = /<p:sldLayout\b[^>]*>/i.exec(xml)?.[0] || '';
    const common = /<p:cSld\b[^>]*>/i.exec(xml)?.[0] || '';
    const shapes = directPptxShapeBlocks(xml).map((block, index) => pptxShapeMetadata(block, index + 1));
    nativeLayouts.push({
      layout: numberFromPath(name),
      name: xmlAttribute(common, 'name'),
      type: xmlAttribute(root, 'type'),
      slots: shapes.flatMap((shape) => shape.slot ? [shape.slot] : []),
    });
  }
  const themeName = names.find((name) => /^ppt\/theme\/theme\d+\.xml$/i.test(name));
  let theme = null;
  if (themeName) {
    const xml = await zip.file(themeName).async('string');
    const root = /<a:theme\b[^>]*>/i.exec(xml)?.[0] || '';
    theme = {
      name: xmlAttribute(root, 'name'),
      fonts: [...new Set([...xml.matchAll(/<a:(?:latin|ea|cs)\b[^>]*\btypeface="([^"]*)"/gi)]
        .map((match) => xmlDecode(match[1]))
        .filter(Boolean))],
    };
  }
  return {
    sampleSlides,
    nativeLayouts,
    theme,
    coverage: officeTemplateCoverage(sampleSlides),
  };
}

function normalizeLocalMetadata(value, path) {
  if (!plainObject(value)) return {};
  return {
    ...(value.id ? { id: safeId(value.id, 'local template id') } : {}),
    label: String(value.label || ''),
    profile: value.profile ? safeId(value.profile, 'local template profile') : '',
    version: String(value.version || ''),
    layouts: normalizeLayouts(value.layouts || [], { templatePath: path }),
    samples: normalizeLocalSamples(value.samples || []),
  };
}

export async function indexOfficeTemplates({
  dataDir,
  config: configOverride = null,
} = {}) {
  const paths = libraryPaths(dataDir);
  const config = await loadConfig(dataDir, configOverride);
  await mkdir(paths.templates, { recursive: true });
  const previous = await readJson(paths.templateIndex, { templates: [] });
  const previousByPath = new Map((previous.templates || []).map((entry) => [canonicalPath(entry.path), entry]));
  const files = [];
  for (const directory of config.templateDirectories) await walkTemplateDirectory(directory, files);
  const templates = [];
  for (const path of files) {
    const canonical = canonicalPath(path);
    const details = await stat(path);
    const sidecarPath = `${path}.mixdog.json`;
    const sidecarDetails = await stat(sidecarPath).catch(() => null);
    const previousEntry = previousByPath.get(canonical);
    const unchanged = previousEntry
      && Number(previousEntry.bytes) === details.size
      && Number(previousEntry.mtimeMs) === details.mtimeMs
      && Number(previousEntry.sidecarMtimeMs || 0) === Number(sidecarDetails?.mtimeMs || 0)
      && Number(previousEntry.inspectionVersion || 0) === TEMPLATE_INSPECTOR_VERSION;
    if (unchanged) {
      templates.push(previousEntry);
      continue;
    }
    const digest = await sha256File(path);
    const metadata = normalizeLocalMetadata(await readJson(sidecarPath, {}), path);
    const id = metadata.id || `local-${sha256(canonical).slice(0, 16)}`;
    const format = TEMPLATE_FORMATS[extname(path).toLowerCase()];
    let inspected = {
      sampleSlides: [],
      nativeLayouts: [],
      theme: null,
      coverage: officeTemplateCoverage([]),
    };
    let inspectionWarning = '';
    try {
      inspected = await inspectOfficeTemplate(path, { format });
    } catch (error) {
      inspectionWarning = error?.message || String(error);
    }
    const autoLayouts = inspected.sampleSlides.map((sample) => {
      const sampleMetadata = metadata.samples.find((entry) => entry.slide === sample.slide);
      const slots = sampleMetadata && Object.keys(sampleMetadata.roles).length
        ? Object.entries(sampleMetadata.roles).map(([shapeIndex, role]) => {
            const shape = sample.shapes.find((entry) => entry.shape === Number(shapeIndex));
            if (!shape) {
              throw new Error(`Office local template sample ${sample.slide} references missing shape ${shapeIndex}`);
            }
            return {
              role,
              type: shape.type,
              shape: shape.shape,
              ...(shape.placeholderType ? { placeholderType: shape.placeholderType } : {}),
              ...(Number.isInteger(shape.placeholderIndex) ? { placeholderIndex: shape.placeholderIndex } : {}),
              geometry: shape.geometry,
              required: role === 'title',
            };
          })
        : sample.slots;
      return {
        id: sampleMetadata?.id || `${id}-slide-${sample.slide}`,
        format: 'pptx',
        kind: sampleMetadata?.kind || sample.kind,
        profile: metadata.profile,
        density: sampleMetadata?.density || sample.density,
        variant: sampleMetadata?.variant || 'native',
        purposes: sampleMetadata?.purposes || [],
        expressionModes: sampleMetadata?.expressionModes || [],
        templateId: id,
        templatePath: path,
        sourceSlide: sample.slide,
        sourceLayout: 0,
        slots,
        capacity: {
          ...sample.capacity,
          ...(sampleMetadata?.capacity || {}),
        },
        capabilities: sample.capabilities,
        priority: sampleMetadata?.priority || 0,
        strict: sampleMetadata?.strict || false,
        defaults: sampleMetadata?.defaults || {},
      };
    });
    const layouts = metadata.layouts.length
      ? metadata.layouts.map((layout) => {
          const sample = inspected.sampleSlides.find((entry) => entry.slide === layout.sourceSlide);
          return {
            ...layout,
            templateId: layout.templateId || id,
            templatePath: path,
            slots: layout.slots.length ? layout.slots : sample?.slots || [],
            capacity: Object.keys(layout.capacity || {}).length ? layout.capacity : sample?.capacity || {},
            capabilities: layout.capabilities.length ? layout.capabilities : sample?.capabilities || [],
          };
        })
      : autoLayouts;
    const indexedSampleSlides = inspected.sampleSlides.map((sample) => {
      const layout = layouts.find((entry) => entry.sourceSlide === sample.slide);
      const titleShape = sample.shapes.find((shape) => (
        layout?.slots.some((slot) => slot.role === 'title' && slot.shape === shape.shape)
      ));
      return {
        ...sample,
        title: sample.title || titleShape?.text || '',
        kind: layout?.kind || sample.kind,
        density: layout?.density || sample.density,
        purposes: layout?.purposes || [],
        expressionModes: layout?.expressionModes || [],
        slots: layout?.slots || sample.slots,
        capacity: layout?.capacity || sample.capacity,
      };
    });
    const coverage = officeTemplateCoverage(indexedSampleSlides);
    templates.push({
      id,
      label: metadata.label || path.split(/[\\/]/).at(-1),
      format,
      fileKind: extname(path).slice(1).toLowerCase(),
      path: resolve(path),
      source: 'local-template',
      bytes: details.size,
      mtimeMs: details.mtimeMs,
      sidecarMtimeMs: Number(sidecarDetails?.mtimeMs || 0),
      inspectionVersion: TEMPLATE_INSPECTOR_VERSION,
      inspectionWarning,
      sha256: digest,
      version: metadata.version ? `${metadata.version}+${digest.slice(0, 12)}` : digest.slice(0, 16),
      profile: metadata.profile,
      layouts,
      sampleSlides: indexedSampleSlides,
      coverage,
      nativeLayouts: inspected.nativeLayouts,
      theme: inspected.theme,
    });
  }
  templates.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
  const revision = sha256(JSON.stringify(templates.map((entry) => [
    entry.id,
    entry.path,
    entry.sha256,
    entry.sidecarMtimeMs,
  ])));
  const changed = revision !== previous.revision;
  const index = {
    schemaVersion: SCHEMA_VERSION,
    indexedAt: new Date().toISOString(),
    revision,
    directories: config.templateDirectories,
    templates,
  };
  if (changed || !previous.revision) await writeJsonAtomic(paths.templateIndex, index);
  return {
    ...index,
    changed,
    count: templates.length,
  };
}

async function readTemplateIndex(paths) {
  return await readJson(paths.templateIndex, {
    schemaVersion: SCHEMA_VERSION,
    revision: '',
    templates: [],
  });
}

async function writeState(paths, state) {
  await writeJsonAtomic(paths.state, {
    schemaVersion: SCHEMA_VERSION,
    ...state,
  });
}

export async function syncOfficeDesignLibrary({
  dataDir,
  config: configOverride = null,
  fetchImpl = fetch,
  force = false,
  allowRemote = true,
  indexTemplates = true,
  signal = null,
} = {}) {
  const paths = libraryPaths(dataDir);
  const config = await loadConfig(dataDir, configOverride);
  await mkdir(paths.root, { recursive: true });
  let warning = '';
  const addWarning = (message) => {
    warning = [warning, String(message || '')].filter(Boolean).join(' ');
  };
  let templateIndex;
  try {
    templateIndex = indexTemplates
      ? await indexOfficeTemplates({ dataDir, config })
      : await readTemplateIndex(paths);
  } catch (error) {
    templateIndex = await readTemplateIndex(paths);
    addWarning(`Office template index was not updated: ${error?.message || String(error)}`);
  }
  let state = await readJson(paths.state, { schemaVersion: SCHEMA_VERSION });
  let activePack = null;
  try {
    activePack = await loadCachedPack(paths, config, state.active?.id, state.active?.version);
  } catch (error) {
    addWarning(error.message);
  }
  const now = Date.now();
  const due = force || !Number(state.lastCheckedAt) || now - Number(state.lastCheckedAt) >= config.checkIntervalMs;
  if (!allowRemote || !config.manifestUrl || !due) {
    return {
      ok: !warning,
      activePack,
      active: packSummary(activePack),
      templates: templateIndex,
      checked: false,
      warning,
    };
  }
  try {
    const url = new URL(config.manifestUrl);
    if (url.protocol !== 'https:') throw new Error('Office design pack manifest requires an HTTPS URL');
    const response = await fetchWithTimeout(fetchImpl, url.href, {
      signal,
      headers: state.etag ? { 'If-None-Match': state.etag } : {},
    });
    if (response.status === 304) {
      state = {
        ...state,
        lastCheckedAt: now,
        lastError: '',
      };
      await writeState(paths, state);
      return {
        ok: !warning,
        activePack,
        active: packSummary(activePack),
        templates: templateIndex,
        checked: true,
        updated: false,
        warning,
      };
    }
    const bytes = await responseBytes(response, MAX_MANIFEST_BYTES, 'Office design pack manifest');
    const envelope = JSON.parse(bytes.toString('utf8'));
    const verified = verifyOfficeDesignPackEnvelope(envelope, config.trustedKeys);
    if (config.packId && verified.pack.id !== config.packId) {
      throw new Error(`Office design pack ${verified.pack.id} does not match configured pack ${config.packId}`);
    }
    if (config.channel && verified.pack.channel !== config.channel) {
      throw new Error(`Office design pack channel ${verified.pack.channel} does not match ${config.channel}`);
    }
    const currentIsSamePack = activePack?.id === verified.pack.id;
    const shouldActivate = !activePack
      || !currentIsSamePack
      || compareOfficeDesignVersions(verified.pack.version, activePack.version) > 0;
    if (shouldActivate) {
      await materializePack(envelope, verified, paths, fetchImpl, signal);
      activePack = await loadCachedPack(paths, config, verified.pack.id, verified.pack.version);
    }
    state = {
      ...state,
      active: activePack ? { id: activePack.id, version: activePack.version } : state.active,
      lastCheckedAt: now,
      lastActivatedAt: shouldActivate ? now : state.lastActivatedAt,
      etag: String(response.headers?.get?.('etag') || state.etag || ''),
      lastError: '',
    };
    await writeState(paths, state);
    return {
      ok: !warning,
      activePack,
      active: packSummary(activePack),
      templates: templateIndex,
      checked: true,
      updated: shouldActivate,
      warning,
    };
  } catch (error) {
    addWarning(error?.message || String(error));
    await writeState(paths, {
      ...state,
      lastCheckedAt: now,
      lastError: warning.slice(0, 1_000),
    }).catch(() => {});
    return {
      ok: false,
      activePack,
      active: packSummary(activePack),
      templates: templateIndex,
      checked: true,
      updated: false,
      warning,
    };
  }
}

function bindingPath(paths, documentPath) {
  return join(paths.bindings, `${sha256(canonicalPath(documentPath))}.json`);
}

export async function readOfficeDesignBinding(dataDir, documentPath) {
  const paths = libraryPaths(dataDir);
  const binding = await readJson(bindingPath(paths, documentPath));
  if (!binding || canonicalPath(binding.documentPath) !== canonicalPath(documentPath)) return null;
  return binding;
}

export async function persistOfficeDesignBinding(dataDir, documentPath, binding) {
  if (!binding) return null;
  const paths = libraryPaths(dataDir);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    ...clone(binding),
    documentPath: resolve(documentPath),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(bindingPath(paths, documentPath), record);
  return record;
}

function normalizedCompositionRecord(value) {
  if (!plainObject(value)) return null;
  const fingerprint = String(value.fingerprint || '');
  const format = String(value.format || '').toLowerCase();
  if (!fingerprint || !FORMATS.has(format)) return null;
  return {
    fingerprint,
    format,
    profile: String(value.profile || ''),
    purpose: String(value.purpose || ''),
    expressionMode: String(value.expressionMode || ''),
    compositionIds: [...new Set((Array.isArray(value.compositionIds) ? value.compositionIds : [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean))].slice(0, 64),
    documentKey: String(value.documentKey || ''),
    createdAt: String(value.createdAt || ''),
  };
}

export async function readOfficeCompositionHistory(dataDir, {
  format = '',
  limit = 24,
  excludeDocumentPath = '',
} = {}) {
  const paths = libraryPaths(dataDir);
  const store = await readJson(paths.compositionHistory, { records: [] });
  const normalizedFormat = String(format || '').toLowerCase();
  const excludedKey = excludeDocumentPath ? sha256(canonicalPath(excludeDocumentPath)) : '';
  return (Array.isArray(store?.records) ? store.records : [])
    .map(normalizedCompositionRecord)
    .filter(Boolean)
    .filter((entry) => !normalizedFormat || entry.format === normalizedFormat)
    .filter((entry) => !excludedKey || entry.documentKey !== excludedKey)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, Math.min(MAX_COMPOSITION_HISTORY, Number(limit) || 24)));
}

export async function recordOfficeCompositionHistory(dataDir, {
  documentPath,
  format,
  profile = '',
  purpose = '',
  expressionMode = '',
  fingerprint,
  compositionIds = [],
} = {}) {
  const paths = libraryPaths(dataDir);
  const documentKey = sha256(canonicalPath(documentPath));
  const record = normalizedCompositionRecord({
    documentKey,
    format,
    profile,
    purpose,
    expressionMode,
    fingerprint,
    compositionIds,
    createdAt: new Date().toISOString(),
  });
  if (!record) throw new Error('Office composition history requires a supported format and fingerprint');
  const store = await readJson(paths.compositionHistory, { records: [] });
  const existing = (Array.isArray(store?.records) ? store.records : [])
    .map(normalizedCompositionRecord)
    .filter(Boolean)
    .filter((entry) => entry.documentKey !== documentKey);
  const records = [record, ...existing].slice(0, MAX_COMPOSITION_HISTORY);
  await writeJsonAtomic(paths.compositionHistory, {
    schemaVersion: SCHEMA_VERSION,
    records,
  });
  return record;
}

function findTemplate(templates, selector, format) {
  const wanted = String(selector || '').trim();
  if (!wanted) return null;
  const canonical = isAbsolute(wanted) ? canonicalPath(wanted) : '';
  return templates.find((template) => (
    template.format === format
    && (template.id === wanted.toLowerCase() || (canonical && canonicalPath(template.path) === canonical))
  )) || null;
}

function layoutCandidates(pack, template, format) {
  const templates = pack?.templates || [];
  const packLayouts = (pack?.layouts || []).map((layout) => {
    const owner = templates.find((entry) => entry.id === layout.templateId);
    return owner ? { ...layout, templatePath: owner.path } : layout;
  });
  return [
    ...packLayouts,
    ...(template?.layouts || []),
  ].filter((layout) => layout.format === format).map(clone);
}

function bindingFor({ pack, template, format, source }) {
  return {
    source,
    format,
    packId: pack?.id || '',
    packVersion: pack?.version || '',
    keyId: pack?.keyId || '',
    templateId: template?.id || '',
    templateVersion: template?.version || '',
    templateSource: template?.source || '',
    pinnedAt: new Date().toISOString(),
  };
}

async function exactPack(paths, config, binding) {
  if (!binding?.packId || !binding?.packVersion) return null;
  return await loadCachedPack(paths, config, binding.packId, binding.packVersion);
}

export async function resolveOfficeDesignLibrary({
  dataDir,
  documentPath,
  sourcePath = '',
  format,
  created = false,
  request = {},
  config: configOverride = null,
  fetchImpl = fetch,
  signal = null,
} = {}) {
  const normalizedFormat = String(format || '').toLowerCase();
  if (!FORMATS.has(normalizedFormat)) throw new Error(`Unsupported Office design library format: ${format}`);
  const paths = libraryPaths(dataDir);
  const recentCompositions = await readOfficeCompositionHistory(dataDir, {
    format: normalizedFormat,
    excludeDocumentPath: documentPath,
  });
  const config = await loadConfig(dataDir, configOverride);
  const explicitUpgrade = request?.upgradeLibrary === true;
  const currentBinding = !created && !explicitUpgrade
    ? await readOfficeDesignBinding(dataDir, documentPath)
      || (sourcePath ? await readOfficeDesignBinding(dataDir, sourcePath) : null)
    : null;
  if (currentBinding) {
    let pack = null;
    let warning = '';
    try {
      pack = await exactPack(paths, config, currentBinding);
    } catch (error) {
      warning = `Pinned Office design pack is unavailable: ${error.message}`;
    }
    const index = await readTemplateIndex(paths);
    const allTemplates = [...(pack?.templates || []), ...(index.templates || [])];
    const template = allTemplates.find((entry) => (
      entry.id === currentBinding.templateId
      && entry.version === currentBinding.templateVersion
      && entry.format === normalizedFormat
    )) || null;
    if (currentBinding.templateId && !template) {
      warning ||= 'Pinned Office template version changed or is unavailable; the existing document remains unchanged.';
    }
    return {
      source: pack ? currentBinding.source : 'starter-fallback',
      binding: clone(currentBinding),
      pack,
      template,
      layouts: layoutCandidates(pack, template, normalizedFormat),
      coverage: template?.coverage || null,
      recentCompositions,
      templateIndexRevision: index.revision || '',
      warning,
      pinned: true,
    };
  }
  const synced = await syncOfficeDesignLibrary({
    dataDir,
    config,
    fetchImpl,
    force: request?.refreshLibrary === true,
    allowRemote: created || explicitUpgrade,
    indexTemplates: created || explicitUpgrade || Boolean(request?.template),
    signal,
  });
  let pack = synced.activePack;
  if (request?.packId || request?.packVersion) {
    if (!request.packId || !request.packVersion) {
      throw new Error('Office design pack selection requires both packId and packVersion');
    }
    pack = await loadCachedPack(
      paths,
      config,
      safeId(request.packId, 'requested packId'),
      String(request.packVersion),
    );
    if (!pack) throw new Error(`Requested Office design pack is not cached: ${request.packId}@${request.packVersion}`);
  }
  const allTemplates = [...(pack?.templates || []), ...(synced.templates.templates || [])];
  const explicitSelector = request?.template || '';
  const selector = explicitSelector || config.defaultTemplates[normalizedFormat] || '';
  const template = findTemplate(allTemplates, selector, normalizedFormat);
  if (explicitSelector && !template) {
    throw new Error(`Office design template is not indexed or does not match ${normalizedFormat}: ${selector}`);
  }
  const source = template
    ? template.source
    : pack
      ? 'remote-pack'
      : 'mixdog-starter';
  const binding = bindingFor({
    pack,
    template,
    format: normalizedFormat,
    source,
  });
  return {
    source,
    binding,
    pack,
    template,
    layouts: layoutCandidates(pack, template, normalizedFormat),
    coverage: template?.coverage || null,
    recentCompositions,
    templateIndexRevision: synced.templates.revision || '',
    warning: synced.warning || '',
    pinned: false,
  };
}

export async function inspectOfficeDesignLibrary({
  dataDir,
  config: configOverride = null,
} = {}) {
  const paths = libraryPaths(dataDir);
  const config = await loadConfig(dataDir, configOverride);
  const state = await readJson(paths.state, {});
  const index = await readTemplateIndex(paths);
  let activePack = null;
  let warning = String(state.lastError || '');
  try {
    activePack = await loadCachedPack(paths, config, state.active?.id, state.active?.version);
  } catch (error) {
    warning = error.message;
  }
  return {
    enabled: Boolean(config.manifestUrl),
    active: packSummary(activePack),
    lastCheckedAt: Number(state.lastCheckedAt) || 0,
    templateIndex: {
      revision: index.revision || '',
      count: index.templates?.length || 0,
      indexedAt: index.indexedAt || '',
    },
    warning,
  };
}
