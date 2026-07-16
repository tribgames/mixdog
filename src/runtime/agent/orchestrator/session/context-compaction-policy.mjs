import { isAgentOwner } from '../agent-owner.mjs';

export const DEFAULT_COMPACTION_BUFFER_TOKENS = 0;
export const DEFAULT_COMPACTION_BUFFER_RATIO = 0.1;
export const DEFAULT_MAIN_COMPACTION_BUFFER_RATIO = 0.05;
export const MAX_COMPACTION_BUFFER_RATIO = 0.25;
const MAX_BUFFER_INPUT_RATIO = 0.999_999;
export const DEFAULT_COMPACTION_KEEP_TOKENS = 8_000;
const LEGACY_DEFAULT_COMPACTION_BUFFER_RATIO = 0.1;

export function positiveTokenInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
function envTokenInt(name) {
    return positiveTokenInt(process.env[name]);
}
export function normalizeCompactionBufferRatio(value, fallback = DEFAULT_COMPACTION_BUFFER_RATIO) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n > 1 ? n / 100 : n;
    return fallback;
}
export function resolveBufferRatioCandidate(percentInputs = [], ratioInputs = []) {
    for (const raw of percentInputs) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return Math.min(MAX_BUFFER_INPUT_RATIO, n / 100);
    }
    for (const raw of ratioInputs) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return Math.min(MAX_BUFFER_INPUT_RATIO, n > 1 ? n / 100 : n);
    }
    return null;
}
export function resolveCompactBufferRatio(cfg = {}) {
    const resolved = resolveBufferRatioCandidate(
        [cfg.bufferPercent, cfg.bufferPct, process.env.MIXDOG_AGENT_COMPACT_BUFFER_PERCENT],
        [cfg.bufferRatio, cfg.bufferFraction, process.env.MIXDOG_AGENT_COMPACT_BUFFER_RATIO],
    );
    return normalizeCompactionBufferRatio(resolved, DEFAULT_COMPACTION_BUFFER_RATIO);
}
function positiveTokenCandidate(values = []) {
    for (const value of values) {
        const tokens = positiveTokenInt(value);
        if (tokens) return tokens;
    }
    return null;
}
function resolveMainBufferSetting(cfg = {}) {
    const configTokens = positiveTokenCandidate([cfg.mainBufferTokens, cfg.mainBuffer]);
    if (configTokens) return { tokens: configTokens };
    const configRatio = resolveBufferRatioCandidate(
        [cfg.mainBufferPercent, cfg.mainBufferPct],
        [cfg.mainBufferRatio, cfg.mainBufferFraction],
    );
    if (configRatio !== null) return { ratio: configRatio };
    const envTokens = positiveTokenCandidate([process.env.MIXDOG_MAIN_COMPACT_BUFFER_TOKENS]);
    if (envTokens) return { tokens: envTokens };
    const envRatio = resolveBufferRatioCandidate(
        [process.env.MIXDOG_MAIN_COMPACT_BUFFER_PERCENT],
        [process.env.MIXDOG_MAIN_COMPACT_BUFFER_RATIO],
    );
    return envRatio === null ? null : { ratio: envRatio };
}
export function resolveMainCompactBufferRatio(cfg = {}) {
    const setting = resolveMainBufferSetting(cfg);
    return setting?.ratio ?? DEFAULT_MAIN_COMPACTION_BUFFER_RATIO;
}
export function compactionBufferTokensForBoundary(boundaryTokens, opts = {}) {
    const boundary = Math.max(0, Math.floor(Number(boundaryTokens) || 0));
    const explicit = Math.max(0, Math.floor(Number(opts.explicitTokens) || 0));
    if (!boundary) return explicit;
    const maxRatio = normalizeCompactionBufferRatio(opts.maxRatio, MAX_COMPACTION_BUFFER_RATIO);
    const cap = Math.max(0, Math.floor(boundary * maxRatio));
    if (explicit > 0) return Math.max(0, Math.min(explicit, cap));
    const ratio = normalizeCompactionBufferRatio(opts.ratio, DEFAULT_COMPACTION_BUFFER_RATIO);
    return Math.max(0, Math.min(Math.floor(boundary * ratio), cap));
}
export function isPersistedZeroBufferTelemetry(cfg = {}, boundaryTokens = 0) {
    const boundary = positiveTokenInt(boundaryTokens);
    if (!boundary) return false;
    if (envTokenInt('MIXDOG_AGENT_COMPACT_BUFFER_TOKENS')) return false;
    for (const envName of ['MIXDOG_AGENT_COMPACT_BUFFER_PERCENT', 'MIXDOG_AGENT_COMPACT_BUFFER_RATIO']) {
        const n = Number(process.env[envName]);
        if (Number.isFinite(n) && n > 0) return false;
    }
    for (const key of ['bufferPercent', 'bufferPct', 'bufferFraction']) {
        const n = Number(cfg?.[key]);
        if (Number.isFinite(n) && n > 0) return false;
    }
    const ratio = Number(cfg?.bufferRatio);
    if (Number.isFinite(ratio) && ratio > 0) return false;
    const explicitTokens = Number(cfg?.bufferTokens ?? cfg?.buffer);
    return Number.isFinite(explicitTokens) && explicitTokens === 0;
}
export function isLegacyDefaultBufferTelemetry(cfg = {}, boundaryTokens = 0) {
    const boundary = positiveTokenInt(boundaryTokens);
    if (!boundary) return false;
    if (envTokenInt('MIXDOG_AGENT_COMPACT_BUFFER_TOKENS')) return false;
    for (const envName of ['MIXDOG_AGENT_COMPACT_BUFFER_PERCENT', 'MIXDOG_AGENT_COMPACT_BUFFER_RATIO']) {
        const n = Number(process.env[envName]);
        if (Number.isFinite(n) && n > 0) return false;
    }
    for (const key of ['bufferPercent', 'bufferPct', 'bufferFraction']) {
        const n = Number(cfg?.[key]);
        if (Number.isFinite(n) && n > 0) return false;
    }
    const explicitTokens = positiveTokenInt(cfg?.bufferTokens ?? cfg?.buffer);
    const ratio = Number(cfg?.bufferRatio);
    if (!explicitTokens || !Number.isFinite(ratio) || Math.abs(ratio - LEGACY_DEFAULT_COMPACTION_BUFFER_RATIO) > 1e-9) return false;
    const expectedTokens = Math.floor(boundary * LEGACY_DEFAULT_COMPACTION_BUFFER_RATIO);
    const cfgBoundary = positiveTokenInt(cfg?.boundaryTokens);
    const cfgTrigger = positiveTokenInt(cfg?.triggerTokens);
    return explicitTokens === expectedTokens
        || (cfgBoundary === boundary && cfgTrigger > 0 && explicitTokens === Math.max(0, boundary - cfgTrigger));
}
export function compactBufferConfigForBoundary(cfg = {}, boundaryTokens = 0) {
    const base = cfg || {};
    if (!isLegacyDefaultBufferTelemetry(base, boundaryTokens)
        && !isPersistedZeroBufferTelemetry(base, boundaryTokens)) return base;
    return { ...base, bufferTokens: null, buffer: null, bufferRatio: null };
}
export function resolveCompactBufferTokens(boundaryTokens, cfg = {}, opts = {}) {
    const boundary = positiveTokenInt(boundaryTokens);
    const effectiveCfg = compactBufferConfigForBoundary(cfg, boundary);
    const configured = positiveTokenInt(effectiveCfg.bufferTokens ?? effectiveCfg.buffer)
        || envTokenInt('MIXDOG_AGENT_COMPACT_BUFFER_TOKENS') || 0;
    if (!boundary) return configured || positiveTokenInt(opts.defaultTokens) || DEFAULT_COMPACTION_BUFFER_TOKENS;
    return compactionBufferTokensForBoundary(boundary, {
        explicitTokens: configured,
        ratio: resolveCompactBufferRatio(effectiveCfg),
        maxRatio: opts.maxRatio ?? MAX_COMPACTION_BUFFER_RATIO,
    });
}
export function resolveMainCompactBufferTokens(boundaryTokens, cfg = {}, opts = {}) {
    const boundary = positiveTokenInt(boundaryTokens);
    const setting = resolveMainBufferSetting(cfg);
    const configured = setting?.tokens || 0;
    if (!boundary) return configured || positiveTokenInt(opts.defaultTokens) || DEFAULT_COMPACTION_BUFFER_TOKENS;
    return compactionBufferTokensForBoundary(boundary, {
        explicitTokens: configured,
        ratio: setting?.ratio ?? DEFAULT_MAIN_COMPACTION_BUFFER_RATIO,
        maxRatio: opts.maxRatio ?? MAX_COMPACTION_BUFFER_RATIO,
    });
}
export function resolveCompactTriggerTokens(sessionOrConfig = {}, boundaryTokens = 0) {
    return resolveSessionCompactPolicy(sessionOrConfig, boundaryTokens).triggerTokens;
}
export function resolveSessionCompactPolicy(sessionOrConfig = {}, boundaryTokens = 0) {
    const cfg = sessionOrConfig?.compaction || sessionOrConfig || {};
    const boundary = positiveTokenInt(boundaryTokens);
    if (!boundary) {
        return {
            autoCompactTokenLimit: null,
            triggerTokens: null,
            bufferTokens: 0,
            bufferRatio: isAgentOwner(sessionOrConfig)
                ? resolveCompactBufferRatio(cfg)
                : resolveMainCompactBufferRatio(cfg),
        };
    }
    const rawLimit = positiveTokenInt(sessionOrConfig?.autoCompactTokenLimit ?? cfg?.autoCompactTokenLimit);
    const explicitLimit = rawLimit && rawLimit < boundary ? rawLimit : null;
    let triggerTokens;
    if (explicitLimit) triggerTokens = explicitLimit;
    else if (isAgentOwner(sessionOrConfig)) triggerTokens = Math.max(1, boundary - resolveCompactBufferTokens(boundary, cfg));
    else triggerTokens = Math.max(1, boundary - resolveMainCompactBufferTokens(boundary, cfg));
    const bufferTokens = Math.max(0, boundary - triggerTokens);
    const bufferRatio = bufferTokens / boundary;
    return { autoCompactTokenLimit: explicitLimit, triggerTokens, bufferTokens, bufferRatio };
}
