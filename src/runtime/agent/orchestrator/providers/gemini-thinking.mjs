const LEVELS = ['minimal', 'low', 'medium', 'high'];

// Only translate the public option names, not arbitrary effort-to-token ratios.
// Omitting settings preserves the provider's model default.
export function geminiThinkingConfig(model, opts = {}, { includeThoughts } = {}) {
    const id = String(model || '').toLowerCase();
    const rawBudget = opts.thinkingBudget ?? opts.thinkingBudgetTokens;
    const hasBudget = rawBudget !== undefined && rawBudget !== null && rawBudget !== '';
    const rawLevel = opts.thinkingLevel ?? (hasBudget ? undefined : opts.effort);
    const level = rawLevel == null ? '' : String(rawLevel).trim().toLowerCase();
    const config = {};
    const thoughts = opts.includeThoughts ?? includeThoughts;
    if (typeof thoughts === 'boolean') config.includeThoughts = thoughts;
    if (level && hasBudget) {
        throw new TypeError('Choose thinkingLevel/effort or thinkingBudget, not both.');
    }
    if (level) {
        if (!/^gemini-3(?:[.-]|$)/.test(id)) {
            throw new TypeError(`${model} uses thinkingBudget instead of thinkingLevel/effort.`);
        }
        let supported = LEVELS;
        if (/^gemini-3(?:\.0)?-pro(?:-|$)/.test(id)) supported = ['low', 'high'];
        else if (/^gemini-3\.1-pro(?:-|$)/.test(id) || /^gemini-3\.[78]-flash(?:-|$)/.test(id)) {
            supported = ['low', 'medium', 'high'];
        } else if (/^gemini-3\.1-flash-lite.*image/.test(id)) supported = ['minimal', 'high'];
        if (!supported.includes(level)) {
            throw new TypeError(`${model} supports thinking levels ${supported.join(', ')}; received ${level}.`);
        }
        config.thinkingLevel = level;
    }
    if (hasBudget) {
        const budget = Number(rawBudget);
        if (!Number.isInteger(budget) || budget < -1) {
            throw new TypeError('thinkingBudget must be -1 (dynamic), 0, or a positive integer.');
        }
        if (/^gemini-2\.5-pro(?:-|$)/.test(id) && budget !== -1 && (budget < 128 || budget > 32768)) {
            throw new TypeError(`${model} requires thinkingBudget -1 or 128..32768.`);
        }
        if (/^gemini-2\.5-flash(?:-|$)/.test(id) && budget > 24576) {
            throw new TypeError(`${model} requires thinkingBudget at most 24576.`);
        }
        if (/^gemini-2\.5-flash-lite(?:-|$)/.test(id) && budget > 0 && budget < 512) {
            throw new TypeError(`${model} requires thinkingBudget -1, 0, or 512..24576.`);
        }
        config.thinkingBudget = budget;
    }
    return Object.keys(config).length ? config : undefined;
}
