/**
 * src/tui/engine/prompt-history.mjs - pure prompt-history derivation.
 *
 * Extracted from engine.mjs unchanged: the newest-first, deduped user-prompt
 * history the engine publishes on state.promptHistoryList. Pure (input items
 * → array); callers decide when/whether to publish so the store's
 * immutable-emit contract is preserved.
 */
export const PROMPT_HISTORY_LIMIT = 50;

export const promptHistoryKey = (value) => String(value || '').trim().replace(/\s+/g, ' ');

export function recomputePromptHistory(sourceItems, limit = PROMPT_HISTORY_LIMIT) {
  const items = Array.isArray(sourceItems) ? sourceItems : [];
  const seen = new Set();
  const history = [];
  for (let i = items.length - 1; i >= 0 && history.length < limit; i -= 1) {
    const item = items[i];
    if (item?.kind !== 'user') continue;
    const text = String(item.text || '').trim();
    const key = promptHistoryKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    history.push(text);
  }
  return history;
}
