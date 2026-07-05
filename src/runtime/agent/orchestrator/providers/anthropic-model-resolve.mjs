/**
 * anthropic-model-resolve.mjs — Anthropic OAuth model-catalog cache + resolvers.
 *
 * Extracted from anthropic-oauth.mjs. Owns the disk-backed catalog cache and
 * its in-memory mirror (single instance; the provider imports every reader/
 * writer from here so there is exactly ONE catalog state in the process).
 */
import { enrichModels } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { makeModelCache } from './model-cache.mjs';
import { effortValuesForModel } from './anthropic-effort.mjs';

// Disk-backed cache so repeated process starts (cron, tool calls) don't
// hammer /v1/models. 24h TTL matches the upstream client cadence.
const MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;
// Bump when the on-disk cache shape changes so stale-shape entries are
// discarded instead of misread.
const ANTHROPIC_MODEL_CACHE_SCHEMA_VERSION = 1;

const _modelCache = makeModelCache({
    fileName: 'anthropic-oauth-models.json',
    ttlMs: MODEL_CACHE_TTL_MS,
    version: ANTHROPIC_MODEL_CACHE_SCHEMA_VERSION,
    onSave: (m) => { _inMemoryCatalog = Array.isArray(m) ? m.slice() : null; },
});

// Async wrappers so callers can keep awaiting; the shared cache CRUD is sync.
export async function _loadModelCache() {
    return _modelCache.loadSync();
}

export async function _saveModelCache(models) {
    _modelCache.save(models);
}

// In-memory mirror of the disk catalog — populated on first listModels() and
// refreshed after every _saveModelCache. Used by _catalogHas and _displayModel
// so hot paths don't hit disk on every response.
let _inMemoryCatalog = null;

// The mirror is written both by this module (onSave) and by the provider's
// listModels() warm path, so expose a setter instead of the raw binding.
export function _setInMemoryCatalog(models) {
    _inMemoryCatalog = Array.isArray(models) ? models.slice() : null;
}

export function _catalogHas(id) {
    if (!id || !Array.isArray(_inMemoryCatalog)) return false;
    return _inMemoryCatalog.some(m => m.id === id);
}

