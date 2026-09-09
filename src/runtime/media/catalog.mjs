/**
 * Studio reads provider catalogs, not the chat-only picker projection.
 * Credentials and cache storage are shared with the provider runtime. Only
 * adapter-compatible families are projected; a new endpoint needs an adapter,
 * not an optimistic entry in the picker.
 */
import { createHash } from 'node:crypto';
import { makeModelCache } from '../agent/orchestrator/providers/model-cache.mjs';
import { resolveGeminiKey, resolveXaiAuth } from './auth.mjs';
import { catalogHttpError, staleCatalog } from './catalog-errors.mjs';

const TTL_MS = 24 * 60 * 60_000;
const REQUEST_MS = 10_000;
const natural = new Intl.Collator('en', { numeric: true });

function methodsAllow(row, method) {
  return !Array.isArray(row.supportedGenerationMethods)
    || row.supportedGenerationMethods.includes(method);
}

function imageToolSupported(row, id) {
  if (row.supportsImageGeneration === false) return false;
  if (Array.isArray(row.supportedTools)) return row.supportedTools.includes('image_generation');
  if (row.supportsImageGeneration === true) return true;
  // Older Codex catalogs omit tool capabilities. Mainline GPT-5+ supports the
  // hosted image tool; specialized Codex, nano, pro and chat-only routes do not
  // inherit that contract merely by sharing the GPT prefix.
  const major = Number(id.match(/^gpt-(\d+)(?:[.-]|$)/)?.[1]);
  return major >= 5 && !/(?:^|-)(?:codex|nano|pro|chat|audio|realtime|search)(?:-|$)/i.test(id);
}

function kindFor(lane, row, id) {
  if (row.deprecated === true || row.disabled === true) return null;
  if (lane === 'openai-oauth') return imageToolSupported(row, id) ? 'image' : null;
  if (lane === 'xai' || lane === 'grok-oauth') {
    if (/^grok-imagine-image(?:-|$)/.test(id)) return 'image';
    // This version requires a start image. Studio also permits prompt-only
    // generation, so keep it out until the required-input contract is exposed.
    if (/^grok-imagine-video(?:-|$)/.test(id)
      && !/^grok-imagine-video-1\.5(?:-|$)/.test(id)) return 'video';
    return null;
  }
  if (lane === 'gemini') {
    if (/^gemini-.*(?:^|-)image(?:-|$)/.test(id)
      && methodsAllow(row, 'generateContent')) return 'image';
    if (/^gemini-omni-(?:[\d.]+-)?flash(?:-|$)/.test(id)) return 'video';
    if (/^veo-3(?:\.[\d]+)?-.*generate(?:-|$)/.test(id)
      && methodsAllow(row, 'predictLongRunning')) return 'video';
  }
  return null;
}

function version(id) {
  return (id.match(/^(?:gpt|gemini|veo)-(\d+(?:\.\d+)*)/)
    || id.match(/(?:image|video|omni)-(\d+(?:\.\d+)*)/))?.[1] || '0';
}

function compareModels(a, b) {
  return Number(/preview|experimental/.test(a.id)) - Number(/preview|experimental/.test(b.id))
    || (Number(b.created) || 0) - (Number(a.created) || 0)
    || natural.compare(version(b.id), version(a.id))
    || natural.compare(b.id, a.id);
}

/** Keep official tiers and generations intact; never infer a quality ranking. */
export function mediaModelLabel(lane, row, id) {
  let label = String(row.displayName || row.display || row.label || row.name || id).replace(/^models\//, '');
  if (lane === 'xai' || lane === 'grok-oauth') {
    label = id.replace(/^grok-imagine-image/, 'Grok Imagine Image')
      .replace(/^grok-imagine-video/, 'Grok Imagine Video')
      .replace(/-quality$/, ' Quality').replace(/-(\d)/, ' $1');
  } else if (lane === 'gemini') {
    const names = {
      'gemini-2.5-flash-image': 'Nano Banana · Gemini 2.5 Flash Image',
      'gemini-3.1-flash-image': 'Nano Banana 2 · Gemini 3.1 Flash Image',
      'gemini-3.1-flash-lite-image': 'Nano Banana 2 Lite · Gemini 3.1 Flash Lite Image',
      'gemini-3-pro-image': 'Nano Banana Pro · Gemini 3 Pro Image',
    };
    label = names[id.replace(/-preview(?:-.*)?$/, '')] || label;
  }
  if (/-preview(?:-|$)/.test(id) && !/preview/i.test(label)) label += ' (Preview)';
  if (/-experimental(?:-|$)/.test(id) && !/experimental/i.test(label)) label += ' (Experimental)';
  return label;
}

/** Project live ids while retaining only options our adapters implement. */
export function projectMediaModels(lane, rows) {
  const result = { image: [], video: [] };
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id || row?.name || '').replace(/^models\//, '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind = kindFor(lane, row, id);
    if (!kind) continue;
    let controls = {};
    if ((lane === 'xai' || lane === 'grok-oauth') && kind === 'video') {
      controls = { resolution: ['480p', '720p'] };
    } else if (lane === 'gemini' && /^gemini-omni-/.test(id)) {
      controls = { resolution: [], durations: [], maxReferences: 3 };
    }
    result[kind].push({
      id,
      label: mediaModelLabel(lane, row, id),
      controls,
      created: row.created,
    });
  }
  for (const kind of ['image', 'video']) {
    result[kind].sort(compareModels);
    // Defaults follow a current mainline/Omni model, never a dated hardcoded id.
    const preferred = result[kind].findIndex((row) => lane === 'openai-oauth'
      ? !/(?:^|-)mini(?:-|$)/.test(row.id)
      : lane === 'gemini' && kind === 'video' ? /^gemini-omni-/.test(row.id)
        : lane === 'gemini' && kind === 'image' ? !/-lite-|preview|experimental/.test(row.id) : true);
    if (preferred > 0) result[kind].unshift(...result[kind].splice(preferred, 1));
    result[kind] = result[kind].map(({ created, ...row }) => row);
  }
  if (lane === 'openai-oauth') {
    // The account catalog lists orchestrators, not selectable image engines.
    // OAuth accepts image model hints without honoring them. Expose one
    // explicitly automatic route instead of inventing Flare/Sunburst access.
    const orchestrator = result.image[0];
    result.image = orchestrator ? [{
      id: 'chatgpt-image-auto',
      label: 'ChatGPT Image · Auto',
      description: 'ChatGPT selects the image engine. GPT Image 2.5 selection and output size/quality are not verified on this connection.',
      requestModel: orchestrator.id,
      controls: { maxReferences: 5 },
    }] : [];
  }
  return result;
}

