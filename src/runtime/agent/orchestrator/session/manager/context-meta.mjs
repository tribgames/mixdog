// Context-window sizing, compaction target math, and session context-meta
// resolution. Extracted verbatim from manager.mjs (behavior-preserving).
import { getModelMetadataSync } from '../../providers/model-catalog.mjs';
import { resolveSessionCompactPolicy } from '../context-utils.mjs';
import {
    COMPACT_TYPE_SEMANTIC,
    COMPACT_TYPE_RECALL_FASTTRACK,
    CONTEXT_SHARE_RATIO,
    COMPACT_TARGET_MIN_TOKENS,
} from '../compact.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';

// Known context windows for the current-generation models this plugin
// routes to. Anything not listed falls through to guessContextWindow() —
// local llama/mistral/phi default to 8192, everything else 128000. Keep
// this map trimmed to live models; older generations slow down reads
// without buying anything.
const CONTEXT_WINDOWS = {
    // OpenAI GPT-5.x family (openai / openai-oauth)
    'gpt-5.5': 272000,
    'gpt-5.4': 272000,
    'gpt-5.4-mini': 272000,
    'gpt-5.4-nano': 272000,
    // Anthropic Claude 4.x
    'claude-opus-4-8': 1000000,
    'claude-opus-4-7': 1000000,
    'claude-sonnet-4-6': 1000000,
    'claude-haiku-4-5-20251001': 200000,
    // Google Gemini 3.x
    'gemini-3.1-pro': 1000000,
    'gemini-3-pro': 1000000,
    'gemini-3.5-flash': 1000000,
    'gemini-3-flash': 1000000,
    // xAI Grok (catalog polyfill mirror — model-catalog PRICING_OVERRIDES)
    'grok-build-0.1': 256000,
    'grok-4.20': 1000000,
};
// Family-pattern fallback used only when both the provider catalog and the
// exact-id table miss (cold metadata, before the LiteLLM/models.dev catalog
// warms). Keep these aligned with the catalog so /context, gateway, and the
// runtime agree on the boundary the first time a model is routed. Local models
// (llama/mistral/phi/qwen/gemma) stay small so an unknown local id never claims
// a giant window.
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llamacpp', 'llama.cpp', 'local', '']);
function guessContextWindow(model, provider = null) {
    if (CONTEXT_WINDOWS[model])
        return CONTEXT_WINDOWS[model];
    const m = String(model || '').toLowerCase();
    const p = String(provider || '').toLowerCase();
    const isLocalProvider = LOCAL_PROVIDERS.has(p);
    // Local/self-hosted families — never inflate an unknown local id.
    if (isLocalProvider && (m.includes('llama') || m.includes('mistral') || m.includes('mixtral')
        || m.includes('phi') || m.includes('qwen') || m.includes('gemma')
        || m.includes('deepseek-r1') || m.includes('codellama')))
        return 8192;
    // Current hosted families by name pattern.
    if (m.startsWith('claude-opus') || m.startsWith('claude-sonnet')) return 1000000;
    if (m.startsWith('claude-haiku') || m.startsWith('claude-')) return 200000;
    if (m.startsWith('gemini-3') || m.startsWith('gemini-2')) return 1000000;
    if (m.startsWith('gpt-5')) return 272000;
    if (m.startsWith('grok-build')) return 256000;
    if (m.startsWith('grok-')) return 1000000;
    if (m.startsWith('deepseek-v')) return 1000000;
    return 128000;
}
export function positiveContextWindow(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
export function envFlag(name, fallback = false) {
    const v = process.env[name];
    if (v === undefined) return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase());
}
function boundedPercent(value, fallback = null) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n;
    return fallback;
}
function providerNameOf(provider) {
    if (typeof provider === 'string') return provider.toLowerCase();
    return String(provider?.name || provider?.id || '').toLowerCase();
}
// Carry the percent/ratio-named buffer config from a compaction config object
// onto session.compaction so the shared compact-policy parser honors configured
// buffer
// percent/ratio. Only finite positive values are copied; absent fields stay
// undefined so the default-ratio fallback still applies.
export function preserveBufferConfigFields(cfg = {}) {
    const out = {};
    for (const key of [
        'bufferPercent', 'bufferPct', 'bufferRatio', 'bufferFraction',
        'mainBufferPercent', 'mainBufferPct', 'mainBufferRatio', 'mainBufferFraction',
    ]) {
        const n = Number(cfg?.[key]);
        if (Number.isFinite(n) && n > 0) out[key] = n;
    }
    return out;
}
function compactTargetRatio() {
    const raw = process.env.MIXDOG_AGENT_COMPACT_TARGET_PERCENT
        ?? process.env.MIXDOG_COMPACT_TARGET_PERCENT
        ?? CONTEXT_SHARE_RATIO;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return CONTEXT_SHARE_RATIO;
    return n > 1 ? n / 100 : n;
}
function compactTargetTokensForBoundary(boundaryTokens) {
    const boundary = positiveContextWindow(boundaryTokens);
    if (!boundary) return null;
    const explicit = positiveContextWindow(
        process.env.MIXDOG_AGENT_COMPACT_TARGET_TOKENS
            ?? process.env.MIXDOG_COMPACT_TARGET_TOKENS,
    );
    if (explicit) return Math.max(1, Math.min(boundary, explicit));
    const minTarget = Math.min(boundary, positiveContextWindow(process.env.MIXDOG_COMPACT_TARGET_MIN_TOKENS) || COMPACT_TARGET_MIN_TOKENS);
    const byRatio = Math.max(1, Math.floor(boundary * compactTargetRatio()));
    return Math.max(1, Math.min(boundary, Math.max(minTarget, byRatio)));
}
function defaultEffectiveContextWindowPercent(provider) {
    // The session boundary is the model's full raw window. Headroom is applied
    // by resolveSessionCompactPolicy instead: agent semantic sessions compact at
    // the buffered trigger (default 90%), while main/user recall-fasttrack
    // sessions compact on the boundary itself (100%).
    void provider;
    return 100;
}
function providerRawContextWindow(info, catalogInfo) {
    if (!info || typeof info !== 'object') return null;
    const fromApiFields = positiveContextWindow(info.context_window)
        || positiveContextWindow(info.max_context_window);
    if (fromApiFields) return fromApiFields;
    const fromCache = positiveContextWindow(info.contextWindow)
        || positiveContextWindow(info.maxContextWindow);
    const catalogWindow = positiveContextWindow(catalogInfo?.contextWindow)
        || positiveContextWindow(catalogInfo?.maxContextWindow)
        || positiveContextWindow(catalogInfo?.context_window)
        || positiveContextWindow(catalogInfo?.max_context_window);
    // Catalog/known metadata is authoritative for models present in the
    // catalog. A stale provider cache can hold an outdated window (e.g. Opus
    // 4.8 cached at 272k after its window grew to the catalog's 1M, or a
    // synthetic 1M placeholder for a smaller real model); whenever the catalog
    // disagrees with the cached snapshot, trust the catalog value rather than
    // the cache. Only live API fields (handled above) outrank the catalog.
    if (catalogWindow && fromCache !== catalogWindow) return catalogWindow;
    return fromCache || null;
}
export function resolveSessionContextMeta(provider, model, seed = {}) {
    const info = typeof provider?.getCachedModelInfo === 'function'
        ? provider.getCachedModelInfo(model)
        : null;
    const catalogInfo = getModelMetadataSync(model, providerNameOf(provider));
    const rawContextWindow = providerRawContextWindow(info, catalogInfo)
        || positiveContextWindow(catalogInfo?.contextWindow)
        || positiveContextWindow(catalogInfo?.maxContextWindow)
        || positiveContextWindow(catalogInfo?.context_window)
        || positiveContextWindow(catalogInfo?.max_context_window)
        || positiveContextWindow(seed.rawContextWindow)
        || positiveContextWindow(seed.raw_context_window)
        || positiveContextWindow(seed.contextWindow)
        || guessContextWindow(model, providerNameOf(provider));
    const effectiveContextWindowPercent = boundedPercent(
        seed.effectiveContextWindowPercent
            ?? seed.effective_context_window_percent
            ?? info?.effectiveContextWindowPercent
            ?? info?.effective_context_window_percent
            ?? catalogInfo?.effectiveContextWindowPercent
            ?? catalogInfo?.effective_context_window_percent,
        defaultEffectiveContextWindowPercent(provider),
    );
    const pct = boundedPercent(effectiveContextWindowPercent, 100);
    const contextWindow = Math.max(1, Math.floor(rawContextWindow * pct / 100));
    const compactBoundaryTokens = contextWindow;
    const rawCompactLimit = positiveContextWindow(
        seed.autoCompactTokenLimit
            ?? seed.auto_compact_token_limit
            ?? info?.autoCompactTokenLimit
            ?? info?.auto_compact_token_limit
            ?? catalogInfo?.autoCompactTokenLimit
            ?? catalogInfo?.auto_compact_token_limit,
    );
    // Legacy-data migration: old implementations derived autoCompactTokenLimit
    // from the full effective/raw window and persisted it onto the session.
    // A resumed session therefore re-seeds autoCompactTokenLimit == boundary
    // (or the raw window), which compactTriggerForSession / loop policy used to
    // honor as an explicit trigger, collapsing the compaction buffer to 0. Only
    // accept an explicit limit that is STRICTLY BELOW the boundary; a value at
    // or above the boundary is a derived full-window artifact and is dropped to
    // null so the trigger falls back to the default boundary trigger.
    const explicitCompactLimit = rawCompactLimit && rawCompactLimit < compactBoundaryTokens
        ? rawCompactLimit
        : null;
    // Do NOT derive the auto-compact limit from the full effective window.
    // Setting it to contextWindow makes autoTriggerTokens == boundary and the
    // compaction buffer collapse to 0 (loop.mjs:708-713 / compactTriggerForSession),
    // so auto-compact only fires when the context is already at the limit —
    // at which point semantic compact fails ("result exceeds budget" /
    // "summary cannot fit") and the turn can no longer be resumed.
    // Leave it null unless the provider/catalog/seed supplies an explicit
    // limit; the downstream buffer logic (default 10%, capped 25%) then
    // triggers compaction with headroom, matching the reference auto-compact threshold.
    const autoCompactTokenLimit = explicitCompactLimit || null;
    return {
        contextWindow,
        rawContextWindow,
        effectiveContextWindowPercent,
        autoCompactTokenLimit: autoCompactTokenLimit || null,
        compactBoundaryTokens,
    };
}
export function compactTriggerForSession(session, boundaryTokens) {
    // Delegates to the shared session-compaction policy (context-utils):
    // agent semantic -> 90% (default buffer), main/user -> 75% (default),
    // truly-explicit sub-boundary limit wins.
    return resolveSessionCompactPolicy(session, boundaryTokens).triggerTokens;
}
export function compactTargetBudget(boundaryTokens, reserveTokens, _sourceTokens = null, _ratio = null) {
    const boundary = positiveContextWindow(boundaryTokens);
    if (!boundary) return null;
    const reserve = Math.max(0, Number(reserveTokens) || 0);
    const targetEffective = compactTargetTokensForBoundary(boundary) || boundary;
    return Math.max(1, Math.min(boundary, targetEffective + reserve));
}
export function semanticCompactionEnabledForSession(_session) {
    // Compact types are hard-locked (agent=semantic, main=recall-fasttrack),
    // so semantic must always be available: it is the agent path AND the
    // degraded fallback when recall-fasttrack fails. Env/config off-switches
    // no longer apply.
    return true;
}
export function compactTypeForSession(session) {
    // Hard-locked: agent-owned sessions are always semantic, all other
    // (main/user) sessions are always recall-fasttrack. Env/config overrides
    // no longer change the type.
    return isAgentOwner(session) ? COMPACT_TYPE_SEMANTIC : COMPACT_TYPE_RECALL_FASTTRACK;
}
