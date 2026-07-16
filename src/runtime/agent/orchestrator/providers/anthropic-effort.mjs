/**
 * Anthropic "effort" (extended-thinking budget) request parameter handling.
 */

export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// Canonical display/transport ordering for effort levels. Used only to sort
// whatever set the catalog actually advertises — NOT as an allowlist. The
// catalog (capabilities.effort) is the source of truth for which levels a
// model exposes; this array just keeps them in a stable low→max order.
const EFFORT_LEVEL_ORDER = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
function _sortEffortLevels(levels) {
    const rank = (l) => {
        const i = EFFORT_LEVEL_ORDER.indexOf(l);
        return i === -1 ? EFFORT_LEVEL_ORDER.length : i;
    };
    return [...levels].sort((a, b) => rank(a) - rank(b));
}

export const EFFORT_BETA_HEADER = 'effort-2025-11-24';

export const LEGACY_EFFORT_BUDGET = Object.freeze({
    low: 1024,
    medium: 4096,
    high: 16384,
    xhigh: 32768,
    max: 32768,
});
const _LOGGED_EFFORT_NORMALIZATION = new Set();
const _LOGGED_UNKNOWN_EFFORT = new Set();
const MAX_LOGGED_UNKNOWN_EFFORTS = 100;

function normalizeModelId(model) {
    return String(model || '').toLowerCase().replace(/\./g, '-');
}

function parseClaudeVersion(model) {
    const m = normalizeModelId(model);
    const triple = m.match(/^claude-(haiku|sonnet|opus|fable)-(\d+)-(\d+)/);
    if (triple) {
        return { family: triple[1], major: Number(triple[2]), minor: Number(triple[3]) };
    }
    const pair = m.match(/^claude-(sonnet|fable)-(\d+)(?:$|[-@])/);
    if (pair) {
        return { family: pair[1], major: Number(pair[2]), minor: null };
    }
    // Legacy naming: version comes BEFORE the family (claude-3-7-sonnet,
    // claude-3-5-sonnet, claude-3-opus). These are manual-thinking models —
    // parse them so isLegacyAnthropicReasoningModel excludes them instead of
    // letting modelSupportsEffort's `startsWith('claude-')` fallthrough grant
    // them adaptive thinking + the effort beta (a hard 400).
    const legacy = m.match(/^claude-(\d+)-(\d+)-(haiku|sonnet|opus)/);
    if (legacy) {
        return { family: legacy[3], major: Number(legacy[1]), minor: Number(legacy[2]) };
    }
    return null;
}

function isLegacyAnthropicReasoningModel(model) {
    const parsed = parseClaudeVersion(model);
    if (!parsed) return false;
    if (parsed.family === 'haiku') return true;
    if (parsed.family === 'fable') return false;
    if (parsed.family === 'sonnet' || parsed.family === 'opus') {
        if (parsed.major < 4) return true;
        if (parsed.major === 4 && parsed.minor !== null && parsed.minor < 6) return true;
        return false;
    }
    return false;
}

// @[MODEL LAUNCH]: extend allowlist when new Claude models ship with effort support.
export function modelSupportsEffort(model) {
    if (isEnvTruthy(process.env.MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT)) return true;
    const m = normalizeModelId(model);
    if (!m.includes('claude')) return false;
    if (isLegacyAnthropicReasoningModel(model)) return false;
    if (m.includes('opus-4-6') || m.includes('sonnet-4-6')) return true;
    if (m.includes('sonnet-5') || m.includes('fable-5')) return true;
    if (/^claude-opus-4-(6|7|8)(?:$|[-@])/.test(m)) return true;
    if (/^claude-opus-5-/.test(m)) return true;
    // Fallthrough for not-yet-enumerated modern models: only grant effort when
    // parseClaudeVersion resolves a family with major>=4 (and not a manual-
    // thinking legacy already excluded above). A bare `startsWith('claude-')`
    // here would hand thinking:adaptive + the effort beta to legacy/unknown
    // IDs (e.g. claude-3-7-sonnet) → hard 400. Unknown-shape IDs (no version
    // parsed) fall through to false: no effort, no adaptive thinking.
    const parsed = parseClaudeVersion(model);
    if (parsed && (parsed.family === 'sonnet' || parsed.family === 'opus' || parsed.family === 'fable')
        && parsed.major >= 4) {
        return true;
    }
    return false;
}