async function providerSource(lane) {
  const { getProvider, providerCatalogRevision } = await import('../agent/orchestrator/providers/registry.mjs');
  const revision = providerCatalogRevision();
  if (lane === 'openai-oauth') {
    const provider = getProvider(lane)
      || new (await import('../agent/orchestrator/providers/openai-oauth.mjs')).OpenAIOAuthProvider({});
    return {
      key: lane, revision, cache: false,
      // This is already the account's Codex catalog with its own 24h cache.
      // Do not put another TTL in front of it and hide provider refreshes.
      async fetchModels() {
        const models = await provider.listModels();
        if (!Array.isArray(models) || !models.length) throw new Error('Codex catalog unavailable');
        return models;
      },
    };
  }
  const auth = lane === 'gemini'
    ? { token: resolveGeminiKey() }
    : await resolveXaiAuth(lane);
  // API-key and OAuth catalogs must not leak availability across credentials.
  // Persist only a one-way scope hash, never a key or a bearer.
  const scope = createHash('sha256').update(auth.token).digest('hex').slice(0, 24);
  return {
    key: `${lane}-${scope}`, revision,
    fetchModels: () => fetchMediaModelRows({ lane, auth }),
  };
}

export async function fetchMediaModelRows({ lane, auth, fetchFn = fetch }) {
  const signal = AbortSignal.timeout(REQUEST_MS);
  if (lane === 'gemini') {
    const { fetchGeminiModelPages } = await import('../agent/orchestrator/providers/lib/gemini-model-catalog.mjs');
    return fetchGeminiModelPages(auth.token, async (url, init) => {
      const response = await fetchFn(url, { ...init, signal, redirect: 'error' });
      if (!response.ok) throw catalogHttpError(response.status, await response.text());
      const data = await response.json();
      if (!Array.isArray(data?.models)) throw new Error('Invalid Gemini media catalog response');
      return { ok: true, json: async () => data };
    });
  }
  const { getLlmDispatcher } = await import('../shared/llm/http-agent.mjs');
  const response = await fetchFn(`${auth.baseURL}/models`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    redirect: 'error', signal, dispatcher: getLlmDispatcher(),
  });
  if (!response.ok) throw catalogHttpError(response.status, await response.text());
  const data = await response.json();
  if (!Array.isArray(data?.data)) throw new Error('Invalid media catalog response');
  return data.data;
}

function sourceCache(key, stale = false) {
  return makeModelCache({
    fileName: `studio-models-${key}.json`,
    ttlMs: stale ? Infinity : TTL_MS,
    version: 1,
  });
}

/** TTL cache + singleflight; provider refresh epochs also invalidate live reads. */
export function createMediaModelLoader({ source = providerSource, cache = sourceCache, now = Date.now } = {}) {
  const pending = new Map();
  const revisions = new Map();
  const retryAfter = new Map();
  return async (lane) => {
    const target = await source(lane);
    const { key, revision } = target;
    if (pending.has(key)) return pending.get(key);
    const changed = revisions.has(key) && revisions.get(key) !== revision;
    const store = target.cache === false ? null : cache(key);
    const retry = retryAfter.get(key);
    if (store && retry && retry.revision === revision && now() < retry.at) {
      const previous = cache(key, true).loadSync();
      if (Array.isArray(previous)) return staleCatalog(previous, retry.error);
    }
    const cached = !changed && store?.loadSync();
    if (Array.isArray(cached)) {
      revisions.set(key, revision);
      return cached;
    }
    const request = Promise.resolve().then(() => target.fetchModels()).then((models) => {
      if (!Array.isArray(models)) throw new Error('Invalid media catalog response');
      store?.save(models);
      revisions.set(key, revision);
      retryAfter.delete(key);
      return models;
    }).catch((error) => {
      // Only this credential's last successful catalog is a safe offline
      // fallback. A successful empty catalog is authoritative, not an outage.
      const previous = store && cache(key, true).loadSync();
      if (Array.isArray(previous)) {
        // Revoked credentials and exhausted billing must not look available
        // merely because this account had a successful catalog in the past.
        if (['MEDIA_AUTH_REJECTED', 'MEDIA_ACCESS_DENIED', 'MEDIA_BILLING_BLOCKED'].includes(error.code)) throw error;
        retryAfter.set(key, { revision, at: now() + 60_000, error });
        return staleCatalog(previous, error);
      }
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}

export const loadMediaModels = createMediaModelLoader();
