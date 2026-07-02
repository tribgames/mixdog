/**
 * Anthropic "effort" (extended-thinking budget) request parameter handling.
 */

export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'max']);

export const EFFORT_BETA_HEADER = 'effort-2025-11-24';

export const LEGACY_EFFORT_BUDGET = Object.freeze({
    low: 1024,
    medium: 4096,
    high: 16384,
    max: 32768,
});
const _LOGGED_EFFORT_NORMALIZATION = new Set();
const _LOGGED_UNKNOWN_EFFORT = new Set();

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
    if (m.startsWith('claude-')) return true;
    return false;
}

// @[MODEL LAUNCH]: extend when new Opus models support max effort.
export function modelSupportsMaxEffort(model) {
    const m = normalizeModelId(model);
    if (/^claude-opus-4-(6|7|8)(?:$|[-@])/.test(m)) return true;
    if (/^claude-opus-5-/.test(m)) return true;
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
 * Normalize user/config effort to API levels (low/medium/high/max).
 * Maps legacy xhigh → max (Opus 4.6+) or high; clamps max on non-Opus models.
 */
export function normalizeAnthropicEffortInput(raw, model, logTag = 'anthropic') {
    if (raw === undefined || raw === null || raw === '') return undefined;
    let level = String(raw).trim().toLowerCase();
    if (level === 'extra-high' || level === 'very-high') level = 'xhigh';

    if (level === 'xhigh') {
        const mapped = modelSupportsMaxEffort(model) ? 'max' : 'high';
        logOnce(`xhigh:${mapped}`, () => {
            process.stderr.write(
                `[${logTag}] effort "xhigh" normalized to "${mapped}" (official levels: ${EFFORT_LEVELS.join(', ')})\n`,
            );
        });
        return mapped;
    }

    if (level === 'max' && !modelSupportsMaxEffort(model)) {
        logOnce('max:high', () => {
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
        return;
    }

    if (normalized && LEGACY_EFFORT_BUDGET[normalized]) {
        const budgetTokens = clampThinkingBudgetTokens(LEGACY_EFFORT_BUDGET[normalized], maxTokens);
        if (budgetTokens) {
            body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
        }
        return;
    }

    if (opts.effort && normalized === undefined && !_LOGGED_UNKNOWN_EFFORT.has(opts.effort)) {
        _LOGGED_UNKNOWN_EFFORT.add(opts.effort);
        try {
            process.stderr.write(
                `[${logTag}] unknown effort=${opts.effort} ignored (known legacy: ${Object.keys(LEGACY_EFFORT_BUDGET).join(', ')})\n`,
            );
        } catch { /* ignore */ }
    }
}

export function effortValuesForModel(capabilities, modelId) {
    const effort = capabilities?.effort;
    let levels = [...EFFORT_LEVELS];
    if (!modelSupportsMaxEffort(modelId)) {
        levels = levels.filter((level) => level !== 'max');
    }
    if (!effort) return [];
    if (effort === true) return levels;
    const values = levels.filter(
        (level) => effort?.[level] === true || effort?.[level]?.supported === true,
    );
    if (values.length) return values;
    return effort.supported === true ? levels : [];
}
