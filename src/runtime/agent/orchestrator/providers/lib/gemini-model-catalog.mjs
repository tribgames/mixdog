import { getLlmDispatcher } from '../../../../shared/llm/http-agent.mjs';
import { makeModelCache } from '../model-cache.mjs';

export const GEMINI_MODELS = [
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', provider: 'gemini', contextWindow: 1048576 },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', provider: 'gemini', contextWindow: 1048576 },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', provider: 'gemini', contextWindow: 1048576 },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', contextWindow: 1048576 },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', contextWindow: 1048576 },
];

export const DEFAULT_GEMINI_MODEL = GEMINI_MODELS[0].id;

export const geminiModelCache = makeModelCache({
    fileName: 'gemini-models.json',
    ttlMs: 24 * 60 * 60_000,
    version: 2,
});

export async function fetchGeminiModelPages(apiKey, fetchFn = fetch) {
    const items = [];
    let pageToken = '';
    do {
        const params = new URLSearchParams({ key: apiKey, pageSize: '1000' });
        if (pageToken) params.set('pageToken', pageToken);
        const url = `https://generativelanguage.googleapis.com/v1beta/models?${params}`;
        const res = await fetchFn(url, {
            signal: AbortSignal.timeout(60_000),
            dispatcher: getLlmDispatcher(),
        });
        if (!res.ok) throw new Error(`gemini list_models ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data?.models)) items.push(...data.models);
        pageToken = typeof data?.nextPageToken === 'string' ? data.nextPageToken : '';
    } while (pageToken);
    return items;
}

function compareVersion(a, b) {
    const na = (a.match(/gemini-(\d+)(?:\.(\d+))?/) || []).slice(1).map(Number);
    const nb = (b.match(/gemini-(\d+)(?:\.(\d+))?/) || []).slice(1).map(Number);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0);
    }
    return a.localeCompare(b);
}

function markLatest(models) {
    const byFamily = new Map();
    for (const model of models) {
        if (!model?.id) continue;
        const current = byFamily.get(model.family);
        if (!current || compareVersion(model.id, current.id) > 0) {
            byFamily.set(model.family, model);
        }
    }
    for (const model of byFamily.values()) model.latest = true;
}

export function resolveLatestGeminiModel() {
    const cached = geminiModelCache.loadSync();
    if (!Array.isArray(cached)) return null;
    let best = null;
    for (const model of cached) {
        if (!model?.id || model.family !== 'gemini-flash') continue;
        if (!best || compareVersion(model.id, best.id) > 0) best = model;
    }
    return best?.id || null;
}

export async function ensureLatestGeminiModel(provider) {
    let model = resolveLatestGeminiModel();
    if (model) return model;
    await provider._refreshModelCache();
    model = resolveLatestGeminiModel();
    if (model) return model;
    throw new Error('[gemini] model catalog unavailable after warmup — cannot resolve default model');
}

export async function fetchAndCacheGeminiModels({
    apiKey,
    fetchFn,
    modelCache,
    catalogForceRefresh,
}) {
    const items = await fetchGeminiModelPages(apiKey, fetchFn);
    const normalized = items
        .filter(model => (model?.name || '').includes('gemini'))
        .filter(model => !Array.isArray(model?.supportedGenerationMethods)
            || model.supportedGenerationMethods.includes('generateContent'))
        .filter(model => !/embedding|aqa|imagen|robotics|computer-use/.test(model?.name || ''))
        .map(model => {
            const id = (model.name || '').replace(/^models\//, '');
            const family = /flash-lite/.test(id) ? 'gemini-flash-lite'
                : /flash/.test(id) ? 'gemini-flash'
                : /pro/.test(id) ? 'gemini-pro'
                : 'gemini';
            return {
                id,
                display: model.displayName || id,
                family,
                provider: 'gemini',
                contextWindow: model.inputTokenLimit || null,
                outputTokens: model.outputTokenLimit || null,
                tier: 'version',
                latest: false,
                description: model.description || '',
            };
        });
    markLatest(normalized);
    const { enrichModels } = await import('../model-catalog.mjs');
    const { sanitizeModelList } = await import('../model-list-sanitize.mjs');
    const enriched = sanitizeModelList(await enrichModels(normalized, {
        fetchFn,
        force: catalogForceRefresh === true,
    }), { provider: 'gemini' });
    modelCache.save(enriched);
    return enriched;
}
