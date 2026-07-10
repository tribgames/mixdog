/*
 * model-options.mjs — pure model/route label, ordering, and picker-item helpers.
 *
 * Extracted verbatim from App.jsx. No React, no engine state — every function
 * is a pure transform over model records / route objects. Depends only on the
 * shared theme palette and the displayModelName formatter.
 */
import { theme } from '../theme.mjs';
import { displayModelName } from '../../ui/model-display.mjs';

export const parsedModelVersion = (id) => {
  const text = String(id || '').toLowerCase();
  const claude = text.match(/^claude-[a-z]+-(\d+)(?:[-.](\d+))?/);
  if (claude) return [Number(claude[1]) || 0, Number(claude[2]) || 0];
  const compact = text.match(/(?:^|[-_])(?:o|gpt|grok|qwen|llama|mistral|gemma|phi|glm)(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/);
  if (compact) return compact.slice(1).filter((v) => v != null).map((v) => Number(v) || 0);
  const generic = text.match(/(?:^|[-_v])(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/);
  if (!generic) return [];
  return generic.slice(1).filter((v) => v != null).map((v) => Number(v) || 0);
};

export const releaseTime = (m) => {
  if (m?.releaseDate) {
    const t = Date.parse(m.releaseDate);
    if (Number.isFinite(t)) return t;
  }
  const created = Number(m?.created);
  if (Number.isFinite(created) && created > 0) {
    return created < 1_000_000_000_000 ? created * 1000 : created;
  }
  const dated = String(m?.id || '').match(/(?:^|-)(\d{4})(\d{2})(\d{2})(?:$|-)/);
  if (!dated) return 0;
  return Date.parse(`${dated[1]}-${dated[2]}-${dated[3]}`) || 0;
};

export const isClaudeModel = (m) => {
  const provider = String(m?.provider || '').toLowerCase();
  const id = String(m?.id || '').toLowerCase();
  return provider.includes('anthropic') && /^claude-[a-z]+-/.test(id);
};

export const modelVersion = (m) => {
  const fromId = parsedModelVersion(m?.id);
  return fromId.length ? fromId : parsedModelVersion(m?.display || m?.name);
};

export const compareModelVersion = (a, b) => {
  const va = modelVersion(a);
  const vb = modelVersion(b);
  if (va.length === 0 && vb.length === 0) return 0;
  if (va.length === 0) return 1;
  if (vb.length === 0) return -1;
  for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
    const delta = (vb[i] || 0) - (va[i] || 0);
    if (delta) return delta;
  }
  return 0;
};

export const compareModelRecency = (a, b) => {
  if (isClaudeModel(a) && isClaudeModel(b)) {
    if (!!a?.latest !== !!b?.latest) return a?.latest ? -1 : 1;
    const versionDelta = compareModelVersion(a, b);
    if (versionDelta) return versionDelta;
    const ta = releaseTime(a);
    const tb = releaseTime(b);
    if (ta !== tb) return tb - ta;
    return String(a?.display || a?.id || '').localeCompare(String(b?.display || b?.id || ''));
  }

  const ta = releaseTime(a);
  const tb = releaseTime(b);
  const versionDelta = compareModelVersion(a, b);
  // Release dates win only when both sides have one; sparse OAuth catalogs
  // must not sink undated (often newest) models below dated/latest ones.
  if (ta > 0 && tb > 0 && ta !== tb) return tb - ta;
  if (versionDelta) return versionDelta;
  if (!!a?.latest !== !!b?.latest) return a?.latest ? -1 : 1;
  if (ta !== tb) return tb - ta;
  return String(a?.display || a?.id || '').localeCompare(String(b?.display || b?.id || ''));
};

export const modelFamily = (m) => {
  const text = String(m?.id || m?.display || '').toLowerCase();
  const claude = text.match(/^claude-([a-z]+)/);
  if (claude) return claude[1];
  if (m?.family) return String(m.family).toLowerCase();
  const first = text.match(/^[a-z]+(?:-[a-z]+)?/);
  return first ? first[0] : 'model';
};

export const modelContextWindow = (m) => {
  const raw = Number(m?.contextWindow);
  const n = Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (n > 0) return n;
  const provider = String(m?.provider || '').toLowerCase();
  const id = String(m?.id || '').toLowerCase();
  const version = parsedModelVersion(id);
  if (provider.includes('anthropic') && /^claude-[a-z]+-/.test(id)) {
    if ((version[0] || 0) >= 5) return Math.max(n, 1_000_000);
    if (/^claude-(opus|sonnet)-4-(6|7|8)(?:$|-)/.test(id)) return Math.max(n, 1_000_000);
  }
  return n;
};

export const formatContextWindow = (tokens) => {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return '';
  // Some providers (Gemini) report binary windows (1_048_576 / 131_072);
  // display exact powers of two with 1024-based units so they read
  // 1M / 128k, not 1.049M / 131k. (Power-of-two check avoids misfiring on
  // decimal windows like 128_000 that happen to divide by 1024.)
  const unit = n >= 1024 && (n & (n - 1)) === 0 ? 1024 : 1000;
  const mega = unit * unit;
  if (n >= mega) {
    const m = n / mega;
    const label = Number.isInteger(m)
      ? m.toFixed(0)
      : m.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return `${label}M Context`;
  }
  return `${Math.round(n / unit)}k Context`;
};

export const modelFamilyLimit = (provider, family) => {
  const p = String(provider || '').toLowerCase();
  if (!p.includes('anthropic')) return 8;
  if (family === 'opus') return 3;
  return 1;
};

export const normalizeModelOptions = (models) => {
  if (!Array.isArray(models)) return [];
  const providers = new Map();
  for (const model of models) {
    if (!model?.provider || !model?.id) continue;
    if (!providers.has(model.provider)) providers.set(model.provider, new Map());
    const families = providers.get(model.provider);
    const family = modelFamily(model);
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(model);
  }

  const normalized = [];
  for (const [provider, families] of providers.entries()) {
    const providerModels = [];
    for (const [family, group] of families.entries()) {
      const limit = modelFamilyLimit(provider, family);
      providerModels.push(...group.slice().sort(compareModelRecency).slice(0, limit));
    }
    normalized.push(...providerModels.sort(compareModelRecency));
  }
  return normalized;
};

export const providerDisplayName = (provider) => {
  const key = String(provider || '').toLowerCase();
  if (key === 'openai-oauth') return 'OpenAI OAuth';
  if (key === 'anthropic-oauth') return 'Anthropic OAuth';
  if (key === 'grok-oauth') return 'Grok OAuth';
  if (key === 'openai' || key === 'openai-api') return 'OpenAI API';
  if (key === 'anthropic' || key === 'anthropic-api') return 'Anthropic API';
  if (key === 'gemini' || key === 'gemini-api') return 'Gemini API';
  if (key === 'xai' || key === 'xai-api') return 'xAI API';
  if (key === 'deepseek' || key === 'deepseek-api') return 'DeepSeek API';
  if (key === 'opencode-go') return 'OpenCode Go API';
  if (key === 'ollama') return 'Ollama';
  if (key === 'lmstudio') return 'LM Studio';
  if (key === 'default') return 'Default';
  return provider || 'Provider';
};

export const providerDisplayRank = (provider) => {
  const key = String(provider || '').toLowerCase();
  const ranks = {
    default: 0,
    'openai-oauth': 10,
    'anthropic-oauth': 20,
    'grok-oauth': 30,
    'opencode-go': 35,
    openai: 40,
    'openai-api': 40,
    anthropic: 50,
    'anthropic-api': 50,
    gemini: 60,
    'gemini-api': 60,
    xai: 70,
    'xai-api': 70,
    deepseek: 90,
    'deepseek-api': 90,
    ollama: 100,
    lmstudio: 110,
  };
  return ranks[key] ?? 900;
};

export const titleCaseOption = (value) => String(value || '')
  .split(/([\s_-]+)/)
  .map((part) => /^[\s_-]+$/.test(part) ? part : `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
  .join('');

export const effortDisplayLabel = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.toLowerCase() === 'xhigh') return 'XHigh';
  return titleCaseOption(text);
};

export const fastDisplayLabel = (enabled = true) => `Fast ${enabled ? 'On' : 'Off'}`;

export const modelDescription = (m) => [formatContextWindow(modelContextWindow(m)) || '-', m.fastCapable ? 'Fast Available' : ''].filter(Boolean).join(' · ');

export const modelRecordDisplayName = (model) => displayModelName(
  model?.id,
  model?.provider,
  model?.display || model?.name,
);

export const routeModelDisplayName = (route) => displayModelName(route?.model, route?.provider);

export const groupModelsByProvider = (models) => {
  const providers = new Map();
  for (const model of models) {
    if (!providers.has(model.provider)) providers.set(model.provider, []);
    providers.get(model.provider).push(model);
  }

  const orderedProviders = [...providers.keys()].sort((a, b) => {
    const rank = providerDisplayRank(a) - providerDisplayRank(b);
    if (rank !== 0) return rank;
    const label = providerDisplayName(a).localeCompare(providerDisplayName(b));
    if (label !== 0) return label;
    return a.localeCompare(b);
  });
  return { providers, orderedProviders };
};

export const buildModelProviderItems = (models, currentRoute = null) => {
  const { providers, orderedProviders } = groupModelsByProvider(models);
  return orderedProviders.map((provider) => {
    const providerModels = providers.get(provider) || [];
    const currentModel = currentRoute?.provider === provider
      ? providerModels.find((model) => model.id === currentRoute.model)
      : null;
    return {
      value: `provider:${provider}`,
      label: providerDisplayName(provider),
      marker: currentModel ? '✓' : '',
      markerColor: theme.success,
      meta: currentModel ? modelRecordDisplayName(currentModel) : '',
      description: `${providerModels.length} model${providerModels.length === 1 ? '' : 's'}`,
      _action: 'open-provider',
      _provider: provider,
    };
  });
};

export const buildProviderModelItems = (models, provider, currentRoute = null) => {
  const providerModels = models.filter((model) => model.provider === provider);
  return providerModels.map((model) => ({
    value: `model:${model.provider}:${model.id}`,
    label: modelRecordDisplayName(model),
    marker: currentRoute?.provider === model.provider && currentRoute?.model === model.id ? '✓' : '',
    markerColor: theme.success,
    description: modelDescription(model),
    _action: 'select-model',
    _provider: model.provider,
    _modelId: model.id,
    _model: model,
  }));
};

export const routeLabel = (route) => {
  if (!route?.provider || !route?.model) return '(unset)';
  return [
    providerDisplayName(route.provider),
    routeModelDisplayName(route),
    route.effort ? effortDisplayLabel(route.effort) : '',
    route.fast ? 'Fast' : '',
  ].filter(Boolean).join(' · ');
};

export const routeModelLabel = (route) => {
  if (!route?.model) return '(unset)';
  return [
    routeModelDisplayName(route),
    route.effort ? effortDisplayLabel(route.effort) : '',
    route.fast ? 'Fast' : '',
  ].filter(Boolean).join(' · ');
};

export const agentModelProfile = (route) => {
  if (!route?.model) return '';
  return [
    routeModelDisplayName(route),
    route.effort ? effortDisplayLabel(route.effort) : '',
    route.fast ? 'Fast' : '',
  ].filter(Boolean).join(' · ');
};

export const agentModelParts = (route) => [
  { text: route?.model ? routeModelDisplayName(route) : '', width: 17 },
  { text: route?.effort ? effortDisplayLabel(route.effort) : '', width: 6 },
  { text: route?.fast ? 'Fast' : '', width: 4 },
];

export const routeFromModel = (model, effort = null) => ({
  provider: model.provider,
  model: model.id,
  ...(effort && effort !== 'auto' ? { effort } : {}),
});

export const modelScore = (model, slot) => {
  const text = `${model.provider} ${model.id} ${model.display} ${model.family || ''} ${model.tier || ''}`.toLowerCase();
  let score = 0;
  if (model.latest) score += 6;
  if (slot === 'lead' || slot === 'review') {
    if (/opus|gpt-5\.5|gpt-5|sonnet/.test(text)) score += 20;
    if (/mini|nano|haiku|flash/.test(text)) score -= 5;
  } else if (slot === 'memory') {
    if (/haiku|mini|nano|flash|fast/.test(text)) score += 20;
    if (/opus|max/.test(text)) score -= 4;
  } else if (slot === 'explorer' || slot === 'agent') {
    if (/sonnet|gpt-5|mini|haiku|flash/.test(text)) score += 12;
    if (/opus/.test(text)) score += slot === 'agent' ? 3 : -2;
  }
  if (model.supportsFunctionCalling) score += 2;
  return score;
};

export const chooseRecommendedModel = (models, slot, fallbackRoute) => {
  if (!Array.isArray(models) || models.length === 0) return null;
  const sorted = models.slice().sort((a, b) => modelScore(b, slot) - modelScore(a, slot));
  return sorted[0] ? routeFromModel(sorted[0]) : (fallbackRoute || null);
};

export const buildWorkflowDefaults = (models, defaultRoute) => ({
  lead: defaultRoute,
  agent: chooseRecommendedModel(models, 'agent', defaultRoute),
  explorer: chooseRecommendedModel(models, 'explorer', defaultRoute),
  memory: chooseRecommendedModel(models, 'memory', defaultRoute),
});
