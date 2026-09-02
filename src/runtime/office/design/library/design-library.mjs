import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  FORMATS,
  MAX_COMPOSITION_HISTORY,
  MAX_MANIFEST_BYTES,
  SCHEMA_VERSION,
  canonicalPath,
  compareOfficeDesignVersions,
  libraryPaths,
  loadConfig,
  readJson,
  safeId,
  writeJsonAtomic,
} from './design-library-core.mjs';
import { fetchWithTimeout, loadCachedPack, materializePack, packSummary, responseBytes, verifyOfficeDesignPackEnvelope } from './design-library-pack.mjs';
import { indexOfficeTemplates, readTemplateIndex, writeState } from './design-template-index.mjs';
import { clone, plainObject, sha256 } from '../../shared/values.mjs';

export {
  canonicalOfficeDesignPack,
  compareOfficeDesignVersions,
  defaultOfficeTemplateDirectories,
} from './design-library-core.mjs';
export { verifyOfficeDesignPackEnvelope } from './design-library-pack.mjs';
export { createPptxSlideSelection, officeTemplateCoverage } from './design-template-inspect.mjs';
export { indexOfficeTemplates, inspectOfficeTemplate } from './design-template-index.mjs';

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
