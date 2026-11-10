// Public OpenAI API model capabilities for Responses request construction.
// Catalog metadata decides where it declares a capability; otherwise the
// documented model-family rules below apply. The Codex (openai-oauth) route is
// separate: its backend serves only current GPT-5.x models and keeps its own
// defaults, so none of these gates apply to it.
//   reasoning:    https://developers.openai.com/api/docs/guides/reasoning/
//   tool_search:  https://developers.openai.com/api/docs/guides/tools-tool-search/ (gpt-5.4 and later)
//   cache:        https://developers.openai.com/api/docs/guides/prompt-caching/
import { getModelMetadataSync } from '../../../shared/llm/model-catalog.mjs';

const SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;
const modelId = (model) => String(model?.id || model || '').trim();

// The catalog metadata of one model. A dated snapshot reads as its undated
// alias when only the alias is listed.
export function openAiCatalogMeta(model) {
  const id = modelId(model);
  for (const candidate of new Set([id, id.replace(SNAPSHOT_SUFFIX, '')])) {
    const meta = candidate ? getModelMetadataSync(candidate, 'openai') : null;
    if (meta) return meta;
  }
  return null;
}

// gpt-5.4 -> [5, 4]; gpt-6-astra -> [6, 0]; non-GPT ids -> null.
// A bare multi-digit major with no minor or family suffix (gpt-60) is not a
// generation id.
export function gptVersion(id) {
  const m = /^gpt-(\d+)(?:\.(\d+))?(?=-|$)/.exec(id);
  if (!m || (m[1].length > 1 && m[2] === undefined && m[0] === id)) return null;
  return [Number(m[1]), Number(m[2] || 0)];
}
const atLeast = (version, major, minor) =>
  Boolean(version) && (version[0] > major || (version[0] === major && version[1] >= minor));

// Reasoning models: the o-series and GPT-5 and later (gpt-5-chat-latest is the
// non-reasoning chat snapshot).
export function openAiPublicSupportsReasoning(model) {
  const flag = openAiCatalogMeta(model)?.supportsReasoning;
  if (typeof flag === 'boolean') return flag;
  const id = modelId(model);
  if (/^gpt-5-chat/.test(id)) return false;
  return /^o\d/.test(id) || atLeast(gptVersion(id), 5, 0);
}

// text.verbosity is documented for GPT-5 and later.
export function openAiPublicSupportsVerbosity(model) {
  return atLeast(gptVersion(modelId(model)), 5, 0);
}

// Native tool_search: Responses API gpt-5.4 and later.
export function openAiPublicSupportsToolSearch(model) {
  return atLeast(gptVersion(modelId(model)), 5, 4);
}

// GPT-5.6 and later take prompt_cache_options.ttl instead of prompt_cache_retention.
export function openAiUsesPromptCacheOptions(model) {
  return atLeast(gptVersion(modelId(model)), 5, 6);
}

// Documented extended (24h) prompt_cache_retention list; dated snapshots read
// as their alias.
const EXTENDED_RETENTION = new Set([
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.2',
  'gpt-5.1-codex-max',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-chat-latest',
  'gpt-5',
  'gpt-5-codex',
  'gpt-4.1',
]);
export function openAiSupportsExtendedRetention(model) {
  const id = modelId(model);
  return EXTENDED_RETENTION.has(id) || EXTENDED_RETENTION.has(id.replace(SNAPSHOT_SUFFIX, ''));
}
