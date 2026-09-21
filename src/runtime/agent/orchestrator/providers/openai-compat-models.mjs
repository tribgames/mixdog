import { enrichModels } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { PROVIDER_GENERATE_TOTAL_TIMEOUT_MS, createTimeoutSignal, resolveTimeoutMs } from '../stall-policy.mjs';

const MODEL_LIST_TIMEOUT_MS = resolveTimeoutMs('MIXDOG_COMPAT_MODEL_LIST_TIMEOUT_MS', 10_000, {
  minMs: 1_000,
  maxMs: PROVIDER_GENERATE_TOTAL_TIMEOUT_MS,
});

export async function fetchCompatModelItems(provider) {
  const timeout = createTimeoutSignal(null, MODEL_LIST_TIMEOUT_MS, `${provider.name} model list`);
  try {
    const res = await fetch(`${String(provider.baseURL || '').replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${provider.apiKey || 'no-key'}`,
        ...(provider.defaultHeaders || {}),
      },
      signal: timeout.signal,
    });
    if (!res.ok) throw new Error(`${provider.name} models ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data)) return data;
    return [];
  } finally {
    timeout.cleanup();
  }
}

export async function listCompatModels(provider) {
  try {
    const list = await provider._fetchModelItems();
    const models = [];
    for (const m of list) {
      const contextWindow = Number(
        m?.context_window ??
          m?.max_context_window ??
          m?.max_input_tokens ??
          m?.max_model_len ??
          m?.context_length ??
          m?.contextWindow ??
          0
      );
      const outputTokens = Number(m?.max_output_tokens ?? m?.output_tokens ?? m?.maxOutputTokens ?? 0);
      models.push({
        id: m?.id,
        name: m?.id,
        provider: provider.name,
        contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
        outputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : null,
        created: typeof m?.created === 'number' ? m.created : null,
      });
    }
    const filtered = models.filter((m) => m.id);
    const enriched = sanitizeModelList(await enrichModels(filtered), { provider: provider.name });
    provider._enrichedModels = enriched;
    return enriched;
  } catch {
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
