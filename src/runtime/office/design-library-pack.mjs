import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { ALLOWED_LAYOUT_DEFAULTS, FORMATS, LAYOUT_SLOT_TYPES, MAX_TEMPLATE_BYTES, MAX_TEMPLATE_COUNT, SCHEMA_VERSION, TEMPLATE_FORMATS, canonicalOfficeDesignPack, clone, parseVersion, plainObject, readJson, safeId, sha256, sha256File, writeJsonAtomic } from './design-library-core.mjs';

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


export function normalizeLayouts(value, { templatePath = '' } = {}) {
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


export function normalizeLocalSamples(value) {
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


export async function responseBytes(response, maximum, label) {
  if (!response?.ok) throw new Error(`${label} download failed with HTTP ${response?.status || 0}`);
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > maximum) throw new Error(`${label} exceeds the download size limit`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximum) throw new Error(`${label} exceeds the download size limit`);
  return bytes;
}


export async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 10_000) {
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


export async function materializePack(envelope, verified, paths, fetchImpl, signal) {
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


export async function loadCachedPack(paths, config, id, version) {
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


export function packSummary(pack) {
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
