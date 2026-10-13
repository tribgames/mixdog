import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from '../plugin-paths.mjs';
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_PRICING_ALIASES, normalizeGrokModelId } from './provider-model-identities.mjs';
import { providerRosterFiles, rosterProviders } from './provider-catalog-registry.mjs';

/** A declared capability keeps its boolean; an undeclared one stays undefined,
 *  so lower layers (catalogs, seeds) fill only what no source stated. */
export function capabilityFlag(value) {
  return typeof value === 'boolean' ? value : undefined;
}

/** Provider roster rows coerce "unknown" to `false` (`x === true`), so only a
 *  `true` there is a declaration; `false` leaves the field to catalogs/seeds. */
export function rosterCapabilityFlag(value) {
  return value === true ? true : undefined;
}

/** A roster row's effort ladder: `reasoningOptions` when it carries an effort
 *  entry, else the flat `reasoningLevels` some rosters store (Antigravity). */
export function rosterReasoningOptions(row) {
  const options = Array.isArray(row?.reasoningOptions) ? row.reasoningOptions : [];
  // An effort entry with no values declares nothing.
  const usable = options.filter((o) => o?.type !== 'effort' || (Array.isArray(o.values) && o.values.length > 0));
  if (usable.some((o) => o?.type === 'effort')) return usable;
  const levels = Array.isArray(row?.reasoningLevels) ? row.reasoningLevels.filter((v) => typeof v === 'string') : [];
  return levels.length ? [...usable, { type: 'effort', values: levels }] : usable;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function readModelsFromCacheFile(fileName) {
  try {
    const file = join(resolvePluginData(), fileName);
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    return [raw?.models, raw].find(Array.isArray) ?? [];
  } catch {
    return [];
  }
}

export function providerCachedModelsSync(provider) {
  const files = providerRosterFiles(provider);
  const rows = [];
  const seen = new Set();
  for (const fileName of files) {
    for (const row of readModelsFromCacheFile(fileName)) {
      const id = rowId(row);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({ ...row, id });
    }
  }
  return rows;
}

export function cachedProviderModelListsSync() {
  return Object.fromEntries(rosterProviders().map((provider) => [provider, providerCachedModelsSync(provider)]));
}

/** Only explicit catalog wire mappings establish an alias. Never strip an
 * effort/date/preview suffix: gateway labels can point to a different version. */
export function providerPricingModelSync(provider, model) {
  if (provider === 'grok-oauth') return normalizeGrokModelId(model);
  if (provider !== 'antigravity-oauth') return model;
  const row = [...providerCachedModelsSync(provider), ...ANTIGRAVITY_MODELS].find(
    (entry) =>
      entry.id === model ||
      entry.wire === model ||
      (entry.wire && typeof entry.wire === 'object' && Object.values(entry.wire).includes(model))
  );
  const id = row?.pricingModel || row?.id || model;
  return ANTIGRAVITY_PRICING_ALIASES[id] || id;
}

function modelAliases(id) {
  const text = String(id || '').trim();
  if (!text) return [];
  const aliases = new Set([text]);
  aliases.add(text.replace(/-\d{4}-\d{2}-\d{2}$/, ''));
  aliases.add(text.replace(/-\d{8}$/, ''));
  return [...aliases].filter(Boolean);
}

function rowId(row) {
  return String(row?.id || row?.name || row?.slug || '').trim();
}

function getProviderCachedModelSync(provider, model) {
  const files = providerRosterFiles(provider);
  if (!files.length || !model) return null;
  const aliases = new Set(modelAliases(model));
  for (const fileName of files) {
    for (const row of readModelsFromCacheFile(fileName)) {
      const id = rowId(row);
      if (!id || !aliases.has(id)) continue;
      return row;
    }
  }
  return null;
}

export function providerCachedModelMetadataSync(provider, model) {
  const row = getProviderCachedModelSync(provider, model);
  return row ? rosterRowMetadata(provider, row) : null;
}

/** Metadata layer of one live-roster row (cached or just listed). */
export function rosterRowMetadata(provider, row) {
  const p = String(provider || '').toLowerCase();
  return {
    contextWindow: num(
      row.contextWindow ?? row.context_window ?? row.maxContextWindow ?? row.max_context_window ?? row.max_input_tokens
    ),
    // Grok's /models response currently publishes a context window but no
    // output ceiling. Older enriched cache rows copied contextWindow into
    // outputTokens; never feed that derived value back as provider-native.
    outputTokens:
      p === 'grok-oauth'
        ? null
        : num(row.outputTokens ?? row.maxOutputTokens ?? row.max_output_tokens ?? row.output_token_limit),
    supportsVision: rosterCapabilityFlag(row.supportsVision),
    supportsFunctionCalling: rosterCapabilityFlag(row.supportsFunctionCalling),
    supportsWebSearch: rosterCapabilityFlag(row.supportsWebSearch),
    supportsPromptCaching: rosterCapabilityFlag(row.supportsPromptCaching),
    supportsReasoning: rosterCapabilityFlag(row.supportsReasoning),
    reasoningOptions: rosterReasoningOptions(row),
    reasoningContentField: row.reasoningContentField || null,
    mode: row.mode || null,
    displayName: row.displayName || row.display || row.name || null,
    name: row.name || row.display || null,
    rawProviderModel: row,
  };
}
