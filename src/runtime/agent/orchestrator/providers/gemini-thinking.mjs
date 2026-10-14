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

// Only translate the public option names, not arbitrary effort-to-token ratios.
// Omitting settings preserves the provider's model default. A level is checked
// against the catalog's ladder when one is declared; otherwise the value is sent
// as given (within the wire vocabulary) and the server decides, and an explicit
// thinkingBudget is likewise passed through unvalidated beyond its wire type.
export function geminiThinkingConfig(model, opts = {}, { includeThoughts, provider = 'gemini' } = {}) {
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
    const supported = catalogThinkingLevels(model, provider) ?? LEVELS;
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
    config.thinkingBudget = budget;
  }
  return Object.keys(config).length ? config : undefined;
}
