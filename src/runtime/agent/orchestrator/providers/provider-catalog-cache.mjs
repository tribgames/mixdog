import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../config.mjs';

const PROVIDER_CACHE_FILES = Object.freeze({
  'openai-oauth': ['openai-oauth-models.json'],
  'anthropic-oauth': ['anthropic-oauth-models.json'],
  anthropic: ['anthropic-oauth-models.json'],
  gemini: ['gemini-models.json'],
  'grok-oauth': ['grok-oauth-models.json'],
});

export function providerUsesEndpointScopedLimits(provider) {
  const p = String(provider || '').toLowerCase();
  return p === 'openai-oauth' || p === 'anthropic-oauth' || p === 'grok-oauth';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function readModelsFromCacheFile(fileName) {
  try {
    const file = join(getPluginData(), fileName);
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    return Array.isArray(raw?.models) ? raw.models : (Array.isArray(raw) ? raw : []);
  } catch {
    return [];
  }
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

export function getProviderCachedModelSync(provider, model) {
  const p = String(provider || '').toLowerCase();
  const files = PROVIDER_CACHE_FILES[p] || [];
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
  if (!row) return null;
  return {
    contextWindow: num(row.contextWindow ?? row.context_window ?? row.maxContextWindow ?? row.max_context_window ?? row.max_input_tokens),
    outputTokens: num(row.outputTokens ?? row.maxOutputTokens ?? row.max_output_tokens ?? row.output_token_limit),
    supportsVision: row.supportsVision === true,
    supportsFunctionCalling: row.supportsFunctionCalling === true,
    supportsWebSearch: row.supportsWebSearch === true,
    supportsPromptCaching: row.supportsPromptCaching === true,
    supportsReasoning: row.supportsReasoning === true,
    reasoningOptions: Array.isArray(row.reasoningOptions) ? row.reasoningOptions : [],
    reasoningContentField: row.reasoningContentField || null,
    mode: row.mode || null,
    displayName: row.displayName || row.display || row.name || null,
    name: row.name || row.display || null,
    rawProviderModel: row,
  };
}
