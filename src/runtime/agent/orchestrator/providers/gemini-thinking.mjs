import { getModelMetadataSync } from '../../../shared/llm/model-catalog.mjs';

// The thinkingLevel values the Gemini wire accepts.
const LEVELS = ['minimal', 'low', 'medium', 'high'];

// The thinkingLevel values the catalogs declare for the model (provider live
// roster, then models.dev / LiteLLM rows, resolved by getModelMetadataSync),
// limited to what the Gemini wire accepts. null when no catalog declares a ladder.
function catalogThinkingLevels(model, provider) {
  const bare = String(model || '').replace(/^models\//i, '');
  const effort = getModelMetadataSync(bare, provider)?.reasoningOptions?.find((option) => option?.type === 'effort');
  const declared = (Array.isArray(effort?.values) ? effort.values : [])
    .map((value) => String(value).toLowerCase())
    .filter((value) => LEVELS.includes(value));
  return declared.length ? [...new Set(declared)] : null;
}

// Gemini 2.5 models take thinkingBudget only (thinkingLevel is unsupported).
// Documented ranges: 2.5 Pro 128–32768 (cannot disable), 2.5 Flash 0–24576,
// 2.5 Flash-Lite 0 or 512–24576; -1 is dynamic thinking for all of them.
function budgetSpec(model) {
  const bare = String(model || '')
    .replace(/^models\//i, '')
    .toLowerCase();
  if (!/^gemini-2\.5(?:-|$)/.test(bare)) return null;
  if (/^gemini-2\.5-pro/.test(bare)) {
    return {
      name: 'Gemini 2.5 Pro',
      min: 128,
      max: 32768,
      canDisable: false,
      efforts: { minimal: 128, low: 1024, medium: 8192, high: 32768 },
    };
  }
  if (/^gemini-2\.5-flash-lite/.test(bare)) {
    return {
      name: 'Gemini 2.5 Flash-Lite',
      min: 512,
      max: 24576,
      canDisable: true,
      efforts: { minimal: 512, low: 1024, medium: 8192, high: 24576 },
    };
  }
  return {
    name: 'Gemini 2.5 Flash',
    min: 0,
    max: 24576,
    canDisable: true,
    efforts: { minimal: 0, low: 1024, medium: 8192, high: 24576 },
  };
}

// Levels documented for models whose ladder differs from the generic wire
// vocabulary (a catalog ladder, when declared, still takes precedence).
function documentedThinkingLevels(model) {
  const bare = String(model || '')
    .replace(/^models\//i, '')
    .toLowerCase();
  if (bare === 'gemini-4-argon' || bare === 'gemini-3.8-flash') return ['low', 'medium', 'high'];
  return null;
}

function checkBudget(model, spec, budget) {
  if (!Number.isInteger(budget) || budget < -1) {
    throw new TypeError('thinkingBudget must be -1 (dynamic), 0, or a positive integer.');
  }
  if (!spec || budget === -1) return;
  if (budget === 0 && !spec.canDisable) {
    throw new TypeError(`${model} (${spec.name}) cannot disable thinking; thinkingBudget 0 is not allowed.`);
  }
  if (budget !== 0 && (budget < spec.min || budget > spec.max)) {
    throw new TypeError(
      `${model} (${spec.name}) thinkingBudget must be -1, ${spec.canDisable ? '0, or ' : ''}${spec.min}–${spec.max}; received ${budget}.`
    );
  }
}

// Only translate the public option names. Omitting settings preserves the
// provider's model default. Gemini 2.5 models use thinkingBudget (a generic
// effort maps to a budget; an explicit thinkingLevel is rejected locally and
// budgets are range-checked). Other models use thinkingLevel, checked against
// the catalog/documented ladder; unknown models pass values within the wire
// vocabulary and the server decides.
export function geminiThinkingConfig(model, opts = {}, { includeThoughts, provider = 'gemini' } = {}) {
  const rawBudget = opts.thinkingBudget ?? opts.thinkingBudgetTokens;
  const hasBudget = rawBudget !== undefined && rawBudget !== null && rawBudget !== '';
  const spec = budgetSpec(model);
  const explicitLevel = opts.thinkingLevel == null ? '' : String(opts.thinkingLevel).trim().toLowerCase();
  const rawLevel = opts.thinkingLevel ?? (hasBudget ? undefined : opts.effort);
  const level = rawLevel == null ? '' : String(rawLevel).trim().toLowerCase();
  const config = {};
  const thoughts = opts.includeThoughts ?? includeThoughts;
  if (typeof thoughts === 'boolean') config.includeThoughts = thoughts;
  if (level && hasBudget) {
    throw new TypeError('Choose thinkingLevel/effort or thinkingBudget, not both.');
  }
  if (spec && explicitLevel) {
    throw new TypeError(`${model} (${spec.name}) does not support thinkingLevel; use thinkingBudget.`);
  }
  if (spec && level) {
    if (!Object.hasOwn(spec.efforts, level)) {
      throw new TypeError(
        `${model} supports thinking levels ${Object.keys(spec.efforts).join(', ')}; received ${level}.`
      );
    }
    config.thinkingBudget = spec.efforts[level];
  } else if (level) {
    const supported = catalogThinkingLevels(model, provider) ?? documentedThinkingLevels(model) ?? LEVELS;
    if (!supported.includes(level)) {
      throw new TypeError(`${model} supports thinking levels ${supported.join(', ')}; received ${level}.`);
    }
    config.thinkingLevel = level;
  }
  if (hasBudget) {
    const budget = Number(rawBudget);
    checkBudget(model, spec, budget);
    config.thinkingBudget = budget;
  }
  return Object.keys(config).length ? config : undefined;
}
