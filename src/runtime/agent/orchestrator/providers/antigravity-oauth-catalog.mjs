/**
 * Antigravity model catalog and quota.
 *
 * Cloud Code Assist publishes the account's models through
 * `fetchAvailableModels`: one wire id per thinking tier ("gemini-3.8-flash-high",
 * "-medium", "-low") labelled "Gemini 3.8 Flash (High)", plus per-model quota.
 * Mixdog's picker shows one model with an effort control, so the tiers of a
 * family collapse into one record whose `wire` map turns the chosen effort
 * back into the wire id. The list is cached on disk like the other OAuth
 * catalogs; the curated list in the tokens module is the offline fallback.
 */
import { makeModelCache } from './model-cache.mjs';
import {
    ANTIGRAVITY_MODELS,
    PROJECT_ENDPOINT,
    antigravityHeaders,
    _scrubTokens,
} from './antigravity-oauth-tokens.mjs';

export const ANTIGRAVITY_MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const ANTIGRAVITY_MODEL_CACHE_VERSION = 1;
const FETCH_MODELS_TIMEOUT_MS = 15_000;
// Tier labels the gateway puts in parentheses, in effort order.
const TIER_EFFORTS = { 'extra low': 'minimal', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' };
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high'];
// IDE-internal completion/chat models are listed without a display name.
const INTERNAL_ID = /^(?:chat|tab)_/;
// Bare Gemini 3 ids take the ordinary thinkingLevel field instead of a tier id.
const BARE_GEMINI3_LEVELS = Object.freeze(['low', 'medium', 'high']);

let _mirror = null;
export const antigravityModelCache = makeModelCache({
    fileName: 'antigravity-oauth-models.json',
    ttlMs: ANTIGRAVITY_MODEL_CACHE_TTL_MS,
    version: ANTIGRAVITY_MODEL_CACHE_VERSION,
    onSave: (models) => { _mirror = models; },
});

export async function fetchAvailableModels({ accessToken, projectId, fetchFn = fetch, signal = null }) {
    const timeout = AbortSignal.timeout(FETCH_MODELS_TIMEOUT_MS);
    const res = await fetchFn(`${PROJECT_ENDPOINT}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...antigravityHeaders(),
        },
        body: JSON.stringify(projectId ? { project: projectId } : {}),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`[antigravity-oauth] fetchAvailableModels failed: ${res.status} ${_scrubTokens(text).slice(0, 300)}`);
    }
    const json = await res.json();
    const models = json?.models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) {
        throw new Error('[antigravity-oauth] fetchAvailableModels returned no models');
    }
    return models;
}

function splitDisplay(displayName) {
    const text = String(displayName || '').trim();
    const match = text.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    const effort = match ? TIER_EFFORTS[match[2].trim().toLowerCase()] : undefined;
    return effort ? { base: match[1].trim(), effort } : { base: text, effort: null };
}

function familyId(base) {
    return base.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

function familyKind(base) {
    const text = base.toLowerCase();
    if (/claude/.test(text)) return null;
    if (/gemini/.test(text)) return /flash/.test(text) ? 'gemini-flash' : 'gemini-pro';
    if (/gpt/.test(text)) return 'gpt-oss';
    return null;
}

// Several wire ids can share one label ("Gemini 3.5 Flash Lite" is served by
// four ids): keep the one whose id carries the labelled version, then the
// shortest, so the choice is stable across responses.
function pickWire(candidates, base) {
    const version = base.match(/\d+(?:\.\d+)?/)?.[0];
    const rank = (id) => (version && id.includes(version) ? 0 : 1);
    return [...candidates].sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))[0];
}

function chatEntries(rawModels) {
    const out = [];
    for (const [wireId, entry] of Object.entries(rawModels || {})) {
        if (!entry || typeof entry !== 'object' || INTERNAL_ID.test(wireId)) continue;
        const displayName = String(entry.displayName || '').trim();
        const contextWindow = Number(entry.maxTokens) || 0;
        if (!displayName || contextWindow <= 0) continue;
        out.push({ wireId, entry, displayName, contextWindow });
    }
    return out;
}

/** Collapse the gateway's per-tier wire ids into picker records. */
export function normalizeAntigravityCatalog(rawModels) {
    const families = new Map();
    for (const { wireId, entry, displayName, contextWindow } of chatEntries(rawModels)) {
        const { base, effort } = splitDisplay(displayName);
        const key = familyId(base);
        let family = families.get(key);
        if (!family) {
            family = { base, contextWindow: 0, supportsVision: false, supportsReasoning: false, wires: new Map() };
            families.set(key, family);
        }
        family.contextWindow = Math.max(family.contextWindow, contextWindow);
        family.supportsVision ||= entry.supportsImages === true;
        family.supportsReasoning ||= entry.supportsThinking === true;
        const slot = effort || '';
        if (!family.wires.has(slot)) family.wires.set(slot, []);
        family.wires.get(slot).push(wireId);
    }
    const models = [];
    for (const [key, family] of families) {
        const efforts = EFFORT_ORDER.filter((effort) => family.wires.has(effort));
        const tiered = efforts.length > 1;
        const wire = tiered
            ? Object.fromEntries(efforts.map((effort) => [effort, pickWire(family.wires.get(effort), family.base)]))
            : pickWire(family.wires.get(efforts[0] ?? ''), family.base);
        const id = tiered ? key : wire;
        const bareGemini3 = !tiered && /^gemini-3(?:\.\d+)?-(?:flash|pro)$/.test(wire);
        const display = tiered || !efforts.length ? family.base : `${family.base} (${efforts[0][0].toUpperCase()}${efforts[0].slice(1)})`;
        const kind = familyKind(family.base);
        models.push({
            id,
            name: display,
            display,
            provider: 'antigravity-oauth',
            ...(kind ? { family: kind } : {}),
            contextWindow: family.contextWindow,
            supportsVision: family.supportsVision,
            supportsReasoning: family.supportsReasoning,
            supportsFunctionCalling: true,
            reasoningLevels: tiered ? efforts : (bareGemini3 ? [...BARE_GEMINI3_LEVELS] : []),
            wire,
        });
    }
    return models.sort((a, b) => a.display.localeCompare(b.display));
}

/** Catalog to resolve wire ids against: in-memory mirror, disk cache, then the curated fallback. */
export function antigravityCatalogModels() {
    if (!_mirror) _mirror = antigravityModelCache.loadSync();
    return _mirror || ANTIGRAVITY_MODELS;
}

/**
 * Turn a picker model + effort into the wire id the gateway accepts. Tiered
 * families consume the effort (the id encodes it); a bare Gemini 3 id keeps it
 * for thinkingLevel; every other record drops it because the model has no
 * effort surface. Unknown ids pass through unchanged.
 */
export function resolveAntigravityWireModel(model, effort, models = antigravityCatalogModels()) {
    const id = String(model || '');
    const record = models.find((entry) => entry?.id === id);
    if (!record) return { model: id, effort };
    if (record.wire && typeof record.wire === 'object') {
        const levels = Object.keys(record.wire);
        const wanted = String(effort || '').toLowerCase();
        const level = levels.includes(wanted) ? wanted : (levels.includes('high') ? 'high' : levels[levels.length - 1]);
        return { model: record.wire[level], effort: null };
    }
    const wire = typeof record.wire === 'string' && record.wire ? record.wire : id;
    return { model: wire, effort: record.reasoningLevels?.length ? effort : null };
}

// Sidebar meter labels fit about four characters (5H, 7D, API ...).
function quotaGroupLabel(wireId, displayName) {
    const text = `${wireId} ${displayName}`.toLowerCase();
    return /flash/.test(text) ? 'FLASH' : 'PRO';
}

/** Per-family quota windows from the same response, in the OAuth usage shape. */
export function antigravityQuotaWindows(rawModels) {
    const groups = new Map();
    for (const { wireId, entry, displayName } of chatEntries(rawModels)) {
        const text = `${wireId} ${displayName}`.toLowerCase();
        // Antigravity is the Gemini provider: omit non-Gemini (Claude, GPT) endpoints.
        if (/claude|gpt/.test(text)) continue;
        const info = entry.quotaInfo;
        if (!info || typeof info !== 'object') continue;
        const remaining = Number(info.remainingFraction);
        const resetAt = Date.parse(String(info.resetTime || '')) || 0;
        if (!Number.isFinite(remaining) && !resetAt) continue;
        // A counter that reports only a reset time is exhausted, not unknown.
        const usedPct = Number.isFinite(remaining) ? Math.max(0, Math.min(100, (1 - remaining) * 100)) : 100;
        const label = quotaGroupLabel(wireId, displayName);
        const group = groups.get(label) || { label, usedPct: 0, resetAt: 0 };
        group.usedPct = Math.max(group.usedPct, usedPct);
        group.resetAt = Math.max(group.resetAt, resetAt);
        groups.set(label, group);
    }
    const order = ['FLASH', 'PRO'];
    return order
        .filter((label) => groups.has(label))
        .map((label) => {
            const group = groups.get(label);
            return {
                label: group.label,
                usedPct: Math.round(group.usedPct * 100) / 100,
                ...(group.resetAt ? { resetAt: group.resetAt } : {}),
                source: 'antigravity-models',
            };
        });
}
