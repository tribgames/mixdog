// Anthropic Messages usage reports input EXCLUDING cache read/write. A gateway
// provider whose ledger convention is inclusive input (OpenCode Go, Command
// Code, OpenRouter, DeepSeek — registry inputExcludesCache:false) reports its
// Messages route in that inclusive form, so every wire of one provider counts
// prompt volume the same way.
import { currentUsageContext } from '../../../../shared/llm/usage-context.mjs';

// Usage objects already converted to the inclusive convention; a converted
// object passing through another normalization (nested send) stays as is,
// and one source object always converts to the same object, so an abandoned
// attempt and the error that later carries it stay one record.
const inclusiveUsage = new WeakSet();
const convertedUsage = new WeakMap();

export function toInclusiveUsage(usage) {
  if (!usage || inclusiveUsage.has(usage)) return usage;
  if (convertedUsage.has(usage)) return convertedUsage.get(usage);
  const input = Number(usage.inputTokens) || 0;
  const cached = Number(usage.cachedTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  const inclusiveInput = input + cached + cacheWrite;
  const converted = {
    ...usage,
    inputTokens: inclusiveInput,
    promptTokens: Math.max(Number(usage.promptTokens) || 0, inclusiveInput),
  };
  inclusiveUsage.add(converted);
  convertedUsage.set(usage, converted);
  return converted;
}

export function toInclusiveUsageError(error) {
  if (error && typeof error === 'object') {
    if (error.usage) error.usage = toInclusiveUsage(error.usage);
    if (error.partialUsage) error.partialUsage = toInclusiveUsage(error.partialUsage);
  }
  return error;
}

/**
 * Run one Messages-wire send of an inclusive-input provider: the success
 * usage, a failure's usage/partial usage and every abandoned attempt the
 * inner Anthropic transport notes are all reported inclusive.
 */
export async function withInclusiveUsage(send) {
  const identity = currentUsageContext();
  if (identity) identity.normalizeAbandonedUsage = toInclusiveUsage;
  try {
    const result = await send();
    return result?.usage ? { ...result, usage: toInclusiveUsage(result.usage) } : result;
  } catch (error) {
    throw toInclusiveUsageError(error);
  }
}
