import { resolveProviderApiKey } from '../../../shared/provider-api-key.mjs';
import { enrichModels } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { PROVIDER_GENERATE_TOTAL_TIMEOUT_MS, createTimeoutSignal, resolveTimeoutMs } from '../stall-policy.mjs';
import { CUSTOM_EFFORT_LEVELS, normalizeCustomEffort } from './custom-reasoning.mjs';

const MODEL_LIST_TIMEOUT_MS = resolveTimeoutMs('MIXDOG_COMPAT_MODEL_LIST_TIMEOUT_MS', 10_000, {
  minMs: 1_000,
  maxMs: PROVIDER_GENERATE_TOTAL_TIMEOUT_MS,
});

/** Preserve endpoint-declared effort levels without inventing a default ladder. */
export function extractCompatReasoningEffort(model) {
  if (!model || typeof model !== 'object') return null;
  const rawLevels = [
    model.reasoning_efforts,
    model.reasoning_levels,
    model.reasoningLevels,
    model.capabilities?.reasoning_efforts,
    model.capabilities?.reasoning_effort,
  ].find(Array.isArray);
  if (rawLevels) {
    const declared = new Set(
      rawLevels
        .map((level) => (typeof level === 'string' ? level : level?.value))
        .filter((level) => typeof level === 'string')
        .map(normalizeCustomEffort)
        .filter(Boolean)
    );
    const levels = CUSTOM_EFFORT_LEVELS.filter((level) => declared.has(level));
    if (levels.length > 0) {
      return {
        supportsReasoning: levels.some((level) => level !== 'none'),
        reasoningLevels: levels,
        reasoningOptions: [{ type: 'effort', values: [...levels] }],
      };
    }
    return null;
  }
  if (
    model.supports_reasoning_effort === true ||
    model.capabilities?.reasoning_effort === true ||
    model.capabilities?.reasoning_efforts === true
  ) {
    return { supportsReasoning: true };
  }
  return null;
}

// `keyless` omits the Authorization header entirely (keyless endpoints);
// `signal` aborts the request together with the list timeout.
export async function fetchCompatModelItems(provider, { signal = null, keyless = false } = {}) {
  const name = provider.name;
  const timeout = createTimeoutSignal(signal, MODEL_LIST_TIMEOUT_MS, `${name} model list`);
  try {
    const res = await fetch(`${String(provider.baseURL || '').replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: {
        ...(keyless
          ? {}
          : { Authorization: `Bearer ${resolveProviderApiKey(name, provider.config || provider) || 'no-key'}` }),
        ...(provider.defaultHeaders || {}),
      },
      signal: timeout.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`${provider.name} models ${res.status}`), { status: res.status });
    const data = await res.json();
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data)) return data;
    return [];
  } finally {
    timeout.cleanup();
  }
}

// Provider-native chat-ness: Together `type`, Mistral `capabilities`. Returns a
// sanitize-compatible mode, or null when the listing says nothing.
function nativeMode(m) {
  const type = typeof m?.type === 'string' ? m.type.trim().toLowerCase() : '';
  if (type === 'chat') return 'chat';
  if (type === 'language' || type === 'code') return 'completion';
  if (['embedding', 'embeddings', 'image', 'audio', 'rerank', 'moderation', 'video', 'transcribe'].includes(type)) {
    return type;
  }
  // OpenRouter: a model that cannot emit text (image/audio generation) is no chat model.
  const outputs = m?.architecture?.output_modalities;
  if (Array.isArray(outputs) && outputs.length && !outputs.includes('text')) return 'non_chat';
  const caps = m?.capabilities;
  if (caps && typeof caps === 'object' && typeof caps.completion_chat === 'boolean') {
    return caps.completion_chat ? 'chat' : 'non_chat';
  }
  return null;
}

export async function listCompatModels(provider, { throwOnError = false, signal = null } = {}) {
  try {
    const list = await provider._fetchModelItems({ signal });
    const models = [];
    for (const m of list) {
      const contextWindow = Number(
        m?.context_window ??
          m?.max_context_window ??
          m?.max_input_tokens ??
          m?.max_model_len ??
          m?.context_length ??
          m?.max_context_length ??
          m?.top_provider?.context_length ??
          m?.contextWindow ??
          0
      );
      const outputTokens = Number(
        m?.max_output_tokens ??
          m?.output_tokens ??
          m?.maxOutputTokens ??
          m?.top_provider?.max_completion_tokens ??
          0
      );
      const mode = nativeMode(m);
      // A catalog alias (OpenRouter `~anthropic/claude-opus-latest`) keeps its
      // own slug for routing; the slug it currently points at is retained for
      // capability lookup only.
      const aliasTarget = typeof m?.alias_target === 'string' ? m.alias_target : m?.alias_target?.slug;
      const effortInfo = extractCompatReasoningEffort(m);
      models.push({
        id: m?.id,
        name: m?.id,
        provider: provider.name,
        contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
        outputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : null,
        created: typeof m?.created === 'number' ? m.created : null,
        ...(mode ? { mode } : {}),
        ...(typeof aliasTarget === 'string' && aliasTarget ? { aliasTarget } : {}),
        ...(effortInfo || {}),
      });
    }
    const filtered = models.filter((m) => m.id);
    // The catalog fills gaps only: native limits and chat-ness are restored
    // over whatever enrichment derived.
    const enrichedRows = (await enrichModels(filtered)).map((row, i) => {
      const native = filtered[i];
      return {
        ...row,
        ...(native.contextWindow ? { contextWindow: native.contextWindow } : {}),
        ...(native.outputTokens ? { outputTokens: native.outputTokens } : {}),
        ...(native.mode ? { mode: native.mode } : {}),
      };
    });
    const enriched = sanitizeModelList(enrichedRows, { provider: provider.name });
    provider._enrichedModels = enriched;
    return enriched;
  } catch (error) {
    if (throwOnError) throw error;
    return [];
  }
}

export async function isCompatProviderAvailable(provider) {
  try {
    await provider._fetchModelItems();
    return true;
  } catch {
    return false;
  }
}

export function getCachedCompatModelInfo(provider, model) {
  if (Array.isArray(provider._enrichedModels)) {
    return provider._enrichedModels.find((m) => m.id === model) || null;
  }
  return null;
}