// @[MODEL LAUNCH]: extend when new models support xhigh effort.
// Per platform.claude.com/docs/en/build-with-claude/effort — xhigh is
// supported by: Fable 5, Mythos 5, Opus 4.8, Opus 4.7, Sonnet 5.
// NOT Opus 4.6 / Sonnet 4.6 (those support max but not xhigh).
export function modelSupportsXhighEffort(model) {
    const m = normalizeModelId(model);
    if (/^claude-opus-4-(7|8)(?:$|[-@])/.test(m)) return true;
    if (/^claude-opus-5(?:$|[-@])/.test(m)) return true;
    if (/^claude-sonnet-5(?:$|[-@])/.test(m)) return true;
    if (/^claude-fable-5(?:$|[-@])/.test(m)) return true;
    if (/^claude-mythos-5(?:$|[-@])/.test(m)) return true;
    if (/^claude-mythos-preview(?:$|[-@])/.test(m)) return true;
    return false;
}

// @[MODEL LAUNCH]: extend when new Opus models support max effort.
// Max list = xhigh list PLUS Opus 4.6, Sonnet 4.6, Opus 4.5.
export function modelSupportsMaxEffort(model) {
    if (modelSupportsXhighEffort(model)) return true;
    const m = normalizeModelId(model);
    if (/^claude-opus-4-(5|6)(?:$|[-@])/.test(m)) return true;
    if (/^claude-sonnet-4-6(?:$|[-@])/.test(m)) return true;
    return false;
}