// Display-name normalization for trace / usage. Turns dated or version-alias
// ids into the version alias form: claude-opus-4-7 → claude-opus-4.7,
// claude-haiku-4-5-20251001 → claude-haiku-4.5. Falls back to the raw id.
export function _displayModel(id) {
    if (!id || typeof id !== 'string') return id;
    const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i);
    if (!m) return id;
    return `claude-${m[1].toLowerCase()}-${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

function _capabilitySupported(capability) {
    return capability === true || capability?.supported === true;
}

// Classify a model id into our common tier/family shape. Anthropic's catalog
// mixes dated ids (claude-opus-4-5-20251101), versioned aliases
// (claude-opus-4-6), and the raw family tokens resolved via env vars.
export function _normalizeAnthropicModel(raw) {
    const id = raw?.id || raw?.name;
    if (!id) return null;
    const familyMatch = id.match(/^claude-([a-z]+)/i);
    const family = familyMatch ? familyMatch[1].toLowerCase() : 'other';
    // Dated: trailing -YYYYMMDD (8 digits).
    const dated = /-\d{8}$/.test(id);
    // Versioned alias: claude-<family>-<major>-<minor>[-...] with no dated suffix.
    const versioned = !dated && /^claude-[a-z]+-\d+(?:-\d+)?$/i.test(id);
    const tier = dated ? 'dated' : versioned ? 'version' : 'family';
    const releaseDate = dated
        ? id.match(/-(\d{4})(\d{2})(\d{2})$/)
        : null;
    const effortValues = effortValuesForModel(raw?.capabilities, id);
    return {
        id,
        display: raw?.display_name || _prettyName(id, family),
        family,
        provider: 'anthropic-oauth',
        contextWindow: raw?.context_window || raw?.max_context_window || raw?.max_input_tokens || _defaultContextForModel(id, family),
        outputTokens: raw?.max_tokens || raw?.max_output_tokens || null,
        tier,
        latest: false, // assigned in a second pass once full list is known
        releaseDate: releaseDate ? `${releaseDate[1]}-${releaseDate[2]}-${releaseDate[3]}` : null,
        supportsReasoning: effortValues.length > 0 || _capabilitySupported(raw?.capabilities?.thinking),
        reasoningOptions: effortValues.length ? [{ type: 'effort', values: effortValues }] : [],
    };
}

function _prettyName(id, family) {
    const v = id.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i);
    const base = family[0].toUpperCase() + family.slice(1);
    return v ? `${base} ${v[1]}${v[2] ? `.${v[2]}` : ''}` : base;
}

function _defaultContextForModel(id, family) {
    const text = String(id || '');
    const version = text.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i);
    if (Number(version?.[1] || 0) >= 5) return 1000000;
    if (/^claude-(opus|sonnet)-4-(6|7|8)(?:$|-)/i.test(text)) return 1000000;
    if (family && family !== 'other') return 200000;
    return 200000;
}

// Mark the highest-numbered version per family as `latest: true`. Uses a simple
// lexicographic comparison on the numeric parts embedded in the id.
export function _markLatestByFamily(models) {
    const byFamily = new Map();
    for (const m of models) {
        if (m.tier !== 'version') continue;
        const cur = byFamily.get(m.family);
        if (!cur || _compareVersion(m.id, cur.id) > 0) {
            byFamily.set(m.family, m);
        }
    }
    for (const m of byFamily.values()) m.latest = true;
}

function _compareVersion(a, b) {
    const na = (a.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i) || []).slice(1).map(Number);
    const nb = (b.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i) || []).slice(1).map(Number);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0);
    }
    return a.localeCompare(b);
}

// Newest HIGH-TIER chat model by version, read from the SYNC in-memory catalog
// mirror. Anthropic ships three families: opus / sonnet / haiku. "Latest" is the
// highest version across opus + sonnet only — haiku is the cheap tier and is
// never the flagship default. Returns null until listModels() populates the
// mirror; callers must warm the catalog (ensureLatestAnthropicModel) when null.
export function resolveLatestAnthropicModel() {
    if (!Array.isArray(_inMemoryCatalog)) return null;
    let best = null;
    for (const m of _inMemoryCatalog) {
        if (!m?.id || (m.family !== 'opus' && m.family !== 'sonnet')) continue;
        if (!best || _compareVersion(m.id, best.id) > 0) best = m;
    }
    return best?.id || null;
}

export function resolveAnthropicModelAfter404(requested) {
    if (!Array.isArray(_inMemoryCatalog)) return null;
    const wanted = String(requested || '');
    const family = (wanted.match(/^claude-([a-z]+)/i) || [])[1]?.toLowerCase() || null;
    let best = null;
    for (const m of _inMemoryCatalog) {
        if (!m?.id) continue;
        if (family && m.family !== family) continue;
        if (!family && m.family !== 'opus' && m.family !== 'sonnet') continue;
        if (!best || _compareVersion(m.id, best.id) > 0) best = m;
    }
    if (best?.id && best.id !== wanted) return best.id;
    if (family === 'opus') {
        const flagship = resolveLatestAnthropicModel();
        if (flagship && flagship !== wanted) return flagship;
    }
    return null;
}

export async function ensureLatestAnthropicModel(provider) {
    let m = resolveLatestAnthropicModel();
    if (m) return m;
    await provider._refreshModelCache();
    m = resolveLatestAnthropicModel();
    if (m) return m;
    throw new Error('[anthropic-oauth] model catalog unavailable after warmup — cannot resolve default model');
}

// Catalog-reported outputTokens for a model id, read from the in-memory
// catalog mirror (lazily populated from the disk cache if the mirror hasn't
// been warmed yet by listModels()). Never throws — any failure just means
// "no catalog data", and callers fall back to the static heuristics.
export function _catalogOutputTokens(model) {
    if (!model) return null;
    try {
        if (!Array.isArray(_inMemoryCatalog)) {
            const cached = _modelCache.loadSync();
            if (Array.isArray(cached)) _inMemoryCatalog = cached.slice();
        }
        if (!Array.isArray(_inMemoryCatalog)) return null;
        const entry = _inMemoryCatalog.find(m => m?.id === model);
        const out = Number(entry?.outputTokens);
        return Number.isFinite(out) && out > 0 ? out : null;
    } catch {
        return null;
    }
}

// Normalize + mark-latest + LiteLLM-enrich + persist one fetched /v1/models
// payload. Shared by the provider's listModels() and _refreshModelCache().
export async function normalizeAndSaveCatalog(items) {
    const normalized = (Array.isArray(items) ? items : [])
        .map(m => _normalizeAnthropicModel(m))
        .filter(Boolean);
    _markLatestByFamily(normalized);
    const enriched = sanitizeModelList(await enrichModels(normalized), { provider: 'anthropic' });
    await _saveModelCache(enriched);
    return enriched;
}
