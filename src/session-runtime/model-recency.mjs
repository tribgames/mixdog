// Provider-model version parsing, recency comparison, sorting, and cache-row
// construction. Extracted from mixdog-session-runtime.mjs. Pure except for the
// injected route provider (for sort priority) and searchCapableFor predicate.
import { clean } from './session-text.mjs';

export function parsedProviderModelVersion(id) {
  const text = clean(id).toLowerCase();
  const claude = text.match(/^claude-[a-z]+-(\d+)(?:[-.](\d+))?/);
  if (claude) return [Number(claude[1]) || 0, Number(claude[2]) || 0];
  const compact = text.match(/(?:^|[-_])(?:o|gpt|grok|qwen|llama|mistral|gemma|phi|glm)(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/);
  if (compact) return compact.slice(1).filter((v) => v != null).map((v) => Number(v) || 0);
  const generic = text.match(/(?:^|[-_v])(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/);
  return generic ? generic.slice(1).filter((v) => v != null).map((v) => Number(v) || 0) : [];
}

export function compareProviderModelVersion(a, b) {
  const va = parsedProviderModelVersion(a.id || a.display || a.name);
  const vb = parsedProviderModelVersion(b.id || b.display || b.name);
  if (va.length === 0 && vb.length === 0) return 0;
  if (va.length === 0) return 1;
  if (vb.length === 0) return -1;
  for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
    const delta = (vb[i] || 0) - (va[i] || 0);
    if (delta) return delta;
  }
  return 0;
}

export function providerModelReleaseTime(model) {
  if (model?.releaseDate) {
    const t = Date.parse(model.releaseDate);
    if (Number.isFinite(t)) return t;
  }
  const created = Number(model?.created);
  if (Number.isFinite(created) && created > 0) {
    return created < 1_000_000_000_000 ? created * 1000 : created;
  }
  const dated = clean(model?.id).match(/(?:^|-)(\d{4})(\d{2})(\d{2})(?:$|-)/);
  return dated ? (Date.parse(`${dated[1]}-${dated[2]}-${dated[3]}`) || 0) : 0;
}

export function isClaudeProviderModel(model) {
  return clean(model?.provider).toLowerCase().includes('anthropic')
    && /^claude-[a-z]+-/.test(clean(model?.id).toLowerCase());
}

export function compareProviderModelRecency(a, b) {
  if (isClaudeProviderModel(a) && isClaudeProviderModel(b)) {
    if (a.latest !== b.latest) return a.latest ? -1 : 1;
    const versionDelta = compareProviderModelVersion(a, b);
    if (versionDelta) return versionDelta;
    const ta = providerModelReleaseTime(a);
    const tb = providerModelReleaseTime(b);
    if (ta !== tb) return tb - ta;
    return clean(a.display || a.id).localeCompare(clean(b.display || b.id));
  }
  const ta = providerModelReleaseTime(a);
  const tb = providerModelReleaseTime(b);
  if (ta !== tb) return tb - ta;
  if (a.latest !== b.latest) return a.latest ? -1 : 1;
  const versionDelta = compareProviderModelVersion(a, b);
  if (versionDelta) return versionDelta;
  return clean(a.display || a.id).localeCompare(clean(b.display || b.id));
}

export function sortProviderModels(models, primaryProvider = '') {
  return (models || []).sort((a, b) => {
    const ar = a.provider === primaryProvider ? 0 : 1;
    const br = b.provider === primaryProvider ? 0 : 1;
    if (ar !== br) return ar - br;
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return compareProviderModelRecency(a, b);
  });
}

export function isSelectableLlmModel(model) {
  const id = clean(model?.id).toLowerCase();
  const display = clean(model?.display || model?.name).toLowerCase();
  const mode = clean(model?.mode).toLowerCase();
  const text = `${id} ${display}`;
  if (!id) return false;
  if (mode && !['chat', 'completion', 'responses', 'messages'].includes(mode)) return false;
  if (/(^|[-_\s])(image|images|video|videos|audio|tts|stt|speech|embed|embedding|embeddings|rerank|reranker|realtime|moderation|imagine)([-_\s]|$)/i.test(text)) return false;
  if (/(^|[-_\s])(dall[-_\s]?e|sora|imagen)([-_\s]|$)/i.test(text)) return false;
  return true;
}

export function providerModelCacheRow(name, m, searchCapableFor) {
  return {
    id: m.id,
    provider: name,
    display: m.display || m.name || m.id,
    created: typeof m.created === 'number' ? m.created : null,
    releaseDate: m.releaseDate || null,
    contextWindow: m.contextWindow,
    outputTokens: m.outputTokens || null,
    family: m.family || null,
    tier: m.tier || null,
    latest: m.latest === true,
    description: m.description || '',
    supportsVision: m.supportsVision === true,
    supportsFunctionCalling: m.supportsFunctionCalling === true,
    supportsWebSearch: searchCapableFor(name, m),
    supportsPromptCaching: m.supportsPromptCaching === true,
    supportsReasoning: m.supportsReasoning === true,
    reasoningLevels: Array.isArray(m.reasoningLevels) ? m.reasoningLevels : undefined,
    reasoningOptions: Array.isArray(m.reasoningOptions) ? m.reasoningOptions : [],
    reasoningContentField: m.reasoningContentField || null,
    mode: m.mode || null,
  };
}