function isEnvTruthy(value) {
    const s = String(value ?? '').trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function logOnce(key, write) {
    if (_LOGGED_EFFORT_NORMALIZATION.has(key)) return;
    _LOGGED_EFFORT_NORMALIZATION.add(key);
    try { write(); } catch { /* ignore */ }
}

/**
 * Normalize user/config effort to API levels (low/medium/high/xhigh/max).
 * Accepts extra-high / very-high aliases as xhigh; clamps xhigh/max down to
 * high on models that don't support the top Opus tiers.
 */
export function normalizeAnthropicEffortInput(raw, model, logTag = 'anthropic') {
    if (raw === undefined || raw === null || raw === '') return undefined;
    let level = String(raw).trim().toLowerCase();
    if (level === 'extra-high' || level === 'very-high') level = 'xhigh';

    if (level === 'xhigh' && !modelSupportsXhighEffort(model)) {
        logOnce(`xhigh:high`, () => {
            process.stderr.write(`[${logTag}] effort "xhigh" downgraded to "high" for model ${model}\n`);
        });
        return 'high';
    }

    if (level === 'max' && !modelSupportsMaxEffort(model)) {
        logOnce(`max:high`, () => {
            process.stderr.write(`[${logTag}] effort "max" downgraded to "high" for model ${model}\n`);
        });
        return 'high';
    }

    if (EFFORT_LEVELS.includes(level)) return level;
    return undefined;
}

export function anthropicEffortUsesOutputConfig(model, opts = {}) {
    const thinkingBudgetTokens = Number(opts.thinkingBudgetTokens);
    if (Number.isFinite(thinkingBudgetTokens) && thinkingBudgetTokens > 0) return false;
    return modelSupportsEffort(model);
}

export function shouldIncludeEffortBeta(model, opts = {}) {
    return anthropicEffortUsesOutputConfig(model, opts);
}

/**
 * Apply effort / thinking to a Messages API body or SDK params object (mutates).
 */
export function applyAnthropicEffortToBody(
    body,
    {
        model,
        opts = {},
        maxTokens,
        clampThinkingBudgetTokens,
        logTag = 'anthropic',
    },
) {
    if (!body || typeof body !== 'object') return;

    const thinkingBudgetTokens = Number(opts.thinkingBudgetTokens);
    if (Number.isFinite(thinkingBudgetTokens) && thinkingBudgetTokens > 0) {
        const budgetTokens = clampThinkingBudgetTokens(thinkingBudgetTokens, maxTokens);
        if (budgetTokens) {
            body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
        }
        return;
    }

    const normalized = normalizeAnthropicEffortInput(opts.effort, model, logTag);

    if (modelSupportsEffort(model)) {
        if (normalized) {
            const existing = body.output_config && typeof body.output_config === 'object'
                ? body.output_config
                : {};
            body.output_config = { ...existing, effort: normalized };
        }
        // Adaptive-thinking models (4.6+) require `thinking:{type:"adaptive"}`
        // rather than the legacy budget_tokens shape — sending
        // `thinking:{type:"enabled"}` here 400s on sonnet-5/opus-4-7/4-8.
        // display:"summarized" keeps reasoning blocks populated (4.7+ defaults
        // to "omitted", silently hiding reasoning text). Gated on the same
        // modelSupportsEffort() allowlist so older models never receive it.
        // Set unconditionally (independent of `normalized`) so effort-capable
        // turns always carry adaptive thinking + round-trip signatures.
        body.thinking = { type: 'adaptive', display: 'summarized' };
        // Adaptive/4.7+ models reject any non-default sampling param with a 400.
        delete body.temperature;
        delete body.top_p;
        delete body.top_k;
        return;
    }

    if (normalized && LEGACY_EFFORT_BUDGET[normalized]) {
        const budgetTokens = clampThinkingBudgetTokens(LEGACY_EFFORT_BUDGET[normalized], maxTokens);
        if (budgetTokens) {
            body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
        }
        return;
    }

    const unknownEffort = String(opts.effort ?? '');
    if (opts.effort && normalized === undefined && !_LOGGED_UNKNOWN_EFFORT.has(unknownEffort)) {
        if (_LOGGED_UNKNOWN_EFFORT.size >= MAX_LOGGED_UNKNOWN_EFFORTS) {
            _LOGGED_UNKNOWN_EFFORT.delete(_LOGGED_UNKNOWN_EFFORT.values().next().value);
        }
        _LOGGED_UNKNOWN_EFFORT.add(unknownEffort);
        try {
            process.stderr.write(
                `[${logTag}] unknown effort=${opts.effort} ignored (known legacy: ${Object.keys(LEGACY_EFFORT_BUDGET).join(', ')})\n`,
            );
        } catch { /* ignore */ }
    }
}

export function effortValuesForModel(capabilities, modelId) {
    const effort = capabilities?.effort;
    if (!effort) return [];
    // Catalog-first: when capabilities.effort enumerates per-level support,
    // that map is the source of truth — expose exactly the levels the model
    // advertises (xhigh, max, or anything future), no hardcoded allowlist.
    if (effort !== true && typeof effort === 'object') {
        const advertised = Object.keys(effort).filter(
            (level) => effort[level] === true || effort[level]?.supported === true,
        );
        if (advertised.length) return _sortEffortLevels(advertised);
        // Object with no per-level flags: fall through to the boolean/supported
        // fallback below only when it explicitly marks blanket support.
        if (effort.supported !== true) return [];
    }
    // Fallback (effort === true, or {supported:true} with no per-level map):
    // the model supports effort but doesn't enumerate levels, so derive the
    // set from the known level ladder, gated by the top-tier model check.
    let levels = [...EFFORT_LEVELS];
    if (!modelSupportsMaxEffort(modelId)) {
        levels = levels.filter((level) => level !== 'max');
    }
    if (!modelSupportsXhighEffort(modelId)) {
        levels = levels.filter((level) => level !== 'xhigh');
    }
    return levels;
}
